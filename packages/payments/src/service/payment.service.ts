import { randomUUID } from 'node:crypto';
import type { Prisma } from '@hitbox/database';
import type { PaymentTransaction } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_AUDIT_EVENTS,
    PAYMENTS_ERROR_CODES,
    PAYMENT_EVENTS,
} from '../constants/payments.constant';
import type { PaymentAccess } from '../domain/payment-access';
import { PaymentScope, requireManage } from '../domain/payment-access';
import type { IPaymentsAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type { IFinancePostings } from '../domain/interfaces/finance-postings.interface';
import type { IOrderLedger } from '../domain/interfaces/order-ledger.interface';
import type {
    ListPaymentsQuery,
    PaymentTransactionView,
    ReviewPaymentDto,
} from '../dto/payments.dto';
import type { PaymentRepository } from '../repository/payment.repository';

export interface PaymentServiceDeps {
    payments: PaymentRepository;
    orders: IOrderLedger;
    finance: IFinancePostings;
    eventBus: IEventBus;
    audit: IPaymentsAuditRecorder;
    logger: Logger;
}

/** Settlement, failure and the manual review queue. */
export class PaymentService {
    constructor(private readonly deps: PaymentServiceDeps) { }

    // ── Settlement (called by the webhook, never by a client) ───────────────

    /**
     * The charge succeeded.
     *
     * Four things happen, in this order, and the order matters:
     *
     *   1. the transaction moves PENDING/INITIATED → SUCCEEDED, guarded, so a
     *      redelivered webhook stops right here;
     *   2. the order is marked PAID and its stock hold committed;
     *   3. revenue is booked in the finance ledger, keyed on the transaction;
     *   4. the audit trail records it.
     *
     * Step 1 being the guard is what makes the other three safe to repeat: if
     * the transition matched zero rows, this delivery has already been
     * processed and nothing else runs.
     *
     * Note what does **not** happen here: no royalty is accrued. The buyer has
     * paid, but nobody has received anything yet — that comes at the claim.
     */
    async settle(input: {
        transaction: PaymentTransaction;
        gatewayRef: string | null;
        gatewayFee?: string | null;
        settledAt: Date;
        correlationId: string;
    }): Promise<{ settled: boolean }> {
        // The guard is in the WHERE clause, not in an `if` above it: two
        // deliveries arriving at once would both pass a read-then-write check
        // and both post revenue. Only one of them can match this update.
        const changed = await this.deps.payments.transition({
            id: input.transaction.id,
            from: { in: ['INITIATED', 'PENDING', 'NEEDS_REVIEW'] },
            data: {
                status: 'SUCCEEDED',
                settledAt: input.settledAt,
                ...(input.gatewayRef ? { gatewayRef: input.gatewayRef } : {}),
            },
        });
        if (changed === 0) {
            this.deps.logger.info(
                { transactionId: input.transaction.id },
                'payment already settled — webhook redelivery ignored',
            );
            return { settled: false };
        }

        const marked = await this.deps.orders.markPaid({
            orderId: input.transaction.orderId,
            settledAt: input.settledAt,
        });
        if (!marked) {
            // The order could not be settled — most often because its stock
            // hold expired and the unit went to someone else. That is a real
            // operational problem (money taken, nothing to ship), so the
            // transaction is parked for a human rather than silently left.
            await this.deps.payments.transition({
                id: input.transaction.id,
                from: 'SUCCEEDED',
                data: {
                    needsReview: true,
                    failureReason:
                        'Payment settled but the order could not be marked paid — the stock hold may have expired.',
                },
            });
            this.deps.logger.error(
                { transactionId: input.transaction.id, orderId: input.transaction.orderId },
                'payment settled but order could not be marked paid — parked for review',
            );
        }

        await this.deps.finance.postSaleRevenue({
            orderId: input.transaction.orderId,
            paymentTransactionId: input.transaction.id,
            amount: input.transaction.amount.toFixed(2),
            currency: input.transaction.currency,
            gatewayFee: input.gatewayFee ?? null,
            description: 'Sale settled',
        });

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.PAYMENT_SETTLE,
            actor: { type: 'SYSTEM', id: null },
            result: marked ? 'SUCCESS' : 'FAILURE',
            resource: { type: 'PaymentTransaction', id: input.transaction.id },
            beforeState: { status: input.transaction.status },
            afterState: {
                status: 'SUCCEEDED',
                orderId: input.transaction.orderId,
                amount: input.transaction.amount.toFixed(2),
                currency: input.transaction.currency,
                orderMarkedPaid: marked,
            },
            correlationId: input.correlationId,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.PAYMENT_SUCCEEDED, {
            orderId: input.transaction.orderId,
            paymentTransactionId: input.transaction.id,
            amount: input.transaction.amount.toFixed(2),
            currency: input.transaction.currency,
        });

        return { settled: true };
    }

    /** The charge failed: the order is cancelled and the unit released. */
    async fail(input: {
        transaction: PaymentTransaction;
        reason: string;
        correlationId: string;
    }): Promise<{ failed: boolean }> {
        if (input.transaction.status === 'FAILED') return { failed: false };

        const changed = await this.deps.payments.transition({
            id: input.transaction.id,
            from: input.transaction.status,
            data: { status: 'FAILED', failureReason: input.reason.slice(0, 500) },
        });
        if (changed === 0) return { failed: false };

        await this.deps.orders.markFailed({
            orderId: input.transaction.orderId,
            reason: input.reason,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.PAYMENT_FAILED, {
            orderId: input.transaction.orderId,
            paymentTransactionId: input.transaction.id,
            reason: input.reason,
        });
        this.deps.logger.info(
            { transactionId: input.transaction.id, reason: input.reason },
            'payment failed',
        );
        return { failed: true };
    }

    // ── Admin surface ───────────────────────────────────────────────────────

    async list(
        query: ListPaymentsQuery,
        access: PaymentAccess,
    ): Promise<{ page: number; limit: number; total: number; items: PaymentTransactionView[] }> {
        const { total, items } = await this.deps.payments.list({
            ...query,
            scopeFilter: this.scopeFilter(access),
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => this.toView(row)),
        };
    }

    async getById(id: string, access: PaymentAccess): Promise<PaymentTransactionView> {
        return this.toView(await this.requireInScope(id, access));
    }

    /**
     * Clears a parked transaction.
     *
     * NEEDS_REVIEW exists so a transaction with something wrong about it — a
     * settled payment whose order could not be fulfilled, a mismatched amount —
     * stops rather than failing. Clearing it is a decision with a name on it,
     * which is why the note is required and the record is CRITICAL.
     */
    async review(
        id: string,
        dto: ReviewPaymentDto,
        access: PaymentAccess,
    ): Promise<PaymentTransactionView> {
        requireManage(access, 'review payment transactions');
        const transaction = await this.requireInScope(id, access);

        if (!transaction.needsReview) {
            throw AppError.conflict(
                'This transaction is not awaiting review.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const now = new Date();
        const changed = await this.deps.payments.transition({
            id,
            from: transaction.status,
            data: {
                needsReview: false,
                reviewedById: access.userId,
                reviewedAt: now,
                reviewNote: dto.note,
                ...(dto.decision === 'REJECT' ? { status: 'FAILED' as const } : {}),
            },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This transaction changed while you were reviewing it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        if (dto.decision === 'REJECT') {
            await this.deps.orders.markFailed({
                orderId: transaction.orderId,
                reason: `Payment review rejected: ${dto.note}`,
            });
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.PAYMENT_SETTLE,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'PaymentTransaction', id },
            beforeState: { status: transaction.status, needsReview: true },
            afterState: { decision: dto.decision, note: dto.note },
            correlationId: randomUUID(),
        });

        return this.getById(id, access);
    }

    /** The settled charge a refund would reverse. */
    findSettledForOrder(orderId: string): Promise<PaymentTransaction | null> {
        return this.deps.payments.findSettledForOrder(orderId);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private scopeFilter(access: PaymentAccess): Prisma.PaymentTransactionWhereInput {
        if (access.scope === PaymentScope.GLOBAL) return {};
        if (access.scope === PaymentScope.ORGANIZATION) {
            return { order: { organizationId: { in: access.organizationIds ?? [] } } };
        }
        // A buyer reading their own payments. Not an operator surface, but the
        // filter has to be correct rather than absent.
        return { order: { buyerId: access.userId } };
    }

    private async requireInScope(
        id: string,
        access: PaymentAccess,
    ): Promise<PaymentTransaction> {
        const { items } = await this.deps.payments.list({
            page: 1,
            limit: 1,
            scopeFilter: { AND: [this.scopeFilter(access), { id }] },
            skip: 0,
            take: 1,
        });
        const transaction = items[0];
        if (!transaction) {
            throw AppError.notFound(
                'Payment transaction not found.',
                PAYMENTS_ERROR_CODES.NOT_FOUND,
            );
        }
        return transaction;
    }

    private toView(row: PaymentTransaction): PaymentTransactionView {
        return {
            id: row.id,
            orderId: row.orderId,
            gateway: row.gateway,
            gatewayRef: row.gatewayRef,
            status: row.status,
            amount: row.amount.toFixed(2),
            currency: row.currency,
            needsReview: row.needsReview,
            reviewedById: row.reviewedById,
            reviewedAt: row.reviewedAt?.toISOString() ?? null,
            reviewNote: row.reviewNote,
            failureReason: row.failureReason,
            settledAt: row.settledAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        };
    }
}

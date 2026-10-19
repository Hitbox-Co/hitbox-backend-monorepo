import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { DisputeCase } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_AUDIT_EVENTS,
    PAYMENTS_ERROR_CODES,
    PAYMENT_EVENTS,
} from '../constants/payments.constant';
import type { IPaymentsAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type {
    IFinancePostings,
    IRoyaltyReversal,
} from '../domain/interfaces/finance-postings.interface';
import type { IOrderLedger } from '../domain/interfaces/order-ledger.interface';
import type { PaymentAccess } from '../domain/payment-access';
import { PaymentScope, requireManage } from '../domain/payment-access';
import type {
    DisputeView,
    ListDisputesQuery,
    OpenDisputeDto,
    ResolveDisputeDto,
    SubmitEvidenceDto,
} from '../dto/payments.dto';
import type { DisputeRepository } from '../repository/dispute.repository';
import type { PaymentRepository } from '../repository/payment.repository';

export interface DisputeServiceDeps {
    disputes: DisputeRepository;
    payments: PaymentRepository;
    orders: IOrderLedger;
    finance: IFinancePostings;
    royalties: IRoyaltyReversal;
    eventBus: IEventBus;
    audit: IPaymentsAuditRecorder;
    logger: Logger;
}

/**
 * Chargebacks.
 *
 * A dispute is not a refund, and the difference is worth stating because the
 * two are often collapsed: a refund is something HitBox decides to do, a
 * dispute is something a card network does to HitBox. It arrives unannounced,
 * it has a deadline that defaults to a loss if missed, and losing it costs the
 * sale *plus* a fee — which is why `evidenceDueBy` is a column, why the queue
 * sorts by it, and why a loss posts two ledger lines rather than one.
 *
 * Only a lost or accepted dispute reverses the royalty. A dispute that is
 * merely *open* must not: the artist has not been overpaid yet, and reversing
 * on the accusation would mean un-reversing every time HitBox wins.
 */
export class DisputeService {
    constructor(private readonly deps: DisputeServiceDeps) { }

    // ── Opening ─────────────────────────────────────────────────────────────

    async open(
        dto: OpenDisputeDto,
        access: PaymentAccess,
    ): Promise<DisputeView> {
        requireManage(access, 'open a dispute case');

        const order = await this.deps.orders.findOrderSummary(dto.orderId);
        if (!order) {
            throw AppError.notFound('Order not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }

        const now = new Date();
        const { dispute, created } = await this.deps.disputes.createOrGet({
            id: randomUUID(),
            orderId: dto.orderId,
            paymentTransactionId: dto.paymentTransactionId ?? null,
            gateway: dto.gateway,
            gatewayCaseRef: dto.gatewayCaseRef ?? null,
            reasonCode: dto.reasonCode,
            reason: dto.reason ?? null,
            status: 'OPEN',
            amount: new Prisma.Decimal(dto.amount),
            currency: dto.currency,
            feeAmount: dto.feeAmount ? new Prisma.Decimal(dto.feeAmount) : null,
            evidenceDueBy: dto.evidenceDueBy ?? null,
            openedAt: now,
            createdAt: now,
            updatedAt: now,
        });

        if (created) {
            await this.recordOpened(dispute, access.userId, randomUUID());
        }
        return this.toView(dispute);
    }

    /** The same thing, arriving as a webhook rather than from a person. */
    async openFromGateway(input: {
        object: Record<string, unknown>;
        correlationId: string;
    }): Promise<void> {
        const caseRef = typeof input.object['id'] === 'string' ? input.object['id'] : null;
        const chargeRef =
            typeof input.object['charge'] === 'string' ? input.object['charge'] : null;
        if (!caseRef || !chargeRef) {
            this.deps.logger.warn(
                { caseRef, chargeRef },
                'dispute webhook without a case or charge reference — ignored',
            );
            return;
        }

        const transaction = await this.deps.payments.findByGatewayRef(chargeRef);
        if (!transaction) {
            this.deps.logger.warn(
                { chargeRef },
                'dispute webhook referenced a charge this platform does not know',
            );
            return;
        }

        const amountMinor = input.object['amount'];
        const amount =
            typeof amountMinor === 'number'
                ? new Prisma.Decimal(amountMinor).dividedBy(100)
                : transaction.amount;
        const dueBy = input.object['evidence_details'];
        const evidenceDueBy =
            typeof dueBy === 'object' && dueBy !== null &&
                typeof (dueBy as Record<string, unknown>)['due_by'] === 'number'
                ? new Date(((dueBy as Record<string, number>)['due_by'] as number) * 1000)
                : null;

        const now = new Date();
        const { dispute, created } = await this.deps.disputes.createOrGet({
            id: randomUUID(),
            orderId: transaction.orderId,
            paymentTransactionId: transaction.id,
            gateway: transaction.gateway,
            gatewayCaseRef: caseRef,
            reasonCode: this.mapReason(input.object['reason']),
            reason: typeof input.object['reason'] === 'string' ? input.object['reason'] : null,
            status: 'OPEN',
            amount,
            currency: transaction.currency,
            evidenceDueBy,
            openedAt: now,
            createdAt: now,
            updatedAt: now,
        });

        if (created) {
            await this.recordOpened(dispute, null, input.correlationId);
        }
    }

    // ── Evidence ────────────────────────────────────────────────────────────

    async submitEvidence(
        id: string,
        dto: SubmitEvidenceDto,
        access: PaymentAccess,
    ): Promise<DisputeView> {
        requireManage(access, 'submit dispute evidence');
        const dispute = await this.requireInScope(id, access);

        if (!['OPEN', 'UNDER_REVIEW', 'EVIDENCE_SUBMITTED'].includes(dispute.status)) {
            throw AppError.conflict(
                `A dispute that is ${dispute.status} is closed to evidence.`,
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const now = new Date();
        const changed = await this.deps.disputes.transition({
            id,
            from: dispute.status,
            data: {
                status: 'EVIDENCE_SUBMITTED',
                evidence: dto.evidence as Prisma.InputJsonValue,
                evidenceSubmittedAt: now,
            },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This dispute changed while you were updating it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.DISPUTE_RESOLVE,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'DisputeCase', id },
            beforeState: { status: dispute.status },
            afterState: { status: 'EVIDENCE_SUBMITTED', note: dto.note ?? null },
            correlationId: randomUUID(),
        });

        return this.getById(id, access);
    }

    // ── Resolution ──────────────────────────────────────────────────────────

    /**
     * The network decided (or HitBox accepted the loss).
     *
     * A LOST or ACCEPTED outcome does three things the other outcomes do not:
     * books the chargeback and its fee, reverses the artist's royalty, and
     * marks the order refunded. A WON dispute costs nothing and changes
     * nothing but the case's own status.
     */
    async resolve(
        id: string,
        dto: ResolveDisputeDto,
        access: PaymentAccess,
    ): Promise<DisputeView> {
        requireManage(access, 'resolve a dispute');
        const dispute = await this.requireInScope(id, access);
        const correlationId = randomUUID();

        if (['WON', 'LOST', 'ACCEPTED', 'WITHDRAWN'].includes(dispute.status)) {
            throw AppError.conflict(
                'This dispute has already been resolved.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
                { status: dispute.status },
            );
        }

        const now = new Date();
        const changed = await this.deps.disputes.transition({
            id,
            from: dispute.status,
            data: {
                status: dto.outcome,
                resolvedById: access.userId,
                resolvedAt: now,
                resolutionNote: dto.resolutionNote,
                ...(dto.feeAmount ? { feeAmount: new Prisma.Decimal(dto.feeAmount) } : {}),
            },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This dispute changed while you were resolving it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const lost = dto.outcome === 'LOST' || dto.outcome === 'ACCEPTED';
        if (lost) {
            await this.applyLoss(dispute, dto.feeAmount ?? null, access.userId, correlationId);
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.DISPUTE_RESOLVE,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'DisputeCase', id },
            beforeState: { status: dispute.status },
            afterState: {
                status: dto.outcome,
                amount: dispute.amount.toFixed(2),
                currency: dispute.currency,
                feeAmount: dto.feeAmount ?? dispute.feeAmount?.toFixed(2) ?? null,
                resolutionNote: dto.resolutionNote,
            },
            correlationId,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.DISPUTE_RESOLVED, {
            disputeCaseId: id,
            orderId: dispute.orderId,
            outcome: dto.outcome,
            amount: dispute.amount.toFixed(2),
            currency: dispute.currency,
        });

        return this.getById(id, access);
    }

    /** Resolution arriving as a webhook. */
    async closeFromGateway(input: {
        object: Record<string, unknown>;
        correlationId: string;
    }): Promise<void> {
        const caseRef = typeof input.object['id'] === 'string' ? input.object['id'] : null;
        if (!caseRef) return;

        const dispute = await this.deps.disputes.findByGatewayRef(caseRef);
        if (!dispute) {
            this.deps.logger.warn({ caseRef }, 'dispute-closed webhook for an unknown case');
            return;
        }
        if (['WON', 'LOST', 'ACCEPTED', 'WITHDRAWN'].includes(dispute.status)) return;

        const status = input.object['status'];
        const outcome =
            status === 'won'
                ? 'WON'
                : status === 'lost'
                    ? 'LOST'
                    : status === 'warning_closed'
                        ? 'WITHDRAWN'
                        : 'LOST';

        const now = new Date();
        const changed = await this.deps.disputes.transition({
            id: dispute.id,
            from: dispute.status,
            data: {
                status: outcome,
                resolvedAt: now,
                resolutionNote: `Closed by the provider as "${String(status)}".`,
            },
        });
        if (changed === 0) return;

        if (outcome === 'LOST') {
            await this.applyLoss(dispute, null, null, input.correlationId);
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.DISPUTE_RESOLVE,
            actor: { type: 'SYSTEM', id: null },
            result: 'SUCCESS',
            resource: { type: 'DisputeCase', id: dispute.id },
            beforeState: { status: dispute.status },
            afterState: { status: outcome, source: 'gateway webhook' },
            correlationId: input.correlationId,
        });
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    async list(
        query: ListDisputesQuery,
        access: PaymentAccess,
    ): Promise<{ page: number; limit: number; total: number; items: DisputeView[] }> {
        const { total, items } = await this.deps.disputes.list({
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

    async getById(id: string, access: PaymentAccess): Promise<DisputeView> {
        return this.toView(await this.requireInScope(id, access));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** The financial consequences of losing, in one place for both callers. */
    private async applyLoss(
        dispute: DisputeCase,
        feeAmount: string | null,
        actorId: string | null,
        correlationId: string,
    ): Promise<void> {
        await this.deps.finance.postChargeback({
            orderId: dispute.orderId,
            disputeCaseId: dispute.id,
            amount: dispute.amount.toFixed(2),
            feeAmount: feeAmount ?? dispute.feeAmount?.toFixed(2) ?? null,
            currency: dispute.currency,
            description: `Dispute lost (${dispute.reasonCode})`,
        });

        await this.deps.orders.markRefunded({
            orderId: dispute.orderId,
            refundedAt: new Date(),
        });

        try {
            await this.deps.royalties.reverseForOrder({
                orderId: dispute.orderId,
                reason: `Dispute ${dispute.id} lost`,
                reasonCode: 'DISPUTE_LOSS',
                actorId,
                disputeCaseId: dispute.id,
                correlationId,
            });
        } catch (error) {
            this.deps.logger.error(
                { err: error, disputeCaseId: dispute.id, orderId: dispute.orderId },
                'dispute loss booked but the royalty could not be reversed — manual intervention required',
            );
        }
    }

    private async recordOpened(
        dispute: DisputeCase,
        actorId: string | null,
        correlationId: string,
    ): Promise<void> {
        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.DISPUTE_OPEN,
            actor: actorId
                ? { type: 'HITBOX_EMPLOYEE', id: actorId }
                : { type: 'SYSTEM', id: null },
            result: 'SUCCESS',
            resource: { type: 'DisputeCase', id: dispute.id },
            afterState: {
                orderId: dispute.orderId,
                amount: dispute.amount.toFixed(2),
                currency: dispute.currency,
                reasonCode: dispute.reasonCode,
                evidenceDueBy: dispute.evidenceDueBy?.toISOString() ?? null,
            },
            correlationId,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.DISPUTE_OPENED, {
            disputeCaseId: dispute.id,
            orderId: dispute.orderId,
            amount: dispute.amount.toFixed(2),
            currency: dispute.currency,
            evidenceDueBy: dispute.evidenceDueBy?.toISOString() ?? null,
        });
    }

    /** Stripe's reason strings, mapped onto the enum. */
    private mapReason(reason: unknown): DisputeCase['reasonCode'] {
        const map: Record<string, DisputeCase['reasonCode']> = {
            fraudulent: 'FRAUDULENT',
            product_not_received: 'PRODUCT_NOT_RECEIVED',
            product_unacceptable: 'PRODUCT_UNACCEPTABLE',
            duplicate: 'DUPLICATE',
            subscription_canceled: 'SUBSCRIPTION_CANCELED',
            credit_not_processed: 'CREDIT_NOT_PROCESSED',
            unrecognized: 'UNRECOGNIZED',
        };
        return (typeof reason === 'string' && map[reason]) || 'OTHER';
    }

    private scopeFilter(access: PaymentAccess): Prisma.DisputeCaseWhereInput {
        if (access.scope === PaymentScope.GLOBAL) return {};
        if (access.scope === PaymentScope.ORGANIZATION) {
            return { order: { organizationId: { in: access.organizationIds ?? [] } } };
        }
        // Disputes are a platform matter: a buyer has no view of the case a
        // network opened on their behalf, and an artist none at all.
        return { id: '00000000-0000-0000-0000-000000000000' };
    }

    private async requireInScope(id: string, access: PaymentAccess): Promise<DisputeCase> {
        const { items } = await this.deps.disputes.list({
            page: 1,
            limit: 1,
            scopeFilter: { AND: [this.scopeFilter(access), { id }] },
            skip: 0,
            take: 1,
        });
        const dispute = items[0];
        if (!dispute) {
            throw AppError.notFound('Dispute not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }
        return dispute;
    }

    private toView(row: DisputeCase): DisputeView {
        return {
            id: row.id,
            orderId: row.orderId,
            paymentTransactionId: row.paymentTransactionId,
            gateway: row.gateway,
            gatewayCaseRef: row.gatewayCaseRef,
            reasonCode: row.reasonCode,
            reason: row.reason,
            status: row.status,
            amount: row.amount.toFixed(2),
            currency: row.currency,
            feeAmount: row.feeAmount?.toFixed(2) ?? null,
            evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
            evidenceSubmittedAt: row.evidenceSubmittedAt?.toISOString() ?? null,
            resolvedById: row.resolvedById,
            resolvedAt: row.resolvedAt?.toISOString() ?? null,
            resolutionNote: row.resolutionNote,
            openedAt: row.openedAt.toISOString(),
        };
    }
}

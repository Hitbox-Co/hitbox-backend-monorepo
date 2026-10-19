import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    FINANCE_DECISION_AUDIT_EVENTS,
    FINANCE_DECISION_ERROR_CODES,
    FINANCE_DECISION_EVENTS,
    FINANCE_ERROR_CODES,
    FINANCE_EVENTS,
} from '../constants/finance.constant';
import type { FinanceAccess } from '../domain/finance-access';
import { requireApprove, requireTransfer } from '../domain/finance-access';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type {
    ApproveWithReasonDto,
    RejectPayoutDto,
    TransferPayoutDto,
} from '../dto/cogs-royalty-payout.dto';
import type { PayoutView } from '../dto/finance.dto';
import type { FinanceLedgerRepository } from '../repository/finance-ledger.repository';
import type { PayoutRepository } from '../repository/payout.repository';
import type { RoyaltyLedgerRepository } from '../repository/royalty-ledger.repository';
import type { RoyaltyPayoutService } from './royalty-payout.service';

export interface PayoutDecisionServiceDeps {
    prisma: PrismaClient;
    payouts: PayoutRepository;
    ledger: RoyaltyLedgerRepository;
    financeLedger: FinanceLedgerRepository;
    /** Used only for the scope-checked read that shapes every response. */
    payoutReads: Pick<RoyaltyPayoutService, 'getById'>;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/** SCHEDULED is the built "pending approval" state; nothing is renamed. */
const PENDING_APPROVAL = 'SCHEDULED' as const;

/**
 * The three decisions a person makes on a payout batch, each its own
 * permission and its own audit event:
 *
 *   approve  `payment-royalty:approve`   SCHEDULED → APPROVED, reason required
 *   reject   `payment-royalty:approve`   SCHEDULED → CANCELLED (+ rejection trail),
 *                                        reason required, entries back to ACCRUED
 *   transfer `payment-royalty:transfer`  APPROVED  → PAID, who/when recorded
 *                                        separately from the approval
 *
 * Approving does not imply transferring: a user holding only `approve` cannot
 * move money, and the batch records both actors independently. The reason is
 * validated here as well as in the DTO — a service can be driven from a
 * script, and a decision with no recorded reason must not exist.
 */
export class PayoutDecisionService {
    constructor(private readonly deps: PayoutDecisionServiceDeps) { }

    async approve(
        id: string,
        dto: ApproveWithReasonDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireApprove(access, 'approve royalty payouts');
        const reason = this.requireReason(dto.reason);
        const payout = await this.requireDecidable(id, access, 'approved');
        const correlationId = randomUUID();
        const approvedAt = new Date();

        await this.deps.prisma.$transaction(async (tx) => {
            const changed = await this.deps.payouts.transition({
                id,
                from: PENDING_APPROVAL,
                data: {
                    status: 'APPROVED',
                    approvedById: actorId,
                    approvedAt,
                    approvalReason: reason,
                },
                tx,
            });
            if (changed === 0) throw this.notPending(payout.status, 'approved');

            await this.deps.audit.record(
                {
                    eventType: FINANCE_DECISION_AUDIT_EVENTS.PAYOUT_APPROVE,
                    actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                    result: 'SUCCESS',
                    resource: { type: 'RoyaltyPayout', id },
                    beforeState: { status: payout.status },
                    afterState: { status: 'APPROVED', approvalReason: reason },
                    correlationId,
                    severity: 'CRITICAL',
                },
                { tx },
            );
        });

        await this.deps.eventBus.publish(FINANCE_DECISION_EVENTS.PAYOUT_APPROVED, {
            payoutId: id,
            approvedById: actorId,
        });
        return this.deps.payoutReads.getById(id, access);
    }

    /**
     * Rejects a batch. Its entries go back to ACCRUED with no payout attached,
     * so the next quarterly sweep picks them up (product decision — the spec's
     * FR-10 would hold them for an explicit re-address).
     */
    async reject(
        id: string,
        dto: RejectPayoutDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireApprove(access, 'reject royalty payouts');
        const reason = this.requireReason(dto.reason);
        const payout = await this.requireDecidable(id, access, 'rejected');
        const correlationId = randomUUID();

        await this.deps.prisma.$transaction(async (tx) => {
            const changed = await this.deps.payouts.transition({
                id,
                from: PENDING_APPROVAL,
                data: {
                    status: 'CANCELLED',
                    rejectedById: actorId,
                    rejectedAt: new Date(),
                    rejectionReason: reason,
                },
                tx,
            });
            if (changed === 0) throw this.notPending(payout.status, 'rejected');

            const released = await this.deps.ledger.releaseBatch(id, tx);

            await this.deps.audit.record(
                {
                    eventType: FINANCE_DECISION_AUDIT_EVENTS.PAYOUT_REJECT,
                    actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                    result: 'SUCCESS',
                    resource: { type: 'RoyaltyPayout', id },
                    beforeState: { status: payout.status },
                    afterState: {
                        status: 'CANCELLED',
                        rejectionReason: reason,
                        entriesReleased: released,
                    },
                    correlationId,
                    severity: 'CRITICAL',
                },
                { tx },
            );
        });

        await this.deps.eventBus.publish(FINANCE_DECISION_EVENTS.PAYOUT_REJECTED, {
            payoutId: id,
            rejectedById: actorId,
        });
        return this.deps.payoutReads.getById(id, access);
    }

    /**
     * Records the bank transfer for an APPROVED batch. Needs its own
     * permission, and stamps `transferInitiatedById/At` apart from the approver.
     * Runs in one transaction with the entry flip: "batch paid, entries still
     * pending" is the state that makes an artist get paid twice.
     */
    async transfer(
        id: string,
        dto: TransferPayoutDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireTransfer(access, 'transfer royalty payouts');
        const payout = await this.requireInScope(id, access);
        const paidAt = dto.paidAt ?? new Date();
        const correlationId = randomUUID();

        await this.deps.prisma.$transaction(async (tx) => {
            const changed = await this.deps.payouts.transition({
                id,
                from: 'APPROVED',
                data: {
                    status: 'PAID',
                    gatewayPayoutRef: dto.gatewayPayoutRef,
                    paidAt,
                    transferInitiatedById: actorId,
                    transferInitiatedAt: new Date(),
                },
                tx,
            });
            if (changed === 0) {
                throw AppError.conflict(
                    `A payout that is ${payout.status} cannot be transferred — it must be approved first.`,
                    FINANCE_ERROR_CODES.INVALID_TRANSITION,
                    { status: payout.status },
                );
            }

            const settled = await this.deps.ledger.markBatchPaid(id, paidAt, tx);
            if (settled !== payout.entryCount) {
                throw AppError.conflict(
                    'The entries in this batch changed while it was being paid.',
                    FINANCE_ERROR_CODES.INVALID_TRANSITION,
                    { expected: payout.entryCount, settled },
                );
            }

            await this.deps.financeLedger.post(
                {
                    id: randomUUID(),
                    entryType: 'ORIGINAL',
                    direction: 'DEBIT',
                    category: 'ROYALTY_PAYOUT',
                    amount: payout.amount,
                    currency: payout.currency,
                    postingKey: `payout:${id}`,
                    description: `Royalty payout ${dto.gatewayPayoutRef}`,
                    createdAt: paidAt,
                },
                tx,
            );

            await this.deps.audit.record(
                {
                    eventType: FINANCE_DECISION_AUDIT_EVENTS.PAYOUT_TRANSFER,
                    actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                    result: 'SUCCESS',
                    resource: { type: 'RoyaltyPayout', id },
                    beforeState: { status: payout.status },
                    afterState: {
                        status: 'PAID',
                        gatewayPayoutRef: dto.gatewayPayoutRef,
                        amount: payout.amount.toFixed(2),
                        currency: payout.currency,
                        entryCount: settled,
                    },
                    correlationId,
                    severity: 'CRITICAL',
                },
                { tx },
            );
        });

        await this.deps.eventBus.publish(FINANCE_EVENTS.PAYOUT_PAID, {
            payoutId: id,
            payeeType: payout.payeeType,
            payeeId: payout.payeeArtistId ?? payout.payeeOrganizationId,
            amount: payout.amount.toFixed(2),
            currency: payout.currency,
            paidAt: paidAt.toISOString(),
        });
        return this.deps.payoutReads.getById(id, access);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private requireReason(reason: string | undefined): string {
        const trimmed = reason?.trim() ?? '';
        if (trimmed.length < 5) {
            throw AppError.badRequest(
                'A reason of at least 5 characters is required for this decision.',
                FINANCE_DECISION_ERROR_CODES.REASON_REQUIRED,
            );
        }
        return trimmed;
    }

    /** Scope-checked read first (404 for out of scope), then the row itself. */
    private async requireInScope(id: string, access: FinanceAccess) {
        await this.deps.payoutReads.getById(id, access);
        const payout = await this.deps.payouts.findById(id);
        if (!payout) {
            throw AppError.notFound('Payout not found.', FINANCE_ERROR_CODES.NOT_FOUND);
        }
        return payout;
    }

    private async requireDecidable(id: string, access: FinanceAccess, verb: string) {
        const payout = await this.requireInScope(id, access);
        if (payout.status !== PENDING_APPROVAL) throw this.notPending(payout.status, verb);
        return payout;
    }

    private notPending(status: string, verb: string): AppError {
        return AppError.conflict(
            `A payout that is ${status} cannot be ${verb}; only a pending payout can.`,
            FINANCE_ERROR_CODES.INVALID_TRANSITION,
            { status },
        );
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    FINANCE_AUDIT_EVENTS,
    FINANCE_ERROR_CODES,
    FINANCE_EVENTS,
    ROYALTY_DEFAULT_PAYOUT_THRESHOLD,
} from '../constants/finance.constant';
import type { FinanceAccess } from '../domain/finance-access';
import { FinanceScope, requireManage } from '../domain/finance-access';
import { payoutScope, royaltyEntryScope } from '../domain/scope-filter';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type {
    ApprovePayoutDto,
    ExecutePayoutDto,
    FailPayoutDto,
    ListPayoutsQuery,
    PayoutView,
    RoyaltyBalanceView,
    SchedulePayoutsDto,
} from '../dto/finance.dto';
import type { FinanceLedgerRepository } from '../repository/finance-ledger.repository';
import type { PayoutRepository, PayoutRow } from '../repository/payout.repository';
import type { RoyaltyLedgerRepository } from '../repository/royalty-ledger.repository';
import type { RoyaltyRuleRepository } from '../repository/royalty-rule.repository';

export interface RoyaltyPayoutServiceDeps {
    prisma: PrismaClient;
    payouts: PayoutRepository;
    ledger: RoyaltyLedgerRepository;
    financeLedger: FinanceLedgerRepository;
    rules: RoyaltyRuleRepository;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/**
 * The threshold sweep and the batch lifecycle.
 *
 * The design document's timeline is the specification:
 *
 *     Oct 31 — $506.25 accrued across 45 orders, ≥ $500 threshold
 *              → entries move to 'pending_payout'
 *     Nov  5 — finance approves, the gateway pays, entries move to 'paid'
 *
 * Three separate acts, and they are three separate calls here rather than one
 * "pay everyone" button, because each has a different actor and a different
 * failure mode. Scheduling is a job. Approving is a person deciding to spend
 * money. Executing is a provider confirming it moved. Collapsing them would
 * mean a scheduling bug could pay an artist, and a provider outage could look
 * like a rejected payout.
 */
export class RoyaltyPayoutService {
    constructor(private readonly deps: RoyaltyPayoutServiceDeps) { }

    // ── Balances ────────────────────────────────────────────────────────────

    /**
     * What every payee is owed, and whether they have reached their threshold.
     *
     * This is the artist's "how much have I earned" screen and the finance
     * team's payout queue — the same query, narrowed by the caller's own
     * grant. An OWN-scoped caller is resolved to their artist profile here and
     * can see exactly one row set.
     */
    async balances(
        access: FinanceAccess,
        filter: { currency?: string | undefined } = {},
    ): Promise<RoyaltyBalanceView[]> {
        const scopeFilter = await this.scopeFilter(access);
        const rows = await this.deps.ledger.balances({
            ...scopeFilter,
            ...(filter.currency ? { currency: filter.currency as never } : {}),
        });

        // Fold the per-status rows into one balance per (payee, currency).
        const byPayee = new Map<string, RoyaltyBalanceView & { rawAccrued: Prisma.Decimal }>();
        for (const row of rows) {
            const payeeId = row.payeeArtistId ?? row.payeeOrganizationId;
            const key = `${row.payeeType}:${payeeId}:${row.currency}`;
            const existing =
                byPayee.get(key) ??
                ({
                    payeeType: row.payeeType,
                    payeeId,
                    payeeName: null,
                    currency: row.currency,
                    accrued: '0.00',
                    pendingPayout: '0.00',
                    paid: '0.00',
                    reversed: '0.00',
                    outstanding: '0.00',
                    entryCount: 0,
                    threshold: ROYALTY_DEFAULT_PAYOUT_THRESHOLD,
                    thresholdMet: false,
                    rawAccrued: new Prisma.Decimal(0),
                } satisfies RoyaltyBalanceView & { rawAccrued: Prisma.Decimal });

            const total = row.total.toFixed(2);
            if (row.status === 'ACCRUED') {
                existing.accrued = total;
                existing.rawAccrued = row.total;
            } else if (row.status === 'PENDING_PAYOUT') existing.pendingPayout = total;
            else if (row.status === 'PAID') existing.paid = total;
            else if (row.status === 'REVERSED') existing.reversed = total;

            existing.entryCount += row.entryCount;
            byPayee.set(key, existing);
        }

        const views: RoyaltyBalanceView[] = [];
        for (const balance of byPayee.values()) {
            const threshold = await this.thresholdFor({
                artistId: balance.payeeType === 'ARTIST' ? balance.payeeId : null,
                organizationId:
                    balance.payeeType === 'ORGANIZATION' ? balance.payeeId : null,
            });
            const outstanding = new Prisma.Decimal(balance.accrued).plus(
                balance.pendingPayout,
            );
            const { rawAccrued, ...view } = balance;
            views.push({
                ...view,
                threshold: threshold.toFixed(2),
                // The threshold gates the ACCRUED pool only: entries already in
                // a batch are spoken for, and counting them again would sweep
                // a payee over the line on money that is already being paid.
                thresholdMet: rawAccrued.greaterThanOrEqualTo(threshold),
                outstanding: outstanding.toFixed(2),
            });
        }

        return views.sort((a, b) =>
            new Prisma.Decimal(b.outstanding).comparedTo(new Prisma.Decimal(a.outstanding)),
        );
    }

    // ── Scheduling ──────────────────────────────────────────────────────────

    /**
     * Sweeps every above-threshold balance into a payout batch.
     *
     * Idempotent by construction rather than by a key: entries are attached
     * with a guarded `updateMany` on `status = ACCRUED AND payoutId IS NULL`,
     * so a second run finds nothing to attach. If the guarded update matches
     * fewer rows than were read — someone reversed an entry in between — the
     * transaction is rolled back and that payee is skipped rather than paid a
     * number that no longer matches its entries.
     */
    async schedule(
        dto: SchedulePayoutsDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<{ scheduled: PayoutView[]; skipped: { payeeId: string; reason: string }[] }> {
        requireManage(access, 'schedule royalty payouts');

        const balances = await this.balances(access, { currency: dto.currency });
        const scheduled: PayoutView[] = [];
        const skipped: { payeeId: string; reason: string }[] = [];
        const correlationId = randomUUID();

        for (const balance of balances) {
            if (!balance.payeeId) continue;
            if (dto.artistId && balance.payeeId !== dto.artistId) continue;
            if (dto.organizationId && balance.payeeId !== dto.organizationId) continue;

            const threshold = dto.thresholdOverride
                ? new Prisma.Decimal(dto.thresholdOverride)
                : new Prisma.Decimal(balance.threshold);
            const accrued = new Prisma.Decimal(balance.accrued);

            if (accrued.lessThanOrEqualTo(0)) continue;
            if (accrued.lessThan(threshold)) {
                skipped.push({
                    payeeId: balance.payeeId,
                    reason: `Accrued ${accrued.toFixed(2)} ${balance.currency} is below the ${threshold.toFixed(2)} threshold.`,
                });
                continue;
            }

            const payeeArtistId = balance.payeeType === 'ARTIST' ? balance.payeeId : null;
            const payeeOrganizationId =
                balance.payeeType === 'ORGANIZATION' ? balance.payeeId : null;

            const entries = await this.deps.ledger.eligibleEntries({
                payeeArtistId,
                payeeOrganizationId,
                currency: balance.currency as never,
            });
            if (entries.length === 0) continue;

            // Summed from the entries themselves, not from the aggregate: the
            // batch total must equal the rows it settles, or a statement will
            // not reconcile.
            const total = entries.reduce(
                (sum, entry) => sum.plus(entry.amount),
                new Prisma.Decimal(0),
            );
            if (total.lessThanOrEqualTo(0)) {
                skipped.push({
                    payeeId: balance.payeeId,
                    reason: 'Net accrual is zero or negative — nothing to pay.',
                });
                continue;
            }

            if (dto.dryRun) {
                scheduled.push({
                    id: 'dry-run',
                    payee: {
                        type: balance.payeeType,
                        artistId: payeeArtistId,
                        organizationId: payeeOrganizationId,
                        name: balance.payeeName,
                    },
                    amount: total.toFixed(2),
                    currency: balance.currency,
                    entryCount: entries.length,
                    thresholdApplied: threshold.toFixed(2),
                    status: 'SCHEDULED',
                    scheduledAt: new Date().toISOString(),
                    approvedById: null,
                    approvedAt: null,
                    gatewayPayoutRef: null,
                    paidAt: null,
                    failureReason: null,
                });
                continue;
            }

            const now = new Date();
            const payoutId = randomUUID();
            const entryIds = entries.map((entry) => entry.id);

            try {
                await this.deps.prisma.$transaction(async (tx) => {
                    await this.deps.payouts.create(
                        {
                            id: payoutId,
                            payeeType: balance.payeeType as never,
                            payeeArtistId,
                            payeeOrganizationId,
                            amount: total,
                            currency: balance.currency as never,
                            entryCount: entries.length,
                            thresholdApplied: threshold,
                            status: 'SCHEDULED',
                            scheduledAt: now,
                            createdAt: now,
                            updatedAt: now,
                        },
                        tx,
                    );

                    const attached = await this.deps.ledger.attachToPayout(
                        entryIds,
                        payoutId,
                        tx,
                    );
                    if (attached !== entryIds.length) {
                        throw AppError.conflict(
                            'These royalty entries changed while the batch was being built.',
                            FINANCE_ERROR_CODES.INVALID_TRANSITION,
                            { expected: entryIds.length, attached },
                        );
                    }

                    await this.deps.audit.record(
                        {
                            eventType: FINANCE_AUDIT_EVENTS.PAYOUT_SCHEDULE,
                            actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                            result: 'SUCCESS',
                            resource: { type: 'RoyaltyPayout', id: payoutId },
                            afterState: {
                                payeeType: balance.payeeType,
                                payeeId: balance.payeeId,
                                amount: total.toFixed(2),
                                currency: balance.currency,
                                entryCount: entries.length,
                                thresholdApplied: threshold.toFixed(2),
                            },
                            correlationId,
                        },
                        { tx },
                    );
                });
            } catch (error) {
                if (error instanceof AppError && error.statusCode === 409) {
                    skipped.push({ payeeId: balance.payeeId, reason: error.message });
                    continue;
                }
                throw error;
            }

            const created = await this.deps.payouts.findById(payoutId);
            if (created) scheduled.push(this.toView(created));

            await this.deps.eventBus.publish(FINANCE_EVENTS.PAYOUT_SCHEDULED, {
                payoutId,
                payeeType: balance.payeeType,
                payeeId: balance.payeeId,
                amount: total.toFixed(2),
                currency: balance.currency,
                entryCount: entries.length,
            });
        }

        this.deps.logger.info(
            { scheduled: scheduled.length, skipped: skipped.length, dryRun: dto.dryRun },
            'royalty payout sweep complete',
        );
        return { scheduled, skipped };
    }

    // ── Batch lifecycle ─────────────────────────────────────────────────────

    async approve(
        id: string,
        dto: ApprovePayoutDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireManage(access, 'approve royalty payouts');
        const payout = await this.requireInScope(id, access);

        const changed = await this.deps.payouts.transition({
            id,
            from: 'SCHEDULED',
            data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() },
        });
        if (changed === 0) {
            throw AppError.conflict(
                `A payout that is ${payout.status} cannot be approved.`,
                FINANCE_ERROR_CODES.INVALID_TRANSITION,
                { status: payout.status },
            );
        }

        await this.deps.audit.record({
            eventType: FINANCE_AUDIT_EVENTS.PAYOUT_EXECUTE,
            actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
            result: 'SUCCESS',
            resource: { type: 'RoyaltyPayout', id },
            beforeState: { status: payout.status },
            afterState: { status: 'APPROVED', note: dto.note ?? null },
            correlationId: randomUUID(),
        });

        return this.getById(id, access);
    }

    /**
     * Records that the provider actually paid.
     *
     * Executes in a transaction with the entry status flip, because "the batch
     * is paid but its 45 entries still say pending" is the state that makes an
     * artist get paid twice.
     */
    async execute(
        id: string,
        dto: ExecutePayoutDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireManage(access, 'execute royalty payouts');
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
                },
                tx,
            });
            if (changed === 0) {
                throw AppError.conflict(
                    `A payout that is ${payout.status} cannot be executed — approve it first.`,
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

            // The platform's cash side of the payout.
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
                    eventType: FINANCE_AUDIT_EVENTS.PAYOUT_EXECUTE,
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

        return this.getById(id, access);
    }

    /**
     * The provider refused or the transfer bounced.
     *
     * Releases the entries back to ACCRUED so the next sweep picks them up —
     * a failed payout must not strand an artist's earnings in a state no job
     * looks at.
     */
    async fail(
        id: string,
        dto: FailPayoutDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<PayoutView> {
        requireManage(access, 'fail royalty payouts');
        const payout = await this.requireInScope(id, access);

        await this.deps.prisma.$transaction(async (tx) => {
            const changed = await this.deps.payouts.transition({
                id,
                from: payout.status === 'APPROVED' ? 'APPROVED' : 'SCHEDULED',
                data: { status: 'FAILED', failureReason: dto.failureReason },
                tx,
            });
            if (changed === 0) {
                throw AppError.conflict(
                    `A payout that is ${payout.status} cannot be failed.`,
                    FINANCE_ERROR_CODES.INVALID_TRANSITION,
                    { status: payout.status },
                );
            }
            await this.deps.ledger.releaseBatch(id, tx);

            await this.deps.audit.record(
                {
                    eventType: FINANCE_AUDIT_EVENTS.PAYOUT_EXECUTE,
                    actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                    result: 'FAILURE',
                    resource: { type: 'RoyaltyPayout', id },
                    beforeState: { status: payout.status },
                    afterState: { status: 'FAILED', failureReason: dto.failureReason },
                    correlationId: randomUUID(),
                },
                { tx },
            );
        });

        return this.getById(id, access);
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    async list(
        query: ListPayoutsQuery,
        access: FinanceAccess,
    ): Promise<{ page: number; limit: number; total: number; items: PayoutView[] }> {
        const scopeFilter = await this.payoutScopeFilter(access);
        const { total, items } = await this.deps.payouts.list({
            ...query,
            scopeFilter,
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

    async getById(id: string, access: FinanceAccess): Promise<PayoutView> {
        return this.toView(await this.requireInScope(id, access));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** The threshold in force for one payee, or the platform default. */
    private async thresholdFor(payee: {
        artistId: string | null;
        organizationId: string | null;
    }): Promise<Prisma.Decimal> {
        const fallback = new Prisma.Decimal(ROYALTY_DEFAULT_PAYOUT_THRESHOLD);
        const now = new Date();

        const { items } = await this.deps.rules.list({
            page: 1,
            limit: 50,
            organizationIds: null,
            skip: 0,
            take: 50,
            activeAt: now,
            ...(payee.artistId ? { artistId: payee.artistId } : {}),
            ...(payee.organizationId ? { organizationId: payee.organizationId } : {}),
        });

        // The most recently effective rule that states a threshold wins; a rule
        // that is silent leaves the platform default in place rather than
        // resetting it to zero.
        const stated = items.find((rule) => rule.payoutThreshold !== null);
        return stated?.payoutThreshold ?? fallback;
    }

    private scopeFilter(access: FinanceAccess): Promise<Prisma.RoyaltyLedgerEntryWhereInput> {
        return royaltyEntryScope(access, (userId) => this.deps.ledger.artistIdForUser(userId));
    }

    private payoutScopeFilter(access: FinanceAccess): Promise<Prisma.RoyaltyPayoutWhereInput> {
        return payoutScope(access, (userId) => this.deps.ledger.artistIdForUser(userId));
    }

    private async requireInScope(id: string, access: FinanceAccess): Promise<PayoutRow> {
        const payout = await this.deps.payouts.findById(id);
        if (!payout) {
            throw AppError.notFound('Payout not found.', FINANCE_ERROR_CODES.NOT_FOUND);
        }
        if (access.scope !== FinanceScope.GLOBAL) {
            const filter = await this.payoutScopeFilter(access);
            const reachable = await this.deps.payouts.list({
                page: 1,
                limit: 1,
                scopeFilter: { AND: [filter, { id }] },
                skip: 0,
                take: 1,
            });
            if (reachable.total === 0) {
                throw AppError.notFound('Payout not found.', FINANCE_ERROR_CODES.NOT_FOUND);
            }
        }
        return payout;
    }

    private toView(row: PayoutRow): PayoutView {
        return {
            id: row.id,
            payee: {
                type: row.payeeType,
                artistId: row.payeeArtistId,
                organizationId: row.payeeOrganizationId,
                name: row.payeeArtist?.name ?? row.payeeOrganization?.name ?? null,
            },
            amount: row.amount.toFixed(2),
            currency: row.currency,
            entryCount: row.entryCount,
            thresholdApplied: row.thresholdApplied?.toFixed(2) ?? null,
            status: row.status,
            scheduledAt: row.scheduledAt.toISOString(),
            approvedById: row.approvedById,
            approvedAt: row.approvedAt?.toISOString() ?? null,
            gatewayPayoutRef: row.gatewayPayoutRef,
            paidAt: row.paidAt?.toISOString() ?? null,
            failureReason: row.failureReason,
        };
    }
}

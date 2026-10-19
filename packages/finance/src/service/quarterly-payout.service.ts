import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    FINANCE_DECISION_AUDIT_EVENTS,
    FINANCE_ERROR_CODES,
    FINANCE_EVENTS,
} from '../constants/finance.constant';
import type { FinanceAccess } from '../domain/finance-access';
import { requireManage } from '../domain/finance-access';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import {
    currentQuarterBoundary,
    nextQuarterBoundary,
    quarterEndingAt,
    quarterLabel,
} from '../domain/quarter';
import type { QuarterlySweepDto } from '../dto/cogs-royalty-payout.dto';
import type { PayoutRepository } from '../repository/payout.repository';
import type { RoyaltyLedgerRepository } from '../repository/royalty-ledger.repository';

export interface QuarterlyPayoutServiceDeps {
    prisma: PrismaClient;
    payouts: PayoutRepository;
    ledger: RoyaltyLedgerRepository;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

export interface QuarterlySweepResult {
    /** The quarter whose boundary this run settles, e.g. "2026-Q3". */
    quarter: string;
    periodStart: string;
    periodEnd: string;
    dryRun: boolean;
    created: {
        payoutId: string | null;
        payeeType: string;
        payeeId: string | null;
        currency: string;
        amount: string;
        entryCount: number;
    }[];
    skipped: { payeeId: string | null; currency: string; reason: string }[];
}

/**
 * The quarterly payout sweep.
 *
 * At Jan 1 / Apr 1 / Jul 1 / Oct 1 00:00 UTC, every payee's ACCRUED, unbatched
 * entries accrued before that boundary become ONE payout per payee per
 * currency, in SCHEDULED (= pending approval). Nothing is paid by the sweep:
 * every batch then needs an explicit approval, and a transfer after that.
 *
 * Entries from earlier quarters that were never swept — or that came back from
 * a rejected batch — are still ACCRUED, so they join the next run; the cutoff
 * is "accrued before the boundary", not "accrued inside the quarter".
 *
 * **No threshold.** The per-rule `payoutThreshold` gates the older
 * `POST /payouts/schedule` sweep; the quarterly workflow puts every artist /
 * quarter in front of an approver (FR-10), so a small balance is a batch to
 * decide on, not one to hold back silently.
 *
 * **Idempotent without a lock.** Entries attach through a guarded `updateMany`
 * (ACCRUED, no payout), so a second run — or a second instance — finds nothing
 * left, and a race that attaches fewer rows than were read rolls that batch
 * back and skips the payee.
 */
export class QuarterlyPayoutService {
    constructor(private readonly deps: QuarterlyPayoutServiceDeps) { }

    /** Manual trigger (HTTP): needs the global manage grant. */
    async sweepAs(
        dto: QuarterlySweepDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<QuarterlySweepResult> {
        requireManage(access, 'run the quarterly payout sweep');
        return this.sweep(dto, { type: 'HITBOX_EMPLOYEE', id: actorId });
    }

    async sweep(
        dto: QuarterlySweepDto = { dryRun: false },
        actor: { type: 'SYSTEM' | 'HITBOX_EMPLOYEE'; id?: string } = { type: 'SYSTEM' },
    ): Promise<QuarterlySweepResult> {
        const asOf = dto.asOf ?? new Date();
        const boundary = currentQuarterBoundary(asOf);
        const period = quarterEndingAt(boundary);
        const label = quarterLabel(period.start);
        const correlationId = randomUUID();

        const rows = await this.deps.ledger.accruedBefore(boundary);

        // One bucket per payee per currency.
        const groups = new Map<
            string,
            {
                payeeType: 'ARTIST' | 'ORGANIZATION';
                payeeArtistId: string | null;
                payeeOrganizationId: string | null;
                currency: string;
                ids: string[];
                total: Prisma.Decimal;
            }
        >();
        for (const row of rows) {
            const payeeId = row.payeeArtistId ?? row.payeeOrganizationId;
            const key = `${row.payeeType}:${payeeId}:${row.currency}`;
            const group = groups.get(key) ?? {
                payeeType: row.payeeType as 'ARTIST' | 'ORGANIZATION',
                payeeArtistId: row.payeeArtistId,
                payeeOrganizationId: row.payeeOrganizationId,
                currency: row.currency as string,
                ids: [],
                total: new Prisma.Decimal(0),
            };
            group.ids.push(row.id);
            group.total = group.total.plus(row.amount);
            groups.set(key, group);
        }

        const result: QuarterlySweepResult = {
            quarter: label,
            periodStart: period.start.toISOString().slice(0, 10),
            periodEnd: period.end.toISOString().slice(0, 10),
            dryRun: dto.dryRun,
            created: [],
            skipped: [],
        };

        for (const group of groups.values()) {
            const payeeId = group.payeeArtistId ?? group.payeeOrganizationId;

            // A net-zero or negative balance (refund reversals outweighing
            // accruals) has nothing to pay; its entries stay ACCRUED and carry
            // into the next quarter.
            if (group.total.lessThanOrEqualTo(0)) {
                result.skipped.push({
                    payeeId,
                    currency: group.currency,
                    reason: 'Net accrual is zero or negative — nothing to pay this quarter.',
                });
                continue;
            }

            if (dto.dryRun) {
                result.created.push({
                    payoutId: null,
                    payeeType: group.payeeType,
                    payeeId,
                    currency: group.currency,
                    amount: group.total.toFixed(2),
                    entryCount: group.ids.length,
                });
                continue;
            }

            const payoutId = randomUUID();
            const now = new Date();
            try {
                await this.deps.prisma.$transaction(async (tx) => {
                    await this.deps.payouts.create(
                        {
                            id: payoutId,
                            payeeType: group.payeeType,
                            payeeArtistId: group.payeeArtistId,
                            payeeOrganizationId: group.payeeOrganizationId,
                            amount: group.total,
                            currency: group.currency as never,
                            entryCount: group.ids.length,
                            thresholdApplied: null,
                            status: 'SCHEDULED',
                            scheduledAt: now,
                            payoutPeriodStart: period.start,
                            payoutPeriodEnd: new Date(period.end.getTime() - 86_400_000),
                            createdAt: now,
                            updatedAt: now,
                        },
                        tx,
                    );

                    const attached = await this.deps.ledger.attachToPayout(
                        group.ids,
                        payoutId,
                        tx,
                    );
                    if (attached !== group.ids.length) {
                        throw AppError.conflict(
                            'These royalty entries changed while the batch was being built.',
                            FINANCE_ERROR_CODES.INVALID_TRANSITION,
                            { expected: group.ids.length, attached },
                        );
                    }

                    await this.deps.audit.record(
                        {
                            eventType: FINANCE_DECISION_AUDIT_EVENTS.PAYOUT_QUARTERLY_SWEEP,
                            actor: actor.id
                                ? { type: actor.type, id: actor.id }
                                : { type: actor.type },
                            result: 'SUCCESS',
                            resource: { type: 'RoyaltyPayout', id: payoutId },
                            afterState: {
                                quarter: label,
                                payeeType: group.payeeType,
                                payeeId,
                                amount: group.total.toFixed(2),
                                currency: group.currency,
                                entryCount: group.ids.length,
                                status: 'SCHEDULED',
                            },
                            correlationId,
                        },
                        { tx },
                    );
                });
            } catch (error) {
                if (error instanceof AppError && error.statusCode === 409) {
                    result.skipped.push({
                        payeeId,
                        currency: group.currency,
                        reason: error.message,
                    });
                    continue;
                }
                throw error;
            }

            result.created.push({
                payoutId,
                payeeType: group.payeeType,
                payeeId,
                currency: group.currency,
                amount: group.total.toFixed(2),
                entryCount: group.ids.length,
            });
            await this.deps.eventBus.publish(FINANCE_EVENTS.PAYOUT_SCHEDULED, {
                payoutId,
                payeeType: group.payeeType,
                payeeId,
                amount: group.total.toFixed(2),
                currency: group.currency,
                entryCount: group.ids.length,
            });
        }

        this.deps.logger.info(
            {
                quarter: label,
                created: result.created.length,
                skipped: result.skipped.length,
                dryRun: dto.dryRun,
            },
            'quarterly royalty payout sweep complete',
        );
        return result;
    }

    /**
     * Starts the in-process trigger. A coarse tick (default hourly) checks
     * whether the current quarter's boundary has been swept by *this* process;
     * if not, it runs. Re-running after a restart is harmless — the sweep is
     * idempotent — and it is how a sweep missed during downtime catches up.
     *
     * Returns a stop function. The timer is unref'd so it never holds the
     * process open.
     */
    startScheduler(options: { tickMs?: number } = {}): () => void {
        let lastSwept: number | null = null;
        let running = false;

        const tick = async () => {
            if (running) return;
            const boundary = currentQuarterBoundary(new Date()).getTime();
            if (lastSwept === boundary) return;
            running = true;
            try {
                await this.sweep({ dryRun: false });
                lastSwept = boundary;
            } catch (error) {
                this.deps.logger.error(
                    { err: error },
                    'quarterly payout sweep failed — will retry on the next tick',
                );
            } finally {
                running = false;
            }
        };

        const timer = setInterval(() => void tick(), options.tickMs ?? 3_600_000);
        timer.unref();
        void tick();
        this.deps.logger.info(
            { nextBoundary: nextQuarterBoundary(new Date()).toISOString() },
            'quarterly payout scheduler started',
        );
        return () => clearInterval(timer);
    }
}

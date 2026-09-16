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
} from '../constants/finance.constant';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type { IOrderRevenueSource } from '../domain/interfaces/order-revenue.interface';
import {
    accrualKeyFor,
    calculateRoyalty,
    resolveRule,
    reversalKeyFor,
    splitsOf,
} from '../domain/royalty-calculation';
import type { FinanceLedgerRepository } from '../repository/finance-ledger.repository';
import type {
    RoyaltyEntryRow,
    RoyaltyLedgerRepository,
} from '../repository/royalty-ledger.repository';
import type { RoyaltyRuleRepository } from '../repository/royalty-rule.repository';

export interface RoyaltyAccrualServiceDeps {
    prisma: PrismaClient;
    rules: RoyaltyRuleRepository;
    ledger: RoyaltyLedgerRepository;
    financeLedger: FinanceLedgerRepository;
    orderRevenue: IOrderRevenueSource;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/** What one accrual run produced, for the log and for the caller. */
export interface AccrualResult {
    accrued: boolean;
    reason?: 'NO_ORDER' | 'NO_RULE' | 'ALREADY_ACCRUED' | 'ZERO_AMOUNT';
    entries: { id: string; amount: string; currency: string; payeeId: string }[];
}

export interface ReversalInput {
    orderId: string;
    reason: string;
    reasonCode:
    | 'REFUND_REVERSAL'
    | 'DISPUTE_LOSS'
    | 'CALCULATION_ERROR'
    | 'RULE_CORRECTION'
    | 'MANUAL_CORRECTION';
    actorId: string | null;
    refundRequestId?: string | null;
    disputeCaseId?: string | null;
    correlationId?: string;
}

export interface ReversalResult {
    reversedEntryIds: string[];
    /** Negative entries posted against already-paid royalties. */
    clawbackEntryIds: string[];
    adjustmentIds: string[];
}

/**
 * Accrual and reversal — the two moments the royalty ledger is written.
 *
 * **Accrual happens at the claim, not at the payment.** This is the single
 * most important decision in the design document and it is worth being
 * explicit about why: the buyer pays on day 1, but HitBox has not delivered
 * anything until the physical item is in their hands and the NFC tag is
 * tapped. An order that is paid and never claimed (lost in transit, returned
 * before delivery, a card that is charged back a week later) has earned the
 * artist nothing, and accruing at payment would mean the platform spends the
 * next month un-accruing things. So the trigger is
 * `claims.product.claimed`, and `Order.claimId` is what says an order has
 * reached that point.
 *
 * **Nothing here is ever edited.** A reversal marks the original REVERSED and
 * writes an AdjustmentEntry that points back at it; if the money has already
 * been paid out, it instead posts a *negative* entry that nets off the payee's
 * next batch. Both paths leave the original row exactly as it was posted.
 */
export class RoyaltyAccrualService {
    constructor(private readonly deps: RoyaltyAccrualServiceDeps) { }

    /**
     * Subscriber for `claims.product.claimed`.
     *
     * Every "nothing to do" branch returns rather than throws. An accrual that
     * cannot happen must not fail the claim: the buyer has tapped their tag and
     * owns their collectible whatever the royalty configuration says, and an
     * exception here would surface as a failed claim on someone's phone.
     */
    async accrueForClaim(input: {
        claimId: string;
        skuId: string;
        productId: string;
        userId: string;
        claimedAt?: Date;
    }): Promise<AccrualResult> {
        const correlationId = randomUUID();
        const claimedAt = input.claimedAt ?? new Date();

        const order = await this.deps.orderRevenue.findAccruableOrderForSku(input.skuId);
        if (!order) {
            this.deps.logger.info(
                { skuId: input.skuId, claimId: input.claimId },
                'claim has no settled order behind it — nothing to accrue',
            );
            return { accrued: false, reason: 'NO_ORDER', entries: [] };
        }

        const candidates = await this.deps.rules.findCandidates({
            productId: order.productId,
            collectionId: order.collectionId,
            artistId: order.artistId,
            organizationId: order.organizationId,
        });
        const rule = resolveRule(candidates, claimedAt);
        if (!rule) {
            // Loud, because it is a configuration hole rather than a normal
            // outcome: somebody sold a product nobody is being paid for.
            this.deps.logger.warn(
                {
                    productId: order.productId,
                    orderId: order.orderId,
                    claimId: input.claimId,
                },
                'no royalty rule in force for this product — no royalty accrued',
            );
            return { accrued: false, reason: 'NO_RULE', entries: [] };
        }

        const splits = splitsOf(rule, order.artistId);
        const grossRevenue = new Prisma.Decimal(order.grossRevenue);
        const costOfGoods = order.costOfGoods ? new Prisma.Decimal(order.costOfGoods) : null;

        const created: AccrualResult['entries'] = [];
        for (const split of splits) {
            const payeeId = split.artistId ?? split.organizationId;
            if (!payeeId) continue;

            const calculation = calculateRoyalty({
                grossRevenue,
                costOfGoods,
                basis: rule.basis,
                percentage: split.percentage,
            });

            // A zero accrual is not worth a row: it adds nothing to any
            // balance and makes every statement longer. The claim is still
            // recorded; there is simply no money in it.
            if (calculation.amount.isZero()) continue;

            const entryId = randomUUID();
            const entry = await this.deps.ledger.createEntry({
                id: entryId,
                orderId: order.orderId,
                ruleId: rule.id,
                skuId: input.skuId,
                claimId: input.claimId,
                accrualKey: accrualKeyFor(input.claimId, rule.id, payeeId),
                payeeType: split.payeeType,
                payeeArtistId: split.artistId,
                payeeOrganizationId: split.organizationId,
                basis: rule.basis,
                percentage: split.percentage,
                grossRevenue: calculation.grossRevenue,
                costOfGoods: calculation.costOfGoods,
                netProfit: calculation.netProfit,
                amount: calculation.amount,
                currency: order.currency as never,
                entryType: 'ORIGINAL',
                status: 'ACCRUED',
                accruedAt: claimedAt,
                createdAt: new Date(),
            });

            if (!entry) {
                // The unique accrualKey rejected it: this claim already
                // accrued under this rule for this payee. A redelivered event,
                // not a problem.
                this.deps.logger.info(
                    { claimId: input.claimId, ruleId: rule.id, payeeId },
                    'royalty already accrued for this claim — skipped',
                );
                continue;
            }

            // The platform's own books: a royalty owed is an expense against
            // the margin on that order. Keyed so a retry cannot post it twice.
            await this.deps.financeLedger.post({
                id: randomUUID(),
                orderId: order.orderId,
                entryType: 'ORIGINAL',
                direction: 'DEBIT',
                category: 'ROYALTY_EXPENSE',
                amount: calculation.amount,
                currency: order.currency as never,
                postingKey: `royalty-expense:${entry.id}`,
                description: `Royalty accrued to ${split.payeeType.toLowerCase()} ${payeeId}`,
                createdAt: new Date(),
            });

            created.push({
                id: entry.id,
                // toFixed(2), never toString(): a money string in this system
                // always carries both decimal places, and "7.5" reaching a
                // subscriber or a statement beside "11.25" is the kind of
                // inconsistency that becomes a formatting bug downstream.
                amount: calculation.amount.toFixed(2),
                currency: order.currency,
                payeeId,
            });

            await this.deps.audit.record({
                eventType: FINANCE_AUDIT_EVENTS.ROYALTY_ACCRUE,
                actor: { type: 'SYSTEM', id: null },
                result: 'SUCCESS',
                organizationId: order.organizationId,
                resource: { type: 'RoyaltyLedgerEntry', id: entry.id },
                afterState: {
                    orderId: order.orderId,
                    claimId: input.claimId,
                    ruleId: rule.id,
                    payeeId,
                    basis: rule.basis,
                    percentage: split.percentage.toString(),
                    grossRevenue: calculation.grossRevenue.toString(),
                    costOfGoods: calculation.costOfGoods.toString(),
                    netProfit: calculation.netProfit.toString(),
                    amount: calculation.amount.toString(),
                    currency: order.currency,
                },
                correlationId,
            });
        }

        if (created.length === 0) {
            return { accrued: false, reason: 'ALREADY_ACCRUED', entries: [] };
        }

        await this.deps.eventBus.publish(FINANCE_EVENTS.ROYALTY_ACCRUED, {
            claimId: input.claimId,
            orderId: order.orderId,
            skuId: input.skuId,
            entries: created,
        });
        this.deps.logger.info(
            { claimId: input.claimId, orderId: order.orderId, count: created.length },
            'royalty accrued at claim',
        );

        return { accrued: true, entries: created };
    }

    /**
     * Reverses every royalty accrued against one order.
     *
     * Called by the payments module when a refund is executed or a dispute is
     * lost — through a port, so payments never touches this table. Two paths,
     * chosen per entry by what has already happened to the money:
     *
     *   **Not yet paid** (ACCRUED / PENDING_PAYOUT) — the entry is marked
     *   REVERSED and drops out of the payee's outstanding balance. The original
     *   row keeps its original amount; an AdjustmentEntry records what
     *   cancelled it and why.
     *
     *   **Already paid** — the money is in the artist's bank account and
     *   cannot be un-sent. A *negative* ADJUSTMENT entry is posted instead, so
     *   it nets off their next batch, and the adjustment row points at both.
     *
     * The difference matters: the first is a correction, the second is a debt.
     * Collapsing them would either overstate what an artist has been paid or
     * silently take money back out of a settled statement.
     */
    async reverseForOrder(input: ReversalInput): Promise<ReversalResult> {
        const correlationId = input.correlationId ?? randomUUID();
        const entries = await this.deps.ledger.findByOrder(input.orderId);
        const originals = entries.filter(
            (entry) => entry.entryType === 'ORIGINAL' && entry.status !== 'REVERSED',
        );

        const result: ReversalResult = {
            reversedEntryIds: [],
            clawbackEntryIds: [],
            adjustmentIds: [],
        };
        if (originals.length === 0) return result;

        for (const entry of originals) {
            await this.reverseSingle(entry, input, correlationId, result);
        }

        if (result.reversedEntryIds.length > 0 || result.clawbackEntryIds.length > 0) {
            await this.deps.eventBus.publish(FINANCE_EVENTS.ROYALTY_REVERSED, {
                orderId: input.orderId,
                reversedEntryIds: result.reversedEntryIds,
                clawbackEntryIds: result.clawbackEntryIds,
                reasonCode: input.reasonCode,
            });
        }

        this.deps.logger.info(
            {
                orderId: input.orderId,
                reversed: result.reversedEntryIds.length,
                clawedBack: result.clawbackEntryIds.length,
                reasonCode: input.reasonCode,
            },
            'royalty entries reversed',
        );
        return result;
    }

    /**
     * One entry's reversal, atomically: the status change (or the clawback
     * posting), the adjustment row, the matching platform-ledger credit and
     * the audit record all commit together. A correction whose audit row
     * failed is a correction nobody can account for, which is precisely the
     * thing the immutability principle exists to prevent.
     */
    private async reverseSingle(
        entry: RoyaltyEntryRow,
        input: ReversalInput,
        correlationId: string,
        result: ReversalResult,
    ): Promise<void> {
        const now = new Date();
        await this.deps.prisma.$transaction(async (tx) => {
                let resultingEntryId: string | null = null;

                if (entry.status === 'PAID') {
                    const clawbackId = randomUUID();
                    const posted = await this.deps.ledger.createEntry(
                        {
                            id: clawbackId,
                            orderId: entry.orderId,
                            ruleId: entry.ruleId,
                            skuId: entry.skuId,
                            claimId: entry.claimId,
                            accrualKey: reversalKeyFor(entry.id),
                            payeeType: entry.payeeType,
                            payeeArtistId: entry.payeeArtistId,
                            payeeOrganizationId: entry.payeeOrganizationId,
                            basis: entry.basis,
                            percentage: entry.percentage,
                            grossRevenue: entry.grossRevenue,
                            costOfGoods: entry.costOfGoods,
                            netProfit: entry.netProfit,
                            amount: entry.amount.negated(),
                            currency: entry.currency,
                            entryType: 'ADJUSTMENT',
                            status: 'ACCRUED',
                            adjustsEntryId: entry.id,
                            accruedAt: now,
                            createdAt: now,
                        },
                        tx,
                    );
                    // Null means this reversal was already posted — the unique
                    // reversal key caught a retry. Nothing more to do.
                    if (!posted) return;
                    resultingEntryId = posted.id;
                    result.clawbackEntryIds.push(posted.id);
                } else {
                    const changed = await this.deps.ledger.markReversed(entry.id, tx);
                    if (changed === 0) return;
                    result.reversedEntryIds.push(entry.id);
                }

                const adjustment = await this.deps.financeLedger.createAdjustment(
                    {
                        id: randomUUID(),
                        targetType: 'ROYALTY_LEDGER_ENTRY',
                        targetId: entry.id,
                        orderId: entry.orderId,
                        amountAdjustment: entry.amount.negated(),
                        currency: entry.currency,
                        reasonCode: input.reasonCode,
                        reason: input.reason,
                        actorId: input.actorId,
                        refundRequestId: input.refundRequestId ?? null,
                        disputeCaseId: input.disputeCaseId ?? null,
                        resultingEntryId,
                        metadata: {
                            originalStatus: entry.status,
                            path: entry.status === 'PAID' ? 'CLAWBACK' : 'REVERSAL',
                        } as Prisma.InputJsonValue,
                        createdAt: now,
                    },
                    tx,
                );
                result.adjustmentIds.push(adjustment.id);

                // The expense comes back off the platform's books too, so
                // margin reporting does not keep counting a royalty nobody
                // will be paid.
                await this.deps.financeLedger.post(
                    {
                        id: randomUUID(),
                        orderId: entry.orderId,
                        entryType: 'ADJUSTMENT',
                        direction: 'CREDIT',
                        category: 'ROYALTY_EXPENSE',
                        amount: entry.amount.negated(),
                        currency: entry.currency,
                        adjustsEntryId: entry.id,
                        postingKey: `royalty-expense-reversal:${entry.id}`,
                        description: `Royalty reversed: ${input.reason}`,
                        createdAt: now,
                    },
                    tx,
                );

                await this.deps.audit.record(
                    {
                        eventType: FINANCE_AUDIT_EVENTS.ROYALTY_OVERRIDE,
                        actor: input.actorId
                            ? { type: 'HITBOX_EMPLOYEE', id: input.actorId }
                            : { type: 'SYSTEM', id: null },
                        result: 'SUCCESS',
                        resource: { type: 'RoyaltyLedgerEntry', id: entry.id },
                        beforeState: {
                            status: entry.status,
                            amount: entry.amount.toString(),
                        },
                        afterState: {
                            status: entry.status === 'PAID' ? 'PAID (clawed back)' : 'REVERSED',
                            adjustmentId: adjustment.id,
                            clawbackEntryId: resultingEntryId,
                            reasonCode: input.reasonCode,
                            reason: input.reason,
                        },
                        correlationId,
                    },
                    { tx },
                );
        });
    }

    /**
     * Manual reversal of ONE entry, from the admin API.
     *
     * Deliberately not "reverse the order": an operator correcting a
     * mis-calculated split on a three-way deal must be able to fix that one
     * posting without cancelling the other two payees' earnings.
     */
    async reverseEntry(input: {
        entry: RoyaltyEntryRow;
        reason: string;
        reasonCode: ReversalInput['reasonCode'];
        actorId: string;
    }): Promise<ReversalResult> {
        if (input.entry.status === 'REVERSED') {
            throw AppError.conflict(
                'This entry has already been reversed.',
                FINANCE_ERROR_CODES.ALREADY_REVERSED,
            );
        }
        const existing = await this.deps.ledger.findByAccrualKey(
            reversalKeyFor(input.entry.id),
        );
        if (existing) {
            throw AppError.conflict(
                'This entry has already been reversed.',
                FINANCE_ERROR_CODES.ALREADY_REVERSED,
                { reversalEntryId: existing.id },
            );
        }

        // Same private path the refund-driven reversal takes. A manual
        // correction and an automatic one must behave identically, and two
        // code paths that "should" agree eventually do not.
        const result: ReversalResult = {
            reversedEntryIds: [],
            clawbackEntryIds: [],
            adjustmentIds: [],
        };
        const correlationId = randomUUID();
        await this.reverseSingle(
            input.entry,
            {
                orderId: input.entry.orderId,
                reason: input.reason,
                reasonCode: input.reasonCode,
                actorId: input.actorId,
                correlationId,
            },
            correlationId,
            result,
        );

        await this.deps.eventBus.publish(FINANCE_EVENTS.ROYALTY_REVERSED, {
            orderId: input.entry.orderId,
            reversedEntryIds: result.reversedEntryIds,
            clawbackEntryIds: result.clawbackEntryIds,
            reasonCode: input.reasonCode,
        });
        return result;
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    FINANCE_AUDIT_EVENTS,
    FINANCE_ERROR_CODES,
    FINANCE_EVENTS,
} from '../constants/finance.constant';
import type { FinanceAccess } from '../domain/finance-access';
import { requireManage } from '../domain/finance-access';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import {
    adjustmentScope,
    financeEntryScope,
    royaltyEntryScope,
} from '../domain/scope-filter';
import type {
    AdjustmentView,
    CreateAdjustmentDto,
    FinanceEntryView,
    ListAdjustmentsQuery,
    ListFinanceEntriesQuery,
    ListRoyaltyEntriesQuery,
    RevenueSummaryQuery,
    RevenueSummaryView,
    RoyaltyEntryView,
} from '../dto/finance.dto';
import { ADJUSTMENT_TARGET_MODEL } from '../domain/public-codes';
import type { PublicCodeResolver } from '../domain/public-codes';
import type { FinanceLedgerRepository } from '../repository/finance-ledger.repository';
import type {
    RoyaltyEntryRow,
    RoyaltyLedgerRepository,
} from '../repository/royalty-ledger.repository';

export interface FinanceLedgerServiceDeps {
    codes: PublicCodeResolver;
    financeLedger: FinanceLedgerRepository;
    ledger: RoyaltyLedgerRepository;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/**
 * Reads over both ledgers, manual corrections, and the postings other modules
 * ask this one to make.
 *
 * The postings at the bottom are the reason payments does not own a ledger of
 * its own: a refund is a money movement *and* a book entry, and only one
 * module should be allowed to write the books. Payments decides that a refund
 * happened; finance decides what that means for the margin.
 */
export class FinanceLedgerService {
    constructor(private readonly deps: FinanceLedgerServiceDeps) { }

    // ── Royalty ledger reads ────────────────────────────────────────────────

    async listRoyaltyEntries(
        query: ListRoyaltyEntriesQuery,
        access: FinanceAccess,
    ): Promise<{ page: number; limit: number; total: number; items: RoyaltyEntryView[] }> {
        const scopeFilter = await royaltyEntryScope(access, (userId) =>
            this.deps.ledger.artistIdForUser(userId),
        );
        const { total, items } = await this.deps.ledger.list({
            ...query,
            scopeFilter,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: await this.entryViews(items),
        };
    }

    /** One entry, plus every correction posted against it. */
    async getRoyaltyEntry(
        id: string,
        access: FinanceAccess,
    ): Promise<RoyaltyEntryView & { adjustments: AdjustmentView[] }> {
        const entry = await this.requireEntryInScope(id, access);
        const adjustments = await this.deps.financeLedger.adjustmentsFor(
            'ROYALTY_LEDGER_ENTRY',
            id,
        );
        const [entryView] = await this.entryViews([entry]);
        return {
            ...(entryView as RoyaltyEntryView),
            adjustments: await this.adjustmentViews(adjustments),
        };
    }

    /**
     * Loads an entry the caller may actually see.
     *
     * The scope filter is applied in the query rather than checked after the
     * read: "fetch then compare" leaks existence through timing and through
     * the difference between 403 and 404, and an artist should not be able to
     * confirm that another artist has an entry with a given id.
     */
    async requireEntryInScope(id: string, access: FinanceAccess): Promise<RoyaltyEntryRow> {
        const scopeFilter = await royaltyEntryScope(access, (userId) =>
            this.deps.ledger.artistIdForUser(userId),
        );
        const { items } = await this.deps.ledger.list({
            page: 1,
            limit: 1,
            scopeFilter: { AND: [scopeFilter, { id }] },
            skip: 0,
            take: 1,
        });
        const entry = items[0];
        if (!entry) {
            throw AppError.notFound(
                'Royalty ledger entry not found.',
                FINANCE_ERROR_CODES.NOT_FOUND,
            );
        }
        return entry;
    }

    // ── Adjustments ─────────────────────────────────────────────────────────

    async listAdjustments(
        query: ListAdjustmentsQuery,
        access: FinanceAccess,
    ): Promise<{ page: number; limit: number; total: number; items: AdjustmentView[] }> {
        const { total, items } = await this.deps.financeLedger.listAdjustments({
            ...query,
            scopeFilter: adjustmentScope(access),
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: await this.adjustmentViews(items),
        };
    }

    /**
     * A manual correction, posted by a person.
     *
     * It writes an AdjustmentEntry and a matching platform-ledger line, and it
     * does **not** touch whatever it corrects. That is the whole immutability
     * principle in one method: the original record keeps saying what it always
     * said, and the correction stands beside it with a name and a reason on it.
     */
    async createAdjustment(
        dto: CreateAdjustmentDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<AdjustmentView> {
        requireManage(access, 'post financial adjustments');

        const amount = new Prisma.Decimal(dto.amountAdjustment);
        if (amount.isZero()) {
            throw AppError.badRequest(
                'An adjustment of zero corrects nothing.',
                FINANCE_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const now = new Date();
        const adjustment = await this.deps.financeLedger.createAdjustment({
            id: randomUUID(),
            targetType: dto.targetType,
            targetId: dto.targetId,
            orderId: dto.orderId ?? null,
            amountAdjustment: amount,
            currency: dto.currency,
            reasonCode: dto.reasonCode,
            reason: dto.reason,
            actorId,
            metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
            createdAt: now,
        });

        await this.deps.financeLedger.post({
            id: randomUUID(),
            orderId: dto.orderId ?? null,
            entryType: 'ADJUSTMENT',
            direction: amount.isNegative() ? 'CREDIT' : 'DEBIT',
            category: 'ADJUSTMENT',
            amount,
            currency: dto.currency,
            adjustsEntryId: dto.targetId,
            postingKey: `adjustment:${adjustment.id}`,
            description: dto.reason,
            createdAt: now,
        });

        await this.deps.audit.record({
            eventType: FINANCE_AUDIT_EVENTS.ADJUSTMENT_CREATE,
            actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
            result: 'SUCCESS',
            resource: { type: 'AdjustmentEntry', id: adjustment.id },
            afterState: {
                targetType: dto.targetType,
                targetId: dto.targetId,
                amountAdjustment: amount.toFixed(2),
                currency: dto.currency,
                reasonCode: dto.reasonCode,
                reason: dto.reason,
            },
            correlationId: randomUUID(),
        });

        await this.deps.eventBus.publish(FINANCE_EVENTS.ADJUSTMENT_POSTED, {
            adjustmentId: adjustment.id,
            targetType: dto.targetType,
            targetId: dto.targetId,
            amountAdjustment: amount.toFixed(2),
            currency: dto.currency,
        });

        return (await this.adjustmentViews([adjustment]))[0] as AdjustmentView;
    }

    // ── Platform ledger reads ───────────────────────────────────────────────

    async listFinanceEntries(
        query: ListFinanceEntriesQuery,
        access: FinanceAccess,
    ): Promise<{ page: number; limit: number; total: number; items: FinanceEntryView[] }> {
        const { total, items } = await this.deps.financeLedger.listEntries({
            ...query,
            scopeFilter: financeEntryScope(access),
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        const codes = await this.deps.codes.resolve({ order: items.map((r) => r.orderId) });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => ({
                id: row.id,
                publicCode: row.publicCode,
                orderId: row.orderId,
                orderPublicCode: codes.get('order', row.orderId),
                entryType: row.entryType,
                direction: row.direction,
                category: row.category,
                amount: row.amount.toFixed(2),
                currency: row.currency,
                costOfGoods: row.costOfGoods?.toFixed(2) ?? null,
                gatewayFee: row.gatewayFee?.toFixed(2) ?? null,
                description: row.description,
                createdAt: row.createdAt.toISOString(),
            })),
        };
    }

    /**
     * Revenue, cost and margin — one row per currency, never summed across
     * them. There is no FX rate in this system, and a single "total revenue"
     * figure that quietly adds rupees to dollars is worse than no figure.
     */
    async revenueSummary(
        query: RevenueSummaryQuery,
        access: FinanceAccess,
    ): Promise<RevenueSummaryView[]> {
        const scopeFilter: Prisma.FinanceLedgerEntryWhereInput = {
            ...financeEntryScope(access),
            ...(query.organizationId
                ? { order: { organizationId: query.organizationId } }
                : {}),
        };

        const [rows, orderCount] = await Promise.all([
            this.deps.financeLedger.revenueByCategory({ ...query, scopeFilter }),
            this.deps.financeLedger.orderCount({ ...query, scopeFilter }),
        ]);

        const byCurrency = new Map<string, RevenueSummaryView>();
        const zero = () => new Prisma.Decimal(0);

        interface CurrencyTotals {
            grossRevenue: Prisma.Decimal;
            costOfGoods: Prisma.Decimal;
            gatewayFees: Prisma.Decimal;
            refunds: Prisma.Decimal;
            chargebacks: Prisma.Decimal;
            royaltyExpense: Prisma.Decimal;
        }
        const totals = new Map<string, CurrencyTotals>();

        for (const row of rows) {
            const bucket: CurrencyTotals =
                totals.get(row.currency) ??
                {
                    grossRevenue: zero(),
                    costOfGoods: zero(),
                    gatewayFees: zero(),
                    refunds: zero(),
                    chargebacks: zero(),
                    royaltyExpense: zero(),
                };

            switch (row.category) {
                case 'SALE_REVENUE':
                    bucket.grossRevenue = bucket.grossRevenue.plus(row.amount);
                    bucket.costOfGoods = bucket.costOfGoods.plus(row.costOfGoods);
                    bucket.gatewayFees = bucket.gatewayFees.plus(row.gatewayFee);
                    break;
                case 'COST_OF_GOODS':
                    bucket.costOfGoods = bucket.costOfGoods.plus(row.amount);
                    break;
                case 'GATEWAY_FEE':
                    bucket.gatewayFees = bucket.gatewayFees.plus(row.amount);
                    break;
                case 'REFUND':
                    bucket.refunds = bucket.refunds.plus(row.amount);
                    break;
                case 'CHARGEBACK':
                    bucket.chargebacks = bucket.chargebacks.plus(row.amount);
                    break;
                case 'ROYALTY_EXPENSE':
                    // Reversals are posted as negative amounts in the same
                    // category, so summing gives the net expense without a
                    // second query for the corrections.
                    bucket.royaltyExpense = bucket.royaltyExpense.plus(row.amount);
                    break;
                default:
                    break;
            }
            totals.set(row.currency, bucket);
        }

        for (const [currency, bucket] of totals) {
            const netMargin = bucket.grossRevenue
                .minus(bucket.costOfGoods)
                .minus(bucket.gatewayFees)
                .minus(bucket.refunds)
                .minus(bucket.chargebacks)
                .minus(bucket.royaltyExpense);

            byCurrency.set(currency, {
                currency,
                grossRevenue: bucket.grossRevenue.toFixed(2),
                costOfGoods: bucket.costOfGoods.toFixed(2),
                gatewayFees: bucket.gatewayFees.toFixed(2),
                refunds: bucket.refunds.toFixed(2),
                chargebacks: bucket.chargebacks.toFixed(2),
                royaltyExpense: bucket.royaltyExpense.toFixed(2),
                netMargin: netMargin.toFixed(2),
                orderCount,
            });
        }

        return [...byCurrency.values()];
    }

    // ── Postings other modules ask for (the IFinancePostings port) ──────────

    /**
     * Books a settled sale: revenue in, with the cost and the gateway's cut
     * carried on the same line so margin needs no join.
     *
     * Idempotent on `postingKey`, which is the payment transaction's id — a
     * webhook Stripe delivers six times books revenue once.
     */
    async postSaleRevenue(input: {
        orderId: string;
        paymentTransactionId: string;
        amount: string;
        currency: string;
        costOfGoods?: string | null;
        gatewayFee?: string | null;
        description?: string;
    }): Promise<{ posted: boolean; entryId: string | null }> {
        const entry = await this.deps.financeLedger.post({
            id: randomUUID(),
            orderId: input.orderId,
            entryType: 'ORIGINAL',
            direction: 'CREDIT',
            category: 'SALE_REVENUE',
            amount: new Prisma.Decimal(input.amount),
            currency: input.currency as never,
            costOfGoods: input.costOfGoods ? new Prisma.Decimal(input.costOfGoods) : null,
            gatewayFee: input.gatewayFee ? new Prisma.Decimal(input.gatewayFee) : null,
            postingKey: `sale:${input.paymentTransactionId}`,
            description: input.description ?? 'Sale settled',
            createdAt: new Date(),
        });
        return { posted: entry !== null, entryId: entry?.id ?? null };
    }

    /** Books a refund against the order that earned the revenue. */
    async postRefund(input: {
        orderId: string;
        refundRequestId: string;
        amount: string;
        currency: string;
        description?: string;
    }): Promise<{ posted: boolean; entryId: string | null }> {
        const entry = await this.deps.financeLedger.post({
            id: randomUUID(),
            orderId: input.orderId,
            entryType: 'ADJUSTMENT',
            direction: 'DEBIT',
            category: 'REFUND',
            amount: new Prisma.Decimal(input.amount),
            currency: input.currency as never,
            postingKey: `refund:${input.refundRequestId}`,
            description: input.description ?? 'Refund issued',
            createdAt: new Date(),
        });
        return { posted: entry !== null, entryId: entry?.id ?? null };
    }

    /**
     * Books a lost dispute: the sale amount plus the network's fee, as two
     * lines. They are separate categories because they answer different
     * questions — one is revenue that evaporated, the other is a cost of doing
     * business, and a single combined figure hides both.
     */
    async postChargeback(input: {
        orderId: string;
        disputeCaseId: string;
        amount: string;
        feeAmount?: string | null;
        currency: string;
        description?: string;
    }): Promise<{ posted: boolean }> {
        const now = new Date();
        const loss = await this.deps.financeLedger.post({
            id: randomUUID(),
            orderId: input.orderId,
            entryType: 'ADJUSTMENT',
            direction: 'DEBIT',
            category: 'CHARGEBACK',
            amount: new Prisma.Decimal(input.amount),
            currency: input.currency as never,
            postingKey: `chargeback:${input.disputeCaseId}`,
            description: input.description ?? 'Dispute lost',
            createdAt: now,
        });

        if (input.feeAmount && !new Prisma.Decimal(input.feeAmount).isZero()) {
            await this.deps.financeLedger.post({
                id: randomUUID(),
                orderId: input.orderId,
                entryType: 'ADJUSTMENT',
                direction: 'DEBIT',
                category: 'GATEWAY_FEE',
                amount: new Prisma.Decimal(input.feeAmount),
                currency: input.currency as never,
                postingKey: `chargeback-fee:${input.disputeCaseId}`,
                description: 'Chargeback fee',
                createdAt: now,
            });
        }

        return { posted: loss !== null };
    }

    /** A correction posted by another module (refund, dispute) with no UI. */
    async postAdjustment(input: {
        targetType:
        | 'ROYALTY_LEDGER_ENTRY'
        | 'FINANCE_LEDGER_ENTRY'
        | 'ORDER'
        | 'PAYMENT_TRANSACTION'
        | 'ROYALTY_PAYOUT';
        targetId: string;
        orderId?: string | null;
        amountAdjustment: string;
        currency: string;
        reasonCode:
        | 'REFUND_REVERSAL'
        | 'DISPUTE_LOSS'
        | 'CHARGEBACK_FEE'
        | 'CALCULATION_ERROR'
        | 'RULE_CORRECTION'
        | 'GOODWILL'
        | 'MANUAL_CORRECTION';
        reason: string;
        actorId?: string | null;
        refundRequestId?: string | null;
        disputeCaseId?: string | null;
    }): Promise<{ adjustmentId: string }> {
        const adjustment = await this.deps.financeLedger.createAdjustment({
            id: randomUUID(),
            targetType: input.targetType,
            targetId: input.targetId,
            orderId: input.orderId ?? null,
            amountAdjustment: new Prisma.Decimal(input.amountAdjustment),
            currency: input.currency as never,
            reasonCode: input.reasonCode,
            reason: input.reason,
            actorId: input.actorId ?? null,
            refundRequestId: input.refundRequestId ?? null,
            disputeCaseId: input.disputeCaseId ?? null,
            createdAt: new Date(),
        });
        return { adjustmentId: adjustment.id };
    }

    // ── views ───────────────────────────────────────────────────────────────

    /** Entry views with every public code filled in, one query per model per page. */
    private async entryViews(rows: RoyaltyEntryRow[]): Promise<RoyaltyEntryView[]> {
        const codes = await this.deps.codes.resolve({
            order: rows.map((r) => r.orderId),
            royaltyPayout: rows.map((r) => r.payoutId),
            royaltyLedgerEntry: rows.map((r) => r.adjustsEntryId),
            artist: rows.map((r) => r.payeeArtistId),
            organization: rows.map((r) => r.payeeOrganizationId),
        });
        return rows.map((row) => {
            const view = this.toEntryView(row);
            return {
                ...view,
                orderPublicCode: codes.get('order', row.orderId),
                payoutPublicCode: codes.get('royaltyPayout', row.payoutId),
                adjustsEntryPublicCode: codes.get('royaltyLedgerEntry', row.adjustsEntryId),
                payee: {
                    ...view.payee,
                    publicCode:
                        codes.get('artist', row.payeeArtistId) ??
                        codes.get('organization', row.payeeOrganizationId),
                },
            };
        });
    }

    private async adjustmentViews(
        rows: Parameters<FinanceLedgerService['toAdjustmentView']>[0][],
    ): Promise<AdjustmentView[]> {
        const byModel: Record<string, string[]> = {};
        for (const row of rows) {
            const model = ADJUSTMENT_TARGET_MODEL[row.targetType];
            if (model) (byModel[model] ??= []).push(row.targetId);
        }
        const codes = await this.deps.codes.resolve({
            ...byModel,
            order: [...(byModel.order ?? []), ...rows.map((r) => r.orderId)],
        });
        return rows.map((row) => {
            const model = ADJUSTMENT_TARGET_MODEL[row.targetType];
            return {
                ...this.toAdjustmentView(row),
                orderPublicCode: codes.get('order', row.orderId),
                targetPublicCode: model ? codes.get(model, row.targetId) : null,
            };
        });
    }

    private toEntryView(row: RoyaltyEntryRow): RoyaltyEntryView {
        return {
            id: row.id,
            publicCode: row.publicCode,
            orderId: row.orderId,
            orderPublicCode: null,
            ruleId: row.ruleId,
            skuId: row.skuId,
            claimId: row.claimId,
            payee: {
                type: row.payeeType,
                artistId: row.payeeArtistId,
                organizationId: row.payeeOrganizationId,
                name: row.payeeArtist?.name ?? row.payeeOrganization?.name ?? null,
                publicCode: null,
            },
            calculation: {
                basis: row.basis,
                percentage: row.percentage?.toString() ?? null,
                grossRevenue: row.grossRevenue?.toFixed(2) ?? null,
                costOfGoods: row.costOfGoods?.toFixed(2) ?? null,
                netProfit: row.netProfit?.toFixed(2) ?? null,
            },
            amount: row.amount.toFixed(2),
            currency: row.currency,
            entryType: row.entryType,
            status: row.status,
            adjustsEntryId: row.adjustsEntryId,
            adjustsEntryPublicCode: null,
            payoutId: row.payoutId,
            payoutPublicCode: null,
            accruedAt: row.accruedAt.toISOString(),
            paidAt: row.paidAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        };
    }

    private toAdjustmentView(row: {
        id: string;
        publicCode: string | null;
        targetType: string;
        targetId: string;
        orderId: string | null;
        amountAdjustment: Prisma.Decimal;
        currency: string;
        reasonCode: string;
        reason: string;
        actorId: string | null;
        refundRequestId: string | null;
        disputeCaseId: string | null;
        resultingEntryId: string | null;
        createdAt: Date;
    }): AdjustmentView {
        return {
            id: row.id,
            publicCode: row.publicCode,
            targetType: row.targetType,
            targetId: row.targetId,
            targetPublicCode: null,
            orderId: row.orderId,
            orderPublicCode: null,
            amountAdjustment: row.amountAdjustment.toFixed(2),
            currency: row.currency,
            reasonCode: row.reasonCode,
            reason: row.reason,
            actorId: row.actorId,
            refundRequestId: row.refundRequestId,
            disputeCaseId: row.disputeCaseId,
            resultingEntryId: row.resultingEntryId,
            createdAt: row.createdAt.toISOString(),
        };
    }
}

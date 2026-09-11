import type { Logger } from 'pino';
import { INVENTORY_PREVIEW_LIMIT } from '../constants/dashboard.constant';
import {
    Visibility,
    allows,
    buildAccess,
    requireSection,
} from '../domain/dashboard-access';
import type { DashboardAccess, DashboardPrincipal } from '../domain/dashboard-access';
import { addMoney, money, subtractMoney, sumByCurrency } from '../domain/money';
import type { MoneyByCurrency } from '../domain/money';
import { growthPercentage, resolvePeriod, serialisePeriod } from '../domain/period';
import type { ResolvedPeriod } from '../domain/period';
import type { DashboardQuery } from '../dto/dashboard.dto';
import type { DashboardRepository, OrgFilter } from '../repository/dashboard.repository';

/**
 * Assembles the dashboard response.
 *
 * The shape of this service is the security model: **a section is built only
 * if the caller can see it.** That means a missing permission does not filter
 * a result to zero — the query never runs and the key never appears. Two
 * consequences worth stating:
 *
 *  • A caller cannot distinguish "no data this period" from "not allowed",
 *    because those look different: `{"orders": {...}}` vs. no `orders` key.
 *  • Sections nobody asked for cost nothing. An Order Manager's dashboard
 *    runs the order queries and none of the finance ones.
 */

export interface DashboardServiceDeps {
    repository: DashboardRepository;
    logger: Logger;
}

export class DashboardService {
    constructor(private readonly deps: DashboardServiceDeps) { }

    /** Resolves the caller's access view and the request window together. */
    prepare(
        principal: DashboardPrincipal,
        query: DashboardQuery,
    ): { view: DashboardAccess; period: ResolvedPeriod } {
        const view = buildAccess(principal, query.organizationId);
        const period = resolvePeriod({
            period: query.period,
            from: query.from,
            to: query.to,
        });
        return { view, period };
    }

    async build(
        principal: DashboardPrincipal,
        query: DashboardQuery,
    ): Promise<Record<string, unknown>> {
        const { view, period } = this.prepare(principal, query);
        const orgIds = view.organizationIds;
        const response: Record<string, unknown> = { period: serialisePeriod(period) };
        const summary: Record<string, unknown> = {};

        // ── Users ───────────────────────────────────────────────────────────
        // Two different resources feed this: buyer-profile covers end users,
        // employee-role-mgmt covers staff. A caller with only one of them sees
        // only that half.
        const canSeeBuyers = allows(view, 'buyer-profile');
        const canSeeStaff = allows(view, 'employee-role-mgmt');
        if (canSeeBuyers || canSeeStaff) {
            const counts = await this.deps.repository.userCounts(period);
            const users: Record<string, unknown> = {};

            if (canSeeBuyers) {
                users.total = counts.total;
                users.new = counts.newUsers;
                users.active = counts.active;
                users.inactive = counts.inactive;
                users.growthPercentage = growthPercentage(
                    counts.newUsers,
                    counts.previousNewUsers,
                );
                users.trend = (await this.deps.repository.userTrend(period)).map((p) => ({
                    date: p.date,
                    users: p.value,
                }));
                users.byMarket = await this.deps.repository.usersByMarket(period);
                summary.totalUsers = counts.total;
                summary.newUsers = counts.newUsers;
            }
            if (canSeeStaff) {
                users.newAdmins = counts.newAdmins;
                users.totalAdmins = counts.totalAdmins;
                summary.adminUsers = counts.totalAdmins;
            }
            response.users = users;
        }

        // ── Orders ──────────────────────────────────────────────────────────
        const canSeeOrders = allows(view, 'order');
        let orderCounts: Awaited<ReturnType<DashboardRepository['orderCounts']>> | null = null;
        if (canSeeOrders) {
            orderCounts = await this.deps.repository.orderCounts(period, orgIds);
            response.orders = {
                total: orderCounts.total,
                new: orderCounts.newOrders,
                growthPercentage: growthPercentage(
                    orderCounts.newOrders,
                    orderCounts.previousNewOrders,
                ),
                pendingPayment: orderCounts.byStatus.PENDING_PAYMENT ?? 0,
                paid: orderCounts.byStatus.PAID ?? 0,
                processing: orderCounts.byStatus.PROCESSING ?? 0,
                shipped: orderCounts.byStatus.SHIPPED ?? 0,
                delivered: orderCounts.byStatus.DELIVERED ?? 0,
                cancelled: orderCounts.byStatus.CANCELLED ?? 0,
                refunded: orderCounts.byStatus.REFUNDED ?? 0,
                trend: (await this.deps.repository.orderTrend(period, orgIds)).map((p) => ({
                    date: p.date,
                    orders: p.value,
                })),
                byMarket: await this.deps.repository.ordersByMarket(period, orgIds),
            };
            summary.totalOrders = orderCounts.total;
            summary.newOrders = orderCounts.newOrders;
        }

        // ── Money ───────────────────────────────────────────────────────────
        // Everything below this line requires payment-royalty. This is the
        // single gate that keeps `order:read` from implying revenue access.
        let finance: Record<string, MoneyByCurrency> | null = null;
        if (view.canSeeMoney) {
            finance = await this.buildFinance(period, orgIds);
            response.finance = finance;

            const payments = await this.deps.repository.paymentCounts(period, orgIds);
            response.payments = {
                successful: payments.counts.SUCCEEDED ?? 0,
                pending: payments.counts.PENDING ?? 0,
                initiated: payments.counts.INITIATED ?? 0,
                failed: payments.counts.FAILED ?? 0,
                needsReview: payments.needsReview,
                amount: sumByCurrency(
                    payments.amounts.map((a) => ({
                        currency: a.currency,
                        amount: a._sum.amount,
                    })),
                ),
            };

            summary.grossRevenue = finance.grossRevenue;
            summary.netRevenue = finance.netRevenue;
            summary.refunds = finance.refundedAmount;
            summary.profit = finance.profit;
        }

        // ── Refunds ─────────────────────────────────────────────────────────
        // Counts ride on `order:read`; amounts require payment-royalty. An
        // Order Manager sees the pipeline without the money.
        if (canSeeOrders || view.canSeeMoney) {
            const counts = await this.deps.repository.refundCounts(period, orgIds);
            const refunds: Record<string, unknown> = {
                requested: counts.REQUESTED ?? 0,
                awaitingReturn: counts.AWAITING_RETURN ?? 0,
                approved: counts.APPROVED ?? 0,
                processed: counts.PROCESSED ?? 0,
                rejected: counts.REJECTED ?? 0,
            };
            if (finance) refunds.amount = finance.refundedAmount;
            response.refunds = refunds;
        }

        // ── Markets ─────────────────────────────────────────────────────────
        // A re-slice of data the caller can already read, never a new grant:
        // revenue only appears here if they could see it in `finance`.
        if (allows(view, 'reports-dashboards') && (canSeeOrders || canSeeBuyers)) {
            response.markets = await this.buildMarkets(period, orgIds, view);
        }

        // ── Products ────────────────────────────────────────────────────────
        if (allows(view, 'drop')) {
            const products = await this.deps.repository.productCounts(period, orgIds);
            response.products = {
                total: products.total,
                new: products.newProducts,
                draft: products.byStatus.DRAFT ?? 0,
                submitted: products.byStatus.SUBMITTED ?? 0,
                inReview: products.byStatus.IN_REVIEW ?? 0,
                approved: products.byStatus.APPROVED ?? 0,
                rejected: products.byStatus.REJECTED ?? 0,
                published: products.byStatus.PUBLISHED ?? 0,
                active: products.byStatus.ACTIVE ?? 0,
                ended: products.byStatus.ENDED ?? 0,
                archived: products.byStatus.ARCHIVED ?? 0,
                inventory: await this.deps.repository.inventory(orgIds, INVENTORY_PREVIEW_LIMIT),
            };
            summary.totalProducts = products.total;
        }

        // ── Content ─────────────────────────────────────────────────────────
        if (allows(view, 'content-unlock')) {
            response.content = await this.deps.repository.contentSummary(period);
        }

        // ── Artists ─────────────────────────────────────────────────────────
        if (allows(view, 'brand-artist-record')) {
            response.artists = await this.deps.repository.artistSummary(period, orgIds);
            response.organizations = await this.deps.repository.organizationSummary(orgIds);
        }

        // ── Operations ──────────────────────────────────────────────────────
        if (canSeeOrders) {
            const ops = await this.deps.repository.operations(orgIds);
            const operations: Record<string, unknown> = {
                ordersPendingPayment: ops.pendingPayment,
                ordersProcessing: ops.processing,
                ordersAwaitingShipment: ops.awaitingShipment,
                ordersShipped: ops.shipped,
                ordersDelivered: ops.delivered,
                refundsAwaitingAction: ops.refundsAwaiting,
            };
            // Payments needing review is a financial queue, so it is gated
            // separately from the rest of the ops block.
            if (view.canSeeMoney) operations.paymentsNeedingReview = ops.paymentsNeedingReview;
            response.operations = operations;
        }

        // ── Provenance ──────────────────────────────────────────────────────
        if (allows(view, 'nfc-tag-claim') || allows(view, 'collectible-instance')) {
            response.provenance = await this.deps.repository.provenanceSummary(orgIds);
        }

        // ── Gateway config ──────────────────────────────────────────────────
        if (view.canSeeMoney) {
            response.paymentGatewayConfig = await this.deps.repository.gatewayConfigs(orgIds);
        }

        // ── Activity ────────────────────────────────────────────────────────
        if (allows(view, 'audit-log')) {
            const activity = await this.deps.repository.listActivity({
                period, orgIds, skip: 0, take: 20,
            });
            response.activity = activity.items.map((e) => ({
                eventId: e.eventId,
                occurredAt: e.occurredAt.toISOString(),
                type: e.eventType,
                actorId: e.actorId,
                // The role held at the time, not the actor's roles today.
                actorRoleSnapshot: e.actorRoleSnapshot,
                resourceType: e.resourceType,
                resourceId: e.resourceId,
                actionResult: e.actionResult,
                severity: e.severity,
            }));
        }

        // Summary last: it is a projection of the sections above, so it can
        // only contain cards whose section the caller could see.
        response.summary = summary;
        return response;
    }

    private async buildFinance(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
    ): Promise<Record<string, MoneyByCurrency>> {
        const [gross, collected, refunded, ledger, royalties] = await Promise.all([
            this.deps.repository.grossRevenue(period, orgIds),
            this.deps.repository.collectedRevenue(period, orgIds),
            this.deps.repository.refundedAmount(period, orgIds),
            this.deps.repository.financeLedgerTotals(period, orgIds),
            this.deps.repository.royaltyTotals(period, orgIds),
        ]);

        const grossRevenue = sumByCurrency(
            gross.map((r) => ({ currency: r.currency, amount: r._sum.amount })),
        );
        const collectedRevenue = sumByCurrency(
            collected.map((r) => ({ currency: r.currency, amount: r._sum.amount })),
        );
        const refundedAmount = sumByCurrency(refunded);
        const costOfGoods = sumByCurrency(
            ledger.map((r) => ({ currency: r.currency, amount: r.costOfGoods })),
        );
        const gatewayFees = sumByCurrency(
            ledger.map((r) => ({ currency: r.currency, amount: r.gatewayFee })),
        );
        const royaltyTotal = sumByCurrency(royalties);

        const netRevenue = subtractMoney(collectedRevenue, refundedAmount);
        const profit = subtractMoney(
            netRevenue,
            addMoney(costOfGoods, gatewayFees, royaltyTotal),
        );

        return {
            grossRevenue,
            collectedRevenue,
            refundedAmount,
            netRevenue,
            costOfGoods,
            gatewayFees,
            royalties: royaltyTotal,
            profit,
        };
    }

    private async buildMarkets(
        period: ResolvedPeriod,
        orgIds: OrgFilter,
        view: DashboardAccess,
    ): Promise<Record<string, unknown>[]> {
        const [markets, userRows, orderRows, moneyRows] = await Promise.all([
            this.deps.repository.markets(),
            allows(view, 'buyer-profile')
                ? this.deps.repository.usersByMarket(period)
                : Promise.resolve([]),
            allows(view, 'order')
                ? this.deps.repository.ordersByMarket(period, orgIds)
                : Promise.resolve([]),
            view.canSeeMoney
                ? this.deps.repository.moneyByMarket(period, orgIds)
                : Promise.resolve([]),
        ]);

        const usersBy = new Map(userRows.map((r) => [r.marketId, r]));
        const ordersBy = new Map(orderRows.map((r) => [r.marketId, r]));
        const revenueBy = new Map<string, MoneyByCurrency>();
        for (const row of moneyRows) {
            const current = revenueBy.get(row.marketId) ?? {};
            revenueBy.set(
                row.marketId,
                addMoney(current, { [row.currency]: money(row.revenue) }),
            );
        }

        return markets.map((market) => {
            const entry: Record<string, unknown> = {
                marketId: market.id,
                code: market.code,
                name: market.name,
                currency: market.currency,
            };
            const users = usersBy.get(market.id);
            if (users) {
                entry.users = users.users;
                entry.newUsers = users.newUsers;
            }
            const orders = ordersBy.get(market.id);
            if (orders) {
                entry.orders = orders.orders;
                entry.newOrders = orders.newOrders;
            }
            const revenue = revenueBy.get(market.id);
            if (revenue) entry.revenue = revenue;
            return entry;
        });
    }

    // ── Sub-endpoints ───────────────────────────────────────────────────────
    // These return one section directly, so a caller with no grant gets 403
    // rather than an omitted key — there is nothing else in the payload for
    // the omission to be meaningful against.

    async users(principal: DashboardPrincipal, query: DashboardQuery) {
        const { view, period } = this.prepare(principal, query);
        requireSection(view, 'buyer-profile');
        const counts = await this.deps.repository.userCounts(period);
        return {
            ...counts,
            growthPercentage: growthPercentage(counts.newUsers, counts.previousNewUsers),
            trend: await this.deps.repository.userTrend(period),
            byMarket: await this.deps.repository.usersByMarket(period),
        };
    }

    async orders(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; status?: string | undefined },
    ) {
        const { view, period } = this.prepare(principal, query);
        requireSection(view, 'order');
        const { total, items } = await this.deps.repository.listOrders({
            period,
            orgIds: view.organizationIds,
            status: query.status,
            marketId: query.marketId,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((order) => {
                const row: Record<string, unknown> = {
                    id: order.id,
                    status: order.status,
                    quantity: order.quantity,
                    marketId: order.marketId,
                    organizationId: order.organizationId,
                    productId: order.productId,
                    skuId: order.skuId,
                    placedAt: order.placedAt.toISOString(),
                    shippedAt: order.shippedAt?.toISOString() ?? null,
                    deliveredAt: order.deliveredAt?.toISOString() ?? null,
                };
                // The order's own amount is a monetary field like any other.
                if (view.canSeeMoney) {
                    row.amount = money(order.amount);
                    row.currency = order.currency;
                }
                // Buyer identity is shaped by the buyer-profile visibility the
                // engine resolved, not hand-filtered here.
                const buyer = view.access['buyer-profile'];
                if (buyer) {
                    row.buyerId =
                        buyer.visibility === Visibility.FULL
                            ? order.buyerId
                            : maskId(order.buyerId);
                }
                return row;
            }),
        };
    }

    async finance(principal: DashboardPrincipal, query: DashboardQuery) {
        const { view, period } = this.prepare(principal, query);
        requireSection(view, 'payment-royalty');
        return this.buildFinance(period, view.organizationIds);
    }

    async markets(principal: DashboardPrincipal, query: DashboardQuery) {
        const { view, period } = this.prepare(principal, query);
        requireSection(view, 'reports-dashboards');
        return this.buildMarkets(period, view.organizationIds, view);
    }

    async products(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; status?: string | undefined },
    ) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'drop');
        const { total, items } = await this.deps.repository.listProducts({
            orgIds: view.organizationIds,
            status: query.status,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return { page: query.page, limit: query.limit, total, items };
    }

    async releaseApprovals(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; status?: string | undefined },
    ) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'release-approval');
        const { total, items } = await this.deps.repository.listReleaseApprovals({
            orgIds: view.organizationIds,
            status: query.status,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return { page: query.page, limit: query.limit, total, items };
    }

    async provenance(
        principal: DashboardPrincipal,
        query: DashboardQuery & {
            page: number; limit: number;
            caseType?: string | undefined; status?: string | undefined;
        },
    ) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'nfc-tag-claim');
        const [summary, cases] = await Promise.all([
            this.deps.repository.provenanceSummary(view.organizationIds),
            this.deps.repository.listSupportCases({
                caseType: query.caseType,
                status: query.status,
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return {
            page: query.page,
            limit: query.limit,
            total: cases.total,
            summary,
            items: cases.items.map((c) => ({
                ...c,
                // Support sees masked reporters; the case body still works.
                reporterId:
                    view.access['buyer-profile']?.visibility === Visibility.FULL
                        ? c.reporterId
                        : maskId(c.reporterId),
            })),
        };
    }

    /**
     * Supply is gated on `drop:read` rather than `ops-dashboard-infra`.
     *
     * The matrix suggested the latter as a placeholder, but that resource is
     * TECHNICAL-domain — routing a business inventory section through it would
     * put technical and business data in one payload, which the domain
     * boundary forbids. Vendors and batches are upstream inventory, so the
     * catalog resource is the honest gate until a dedicated SUPPLY resource
     * exists.
     */
    async supply(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; vendorId?: string | undefined },
    ) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'drop');
        const result = await this.deps.repository.listSupplyBatches({
            vendorId: query.vendorId,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return { page: query.page, limit: query.limit, ...result };
    }

    async resale(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; status?: string | undefined },
    ) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'order');
        const result = await this.deps.repository.listResale({
            status: query.status,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total: result.total,
            counts: result.counts,
            items: result.items.map((listing) => {
                const row: Record<string, unknown> = {
                    id: listing.id,
                    skuId: listing.skuId,
                    status: listing.status,
                    createdAt: listing.createdAt.toISOString(),
                };
                if (view.canSeeMoney) {
                    row.price = money(listing.price);
                    row.currency = listing.currency;
                }
                return row;
            }),
        };
    }

    async activity(
        principal: DashboardPrincipal,
        query: DashboardQuery & { page: number; limit: number; severity?: string | undefined },
    ) {
        const { view, period } = this.prepare(principal, query);
        requireSection(view, 'audit-log');
        const { total, items } = await this.deps.repository.listActivity({
            period,
            orgIds: view.organizationIds,
            severity: query.severity,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return { page: query.page, limit: query.limit, total, items };
    }

    async demandSignals(principal: DashboardPrincipal, query: DashboardQuery) {
        const { view } = this.prepare(principal, query);
        requireSection(view, 'drop');
        return this.deps.repository.demandSignals(view.organizationIds, INVENTORY_PREVIEW_LIMIT);
    }
}

/** `u-77213f...` -> `u-7721…`; enough to correlate, not to identify. */
function maskId(id: string): string {
    return `${id.slice(0, 8)}…`;
}

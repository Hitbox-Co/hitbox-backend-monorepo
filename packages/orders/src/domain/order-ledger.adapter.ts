import type { Prisma } from '@hitbox/database';
import type { OrderWriteRepository } from '../repository/order-write.repository';

/**
 * Orders' side of the two ports other modules define over it.
 *
 * `OrderLedgerAdapter` answers payments' `IOrderLedger` (place, settle,
 * cancel, refund, sweep). `OrderRevenueAdapter` answers finance's
 * `IOrderRevenueSource` (what was this unit sold for, and what did it cost).
 * `OrderInvoicingAdapter` answers tax's `IInvoiceableOrderSource` (who bought
 * what, at what price, billed where).
 *
 * None of the three interfaces is imported here. All are structural: orders is the
 * *provider* in both relationships, and a provider that imports its consumers'
 * type definitions has the dependency arrow backwards. Bootstrap is where the
 * two shapes are checked against each other, by assignment.
 */

/** Matches `IOrderLedger` in @hitbox/payments. */
export class OrderLedgerAdapter {
    constructor(private readonly orders: OrderWriteRepository) { }

    async placeOrder(input: {
        buyerId: string;
        productId: string;
        variantId?: string | null;
        marketId?: string | null;
        quantity: number;
        holdSeconds: number;
        termsAccepted: boolean;
        shippingAddressId?: string | null;
        billingAddressId?: string | null;
    }) {
        const placed = await this.orders.placeOrder({
            buyerId: input.buyerId,
            productId: input.productId,
            variantId: input.variantId ?? null,
            marketId: input.marketId ?? null,
            quantity: input.quantity,
            holdSeconds: input.holdSeconds,
            termsAccepted: input.termsAccepted,
            shippingAddressId: input.shippingAddressId ?? null,
            billingAddressId: input.billingAddressId ?? null,
            now: new Date(),
        });

        return {
            orderId: placed.orderId,
            skuId: placed.skuId,
            reservationId: placed.reservationId,
            organizationId: placed.organizationId,
            marketId: placed.marketId,
            unitPrice: placed.unitPrice.toFixed(2),
            amount: placed.amount.toFixed(2),
            currency: placed.currency,
            costOfGoods: placed.costOfGoods?.toFixed(2) ?? null,
            expiresAt: placed.expiresAt.toISOString(),
        };
    }

    markPaid(input: { orderId: string; settledAt: Date }): Promise<boolean> {
        return this.orders.markPaid(input);
    }

    markFailed(input: { orderId: string; reason: string }): Promise<boolean> {
        return this.orders.markFailed(input);
    }

    markRefunded(input: { orderId: string; refundedAt: Date }): Promise<boolean> {
        return this.orders.markRefunded(input);
    }

    async findOrderSummary(orderId: string) {
        const order = await this.orders.findSummary(orderId);
        if (!order) return null;
        return {
            orderId: order.id,
            buyerId: order.buyerId,
            status: order.status,
            organizationId: order.organizationId,
            skuId: order.skuId,
            claimId: order.claimId,
            amount: order.amount.toFixed(2),
            currency: order.currency,
            gateway: order.gateway,
        };
    }

    releaseExpiredReservations(now: Date): Promise<number> {
        return this.orders.releaseExpiredReservations(now);
    }
}

/** Matches `IOrderRevenueSource` in @hitbox/finance. */
export class OrderRevenueAdapter {
    constructor(private readonly orders: OrderWriteRepository) { }

    async findAccruableOrderForSku(skuId: string) {
        const order = await this.orders.findAccruableOrderForSku(skuId);
        return order ? this.toSnapshot(order) : null;
    }

    async findOrderRevenue(orderId: string) {
        const order = await this.orders.findOrderRevenue(orderId);
        return order ? this.toSnapshot(order) : null;
    }

    /**
     * Picks the cost of goods that actually applies to this sale.
     *
     * A drop can carry several price rows — one per market, optionally per
     * variant — and only the row the order was priced from states the right
     * cost. Matching on both keeps a US order from being costed at the Indian
     * manufacturing figure. Null when nothing matches, which the accrual
     * treats as a zero cost and therefore a royalty on gross: worth knowing,
     * and the log says so.
     */
    private toSnapshot(order: {
        id: string;
        buyerId: string;
        status: string;
        organizationId: string | null;
        productId: string;
        variantId: string | null;
        marketId: string | null;
        quantity: number;
        amount: Prisma.Decimal;
        currency: string;
        drop: {
            collectionId: string | null;
            artistId: string | null;
            dropPrices: {
                marketId: string;
                variantId: string | null;
                costOfGoods: Prisma.Decimal | null;
            }[];
        };
    }) {
        const priceRow =
            order.drop.dropPrices.find(
                (row) => row.marketId === order.marketId && row.variantId === order.variantId,
            ) ??
            order.drop.dropPrices.find((row) => row.marketId === order.marketId) ??
            null;

        const unitCost = priceRow?.costOfGoods ?? null;

        return {
            orderId: order.id,
            status: order.status,
            buyerId: order.buyerId,
            organizationId: order.organizationId,
            productId: order.productId,
            collectionId: order.drop.collectionId,
            artistId: order.drop.artistId,
            marketId: order.marketId,
            grossRevenue: order.amount.toFixed(2),
            // Cost is per unit in the catalog; the order's gross covers
            // `quantity` of them, so the two have to be brought to the same
            // basis or the margin is wrong by a factor of the quantity.
            costOfGoods: unitCost ? unitCost.times(order.quantity).toFixed(2) : null,
            currency: order.currency,
            quantity: order.quantity,
        };
    }
}

/**
 * Matches `IInvoiceableOrderSource` in @hitbox/tax.
 *
 * Kept separate from `OrderRevenueAdapter` because the two answer different
 * questions from different callers: finance asks what the sale earned, tax asks
 * what the document should say. Only this one exposes the buyer's name and
 * billing address, so only the invoicing path ever loads them.
 */
export class OrderInvoicingAdapter {
    constructor(private readonly orders: OrderWriteRepository) { }

    async findById(orderId: string) {
        const order = await this.orders.findInvoiceableOrder(orderId);
        if (!order) return null;

        const billing = order.orderAddresss[0] ?? null;

        return {
            orderId: order.id,
            buyerId: order.buyerId,
            organizationId: order.organizationId,
            productId: order.productId,
            skuId: order.skuId,
            productName: order.drop.name,
            quantity: order.quantity,
            unitPrice: order.unitPrice.toFixed(2),
            amount: order.amount.toFixed(2),
            currency: order.currency,
            status: order.status,
            placedAt: order.placedAt,
            // The address snapshot's recipient name wins over the account's:
            // it is what the customer typed for this purchase, and it is the
            // name that belongs on their invoice.
            customerName:
                billing?.recipientName ?? order.buyer.fullName ?? order.buyer.email,
            customerEmail: order.buyer.email,
            billingAddress: billing
                ? {
                    lines: [billing.line1, billing.line2].filter(
                        (line): line is string => Boolean(line),
                    ),
                    city: billing.city,
                    state: billing.state,
                    postalCode: billing.postalCode,
                    countryCode: billing.countryCode,
                }
                : null,
        };
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { ORDERS_ERROR_CODES } from '../constants/orders.constant';

/**
 * The write side of an order's life: placing it, settling it, cancelling it,
 * refunding it, and letting go of stock it no longer holds.
 *
 * Split from `OrderRepository` (which is all reads for the admin screens)
 * because the two have almost nothing in common: this one is transactional,
 * concurrency-sensitive and driven entirely by the payments module through a
 * port, while that one is projections and pagination.
 *
 * One rule runs through everything here: **every state change is a guarded
 * `updateMany`, never an `update`.** Each of these is reachable from a webhook
 * the provider may deliver twice, from a client retrying, and from an operator
 * pressing a button — and the difference between "guarded" and "not" is the
 * difference between a no-op and a second revenue posting.
 */

/** What the catalog says about a drop at the moment someone tries to buy it. */
interface PurchasableProduct {
    id: string;
    name: string;
    status: string;
    isActive: boolean;
    archivedAt: Date | null;
    organizationId: string | null;
    releaseStart: Date | null;
    releaseEnd: Date | null;
}

export interface PlaceOrderParams {
    buyerId: string;
    productId: string;
    variantId: string | null;
    marketId: string | null;
    quantity: number;
    holdSeconds: number;
    termsAccepted: boolean;
    shippingAddressId: string | null;
    billingAddressId: string | null;
    now: Date;
}

export interface PlaceOrderResult {
    orderId: string;
    skuId: string;
    reservationId: string;
    organizationId: string | null;
    marketId: string | null;
    unitPrice: Prisma.Decimal;
    amount: Prisma.Decimal;
    currency: string;
    costOfGoods: Prisma.Decimal | null;
    expiresAt: Date;
}

export class OrderWriteRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Creates the order and holds one serialized unit for it, atomically.
     *
     * The interesting part is unit selection. A SKU is available when it is
     * active, unclaimed, not already assigned to an order, and not held by a
     * live reservation. That last condition is the race: two buyers hitting
     * checkout on the last unit of 500 will both *read* it as free. The
     * conditional `updateMany` on the reservation (create-then-verify below)
     * is what makes exactly one of them win, rather than a `SELECT … FOR
     * UPDATE` that would serialise every checkout on the drop.
     */
    async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
        const product = (await this.prisma.drop.findUnique({
            where: { id: params.productId },
            select: {
                id: true,
                name: true,
                status: true,
                isActive: true,
                archivedAt: true,
                organizationId: true,
                releaseStart: true,
                releaseEnd: true,
            },
        })) as PurchasableProduct | null;

        if (!product || !product.isActive || product.archivedAt !== null) {
            throw AppError.notFound('Drop not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        if (!['PUBLISHED', 'ACTIVE'].includes(product.status)) {
            throw AppError.badRequest(
                `This drop is not on sale (${product.status}).`,
                ORDERS_ERROR_CODES.NOT_PURCHASABLE,
                { status: product.status },
            );
        }
        if (product.releaseStart && product.releaseStart > params.now) {
            throw AppError.badRequest(
                'This drop has not opened yet.',
                ORDERS_ERROR_CODES.NOT_PURCHASABLE,
                { releaseStart: product.releaseStart.toISOString() },
            );
        }
        if (product.releaseEnd && product.releaseEnd <= params.now) {
            throw AppError.badRequest(
                'This drop has closed.',
                ORDERS_ERROR_CODES.NOT_PURCHASABLE,
                { releaseEnd: product.releaseEnd.toISOString() },
            );
        }

        // Regional pricing: fixed per market, never converted. A market the
        // drop has no price row for is not a market it is sold in, and
        // falling back to another market's number would charge someone in the
        // wrong currency.
        // Prices are versioned as of v3.1, so "the price" is the row whose
        // effective window contains `now` — newest first, because two rows can
        // legitimately share a window boundary. Before versioning this was the
        // only row the three-column unique allowed; the condition below is what
        // preserves that meaning now that history is kept alongside it.
        const price = await this.prisma.dropPrice.findFirst({
            where: {
                dropId: params.productId,
                variantId: params.variantId,
                status: 'ACTIVE',
                effectiveFrom: { lte: params.now },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: params.now } }],
                ...(params.marketId ? { marketId: params.marketId } : {}),
            },
            select: {
                amount: true,
                isFree: true,
                costOfGoods: true,
                marketId: true,
                market: { select: { id: true, currency: true } },
            },
            orderBy: [{ effectiveFrom: 'desc' }, { updatedAt: 'desc' }],
        });

        if (!price || (!price.isFree && price.amount === null)) {
            throw AppError.badRequest(
                'This drop has no price for your market.',
                ORDERS_ERROR_CODES.NO_PRICE,
                { marketId: params.marketId },
            );
        }

        const unitPrice = price.amount ?? new Prisma.Decimal(0);
        const amount = unitPrice.times(params.quantity);
        const expiresAt = new Date(params.now.getTime() + params.holdSeconds * 1000);

        return this.prisma.$transaction(async (tx) => {
            // A unit nobody else holds. `orders: { none: {} }` covers units
            // already allocated; the reservation clause covers units mid-
            // checkout. Ordered by serial so the lowest available number goes
            // out first, which is what buyers expect of a numbered edition.
            const sku = await tx.sku.findFirst({
                where: {
                    productId: params.productId,
                    ...(params.variantId ? { variantId: params.variantId } : {}),
                    isActive: true,
                    archivedAt: null,
                    claimedStatus: 'UNCLAIMED',
                    resaleBlocked: false,
                    orders: { none: {} },
                    inventoryReservations: {
                        none: {
                            OR: [
                                { status: 'COMMITTED' },
                                { status: 'HELD', expiresAt: { gt: params.now } },
                            ],
                        },
                    },
                },
                select: { id: true },
                orderBy: { serialNumber: 'asc' },
            });

            if (!sku) {
                throw AppError.conflict(
                    'Every unit of this drop is sold or being bought right now.',
                    ORDERS_ERROR_CODES.OUT_OF_STOCK,
                );
            }

            const orderId = randomUUID();
            await tx.order.create({
                data: {
                    id: orderId,
                    buyerId: params.buyerId,
                    productId: params.productId,
                    variantId: params.variantId,
                    // Left null until settlement: the order does not own a
                    // unit while it is only holding one.
                    skuId: null,
                    quantity: params.quantity,
                    organizationId: product.organizationId,
                    marketId: price.marketId,
                    status: 'PENDING_PAYMENT',
                    unitPrice,
                    amount,
                    currency: price.market.currency,
                    gateway: 'STRIPE',
                    termsAcceptedAt: params.termsAccepted ? params.now : null,
                    placedAt: params.now,
                    updatedAt: params.now,
                },
            });

            const reservationId = randomUUID();
            await tx.inventoryReservation.create({
                data: {
                    id: reservationId,
                    orderId,
                    skuId: sku.id,
                    status: 'HELD',
                    expiresAt,
                    createdAt: params.now,
                },
            });

            // Verify we are the only live hold on this unit. Two concurrent
            // checkouts both pass the SELECT above; both insert; exactly one
            // of them sees a count of 1 here and the other aborts its own
            // transaction. Cheaper than locking the whole drop, and correct.
            const liveHolds = await tx.inventoryReservation.count({
                where: {
                    skuId: sku.id,
                    OR: [
                        { status: 'COMMITTED' },
                        { status: 'HELD', expiresAt: { gt: params.now } },
                    ],
                },
            });
            if (liveHolds > 1) {
                throw AppError.conflict(
                    'Someone else took this unit a moment ago. Try again.',
                    ORDERS_ERROR_CODES.OUT_OF_STOCK,
                );
            }

            await this.snapshotAddresses(tx, {
                orderId,
                buyerId: params.buyerId,
                shippingAddressId: params.shippingAddressId,
                billingAddressId: params.billingAddressId,
                now: params.now,
            });

            return {
                orderId,
                skuId: sku.id,
                reservationId,
                organizationId: product.organizationId,
                marketId: price.marketId,
                unitPrice,
                amount,
                currency: price.market.currency,
                costOfGoods: price.costOfGoods,
                expiresAt,
            };
        });
    }

    /**
     * Settlement. Guarded on PENDING_PAYMENT, so the second delivery of the
     * same webhook returns false instead of re-committing stock.
     *
     * Returns false too when the hold has already expired and the unit is
     * gone — the caller parks the transaction for a human rather than
     * pretending the order shipped.
     */
    async markPaid(input: { orderId: string; settledAt: Date }): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            const reservation = await tx.inventoryReservation.findFirst({
                where: { orderId: input.orderId, status: { in: ['HELD', 'COMMITTED'] } },
                orderBy: { createdAt: 'desc' },
            });
            if (!reservation) return false;

            const committed = await tx.inventoryReservation.updateMany({
                where: { id: reservation.id, status: { in: ['HELD', 'COMMITTED'] } },
                data: { status: 'COMMITTED' },
            });
            if (committed.count === 0) return false;

            const updated = await tx.order.updateMany({
                where: { id: input.orderId, status: 'PENDING_PAYMENT' },
                data: {
                    status: 'PAID',
                    skuId: reservation.skuId,
                    updatedAt: input.settledAt,
                },
            });
            return updated.count > 0;
        });
    }

    /** Payment failed or was abandoned: cancel the order, free the unit. */
    async markFailed(input: { orderId: string; reason: string }): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            const updated = await tx.order.updateMany({
                where: { id: input.orderId, status: 'PENDING_PAYMENT' },
                data: {
                    status: 'CANCELLED',
                    trackingNote: input.reason.slice(0, 500),
                    updatedAt: new Date(),
                },
            });
            // The hold is released either way. An order that was already
            // cancelled still must not keep a unit off sale.
            await tx.inventoryReservation.updateMany({
                where: { orderId: input.orderId, status: 'HELD' },
                data: { status: 'RELEASED' },
            });
            return updated.count > 0;
        });
    }

    /**
     * Refunded.
     *
     * The reservation is deliberately **not** released: the unit physically
     * went to the buyer and came back, and whether it may be sold again is a
     * decision the refund workflow makes from the returned tag's condition,
     * not something to infer from the money having moved.
     */
    async markRefunded(input: { orderId: string; refundedAt: Date }): Promise<boolean> {
        const updated = await this.prisma.order.updateMany({
            where: {
                id: input.orderId,
                status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
            },
            data: { status: 'REFUNDED', updatedAt: input.refundedAt },
        });
        return updated.count > 0;
    }

    /**
     * Links the claim that took ownership of this order's unit.
     *
     * Called from the claims event, and it is what makes "paid on day 1,
     * claimed on day 6" visible on the order itself. Guarded on `claimId:
     * null` so a re-delivered event does not overwrite the first claim with a
     * later one.
     */
    async linkClaim(input: {
        skuId: string;
        claimId: string;
        claimedAt: Date;
    }): Promise<string | null> {
        const order = await this.prisma.order.findFirst({
            where: { skuId: input.skuId, claimId: null },
            select: { id: true },
            orderBy: { placedAt: 'desc' },
        });
        if (!order) return null;

        const updated = await this.prisma.order.updateMany({
            where: { id: order.id, claimId: null },
            data: { claimId: input.claimId, claimedAt: input.claimedAt },
        });
        return updated.count > 0 ? order.id : null;
    }

    /** The sweeper: every hold past its expiry goes back on sale. */
    async releaseExpiredReservations(now: Date): Promise<number> {
        const result = await this.prisma.inventoryReservation.updateMany({
            where: { status: 'HELD', expiresAt: { lte: now } },
            data: { status: 'RELEASED' },
        });
        return result.count;
    }

    /** The money facts a refund, a dispute or an accrual needs. */
    findSummary(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                status: true,
                organizationId: true,
                marketId: true,
                skuId: true,
                claimId: true,
                productId: true,
                variantId: true,
                quantity: true,
                amount: true,
                currency: true,
                gateway: true,
                drop: { select: { collectionId: true, artistId: true } },
            },
        });
    }

    /**
     * The settled order behind a serialized unit, with its cost of goods.
     *
     * Reaches `drop.dropPrices` — two hops into another module's
     * partial. The same documented shortcut collections takes through
     * `sku.drop`, and for the same reason: COGS lives on the price row, the
     * accrual needs it, and a port for one decimal would be ceremony. On
     * extraction this hop becomes a call to the catalog service.
     */
    findAccruableOrderForSku(skuId: string) {
        return this.prisma.order.findFirst({
            where: {
                skuId,
                status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
            },
            select: {
                id: true,
                buyerId: true,
                status: true,
                organizationId: true,
                productId: true,
                variantId: true,
                marketId: true,
                quantity: true,
                amount: true,
                currency: true,
                drop: {
                    select: {
                        collectionId: true,
                        artistId: true,
                        dropPrices: {
                            where: { status: 'ACTIVE' },
                            select: {
                                marketId: true,
                                variantId: true,
                                costOfGoods: true,
                            },
                        },
                    },
                },
            },
            orderBy: { placedAt: 'desc' },
        });
    }

    findOrderRevenue(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                status: true,
                organizationId: true,
                productId: true,
                variantId: true,
                marketId: true,
                quantity: true,
                amount: true,
                currency: true,
                drop: {
                    select: {
                        collectionId: true,
                        artistId: true,
                        dropPrices: {
                            where: { status: 'ACTIVE' },
                            select: {
                                marketId: true,
                                variantId: true,
                                costOfGoods: true,
                            },
                        },
                    },
                },
            },
        });
    }

    /**
     * Everything the tax module needs to raise the invoice for one order.
     *
     * A separate query from `findOrderRevenue` on purpose: an invoice needs the
     * buyer's name, e-mail and **billing** address, which a royalty accrual has
     * no business loading. Keeping them apart means the accrual path never
     * pulls a customer's postal address into memory.
     */
    findInvoiceableOrder(orderId: string) {
        return this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                buyerId: true,
                status: true,
                organizationId: true,
                productId: true,
                skuId: true,
                quantity: true,
                unitPrice: true,
                amount: true,
                currency: true,
                placedAt: true,
                drop: { select: { name: true } },
                buyer: { select: { fullName: true, email: true } },
                orderAddresss: {
                    // Billing, and only billing: the invoice states where the
                    // customer is taxed, which is not necessarily where the
                    // parcel went.
                    where: { usage: 'BILLING' },
                    select: {
                        recipientName: true,
                        line1: true,
                        line2: true,
                        city: true,
                        state: true,
                        postalCode: true,
                        countryCode: true,
                    },
                },
            },
        });
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Copies the buyer's chosen addresses onto the order.
     *
     * A copy, not a reference: an order must always show where it was actually
     * sent, even after the buyer edits or deletes the address book entry. The
     * address is silently skipped if it is not the buyer's own — an id from
     * another user's book is not an error worth failing a checkout over, it is
     * a request that gets nothing.
     */
    private async snapshotAddresses(
        tx: Prisma.TransactionClient,
        input: {
            orderId: string;
            buyerId: string;
            shippingAddressId: string | null;
            billingAddressId: string | null;
            now: Date;
        },
    ): Promise<void> {
        const wanted: { id: string; usage: 'SHIPPING' | 'BILLING' }[] = [];
        if (input.shippingAddressId) {
            wanted.push({ id: input.shippingAddressId, usage: 'SHIPPING' });
        }
        if (input.billingAddressId) {
            wanted.push({ id: input.billingAddressId, usage: 'BILLING' });
        }
        if (wanted.length === 0) return;

        for (const entry of wanted) {
            const address = await tx.address.findFirst({
                where: { id: entry.id, userId: input.buyerId },
            });
            if (!address) continue;

            await tx.orderAddress.create({
                data: {
                    id: randomUUID(),
                    orderId: input.orderId,
                    usage: entry.usage,
                    sourceAddressId: address.id,
                    label: address.label,
                    labelCustom: address.labelCustom,
                    recipientName: address.recipientName,
                    line1: address.line1,
                    line2: address.line2,
                    city: address.city,
                    state: address.state,
                    postalCode: address.postalCode,
                    countryCode: address.countryCode,
                    phone: address.phone,
                    createdAt: input.now,
                },
            });
        }
    }
}

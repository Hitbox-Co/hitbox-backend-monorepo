import type { Prisma, PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { ORDERS_ERROR_CODES, UNIT_ASSIGNABLE_STATUSES } from '../constants/orders.constant';
import type { FulfilmentQueueQuery } from '../dto/order-fulfilment.dto';
import { recordStatusChange } from './order-history';
import { lockSku } from './sku-lock';

/**
 * Scan-to-assign: matching a placed order to the physical unit that goes into
 * its parcel. docs/orders/order-unit-assignment-api.md.
 *
 * At checkout, `placeOrder` holds the lowest free serial of the variant — a
 * PLACEHOLDER that guarantees stock, not a promise of that physical item.
 * Packers can't find tag #123 among 500 identical shirts, so at packing they
 * take any matching shirt and scan it; this repository moves the order's hold
 * from the placeholder to the scanned unit and confirms it, in one
 * transaction. The placeholder goes straight back into stock.
 *
 * Reaches `Sku` directly, the same documented shortcut `placeOrder` already
 * takes: availability is defined in terms of orders and reservations, which
 * this module owns.
 */

const fulfilmentSelect = {
    id: true,
    publicCode: true,
    status: true,
    organizationId: true,
    productId: true,
    variantId: true,
    skuId: true,
    unitAssignedAt: true,
    unitAssignedById: true,
    placedAt: true,
    drop: { select: { groupCode: true, name: true } },
    variant: { select: { label: true, variantCode: true } },
    sku: { select: { id: true, skuCode: true, serialNumber: true, tagId: true, variantId: true } },
    inventoryReservations: {
        where: { status: 'COMMITTED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
            id: true,
            skuId: true,
            sku: { select: { id: true, skuCode: true, serialNumber: true, tagId: true, variantId: true } },
        },
    },
} satisfies Prisma.OrderSelect;

export type FulfilmentOrderRow = Prisma.OrderGetPayload<{ select: typeof fulfilmentSelect }>;

const unitSelect = {
    id: true,
    skuCode: true,
    serialNumber: true,
    tagId: true,
    productId: true,
    variantId: true,
    isActive: true,
    archivedAt: true,
    claimedStatus: true,
    resaleBlocked: true,
    tagLifecycleState: true,
} satisfies Prisma.SkuSelect;

export type ScannedUnitRow = Prisma.SkuGetPayload<{ select: typeof unitSelect }>;

/** A live hold — the same definition `placeOrder` uses. */
const liveHold = (now: Date): Prisma.InventoryReservationWhereInput => ({
    OR: [{ status: 'COMMITTED' }, { status: 'HELD', expiresAt: { gt: now } }],
});

/**
 * A unit a packer may put in a parcel, by every rule a scan checks
 * (`unshippableReason` plus "free"): live, unclaimed, not blocked, tag bound
 * and BOUND, and on no order and no live hold. Used to list what to pick, so
 * the list can never offer a unit the scan will then refuse.
 */
const packableWhere: Prisma.SkuWhereInput = {
    isActive: true,
    archivedAt: null,
    claimedStatus: 'UNCLAIMED',
    resaleBlocked: false,
    tagId: { not: null },
    tagLifecycleState: 'BOUND',
};

const freeWhere = (now: Date): Prisma.SkuWhereInput => ({
    orders: { none: {} },
    inventoryReservations: { none: liveHold(now) },
});

/** Orders waiting for a packer: paid, holding stock, no confirmed unit yet. */
const waitingWhere = (organizationIds: string[] | null): Prisma.OrderWhereInput => ({
    status: { in: [...UNIT_ASSIGNABLE_STATUSES] },
    unitAssignedAt: null,
    archivedAt: null,
    inventoryReservations: { some: { status: 'COMMITTED' } },
    ...(organizationIds === null ? {} : { organizationId: { in: organizationIds } }),
});

export class OrderFulfilmentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findOrder(orderId: string): Promise<FulfilmentOrderRow | null> {
        return this.prisma.order.findUnique({ where: { id: orderId }, select: fulfilmentSelect });
    }

    findUnit(scan: { tagId?: string; skuCode?: string; serialNumber?: number; productId?: string }) {
        if (scan.tagId) return this.prisma.sku.findUnique({ where: { tagId: scan.tagId }, select: unitSelect });
        if (scan.skuCode) return this.prisma.sku.findUnique({ where: { skuCode: scan.skuCode }, select: unitSelect });
        if (scan.serialNumber !== undefined && scan.productId) {
            return this.prisma.sku.findUnique({
                where: { productId_serialNumber: { productId: scan.productId, serialNumber: scan.serialNumber } },
                select: unitSelect,
            });
        }
        return Promise.resolve(null);
    }

    /**
     * Who already has this unit, if anyone: the order it was sold on, or the
     * order whose live hold is on it. Read outside the swap transaction to
     * explain a refusal; the transaction re-checks and stays the authority.
     */
    async unitHolder(
        skuId: string,
        now: Date,
    ): Promise<{ reason: 'SOLD' | 'HELD'; orderId: string | null; orderPublicCode: string | null; orderStatus: string | null } | null> {
        const sold = await this.prisma.order.findFirst({
            where: { skuId },
            orderBy: { placedAt: 'desc' },
            select: { id: true, publicCode: true, status: true },
        });
        if (sold) {
            return { reason: 'SOLD', orderId: sold.id, orderPublicCode: sold.publicCode, orderStatus: sold.status };
        }
        const hold = await this.prisma.inventoryReservation.findFirst({
            where: { skuId, ...liveHold(now) },
            select: { order: { select: { id: true, publicCode: true, status: true } } },
        });
        if (!hold) return null;
        return {
            reason: 'HELD',
            orderId: hold.order.id,
            orderPublicCode: hold.order.publicCode,
            orderStatus: hold.order.status,
        };
    }

    /**
     * Units that would pass a scan for this order: the right drop (and
     * variant, when the order has one), packable, and free — or the unit
     * already held for this order (its placeholder, or its confirmed unit).
     */
    async candidates(input: {
        productId: string;
        variantId: string | null;
        heldSkuId: string;
        search?: string | undefined;
        skip: number;
        take: number;
        now: Date;
    }): Promise<{ total: number; items: { id: string; skuCode: string; serialNumber: number; tagId: string | null; variantId: string | null }[] }> {
        const serial = input.search && /^\d+$/.test(input.search) ? Number(input.search) : undefined;
        const where: Prisma.SkuWhereInput = {
            productId: input.productId,
            ...(input.variantId !== null ? { variantId: input.variantId } : {}),
            ...packableWhere,
            AND: [
                { OR: [{ id: input.heldSkuId }, freeWhere(input.now)] },
                ...(input.search
                    ? [{
                        OR: [
                            { skuCode: { contains: input.search, mode: 'insensitive' as const } },
                            ...(serial !== undefined ? [{ serialNumber: serial }] : []),
                        ],
                    }]
                    : []),
            ],
        };
        const [total, items] = await Promise.all([
            this.prisma.sku.count({ where }),
            this.prisma.sku.findMany({
                where,
                select: { id: true, skuCode: true, serialNumber: true, tagId: true, variantId: true },
                orderBy: { serialNumber: 'asc' },
                skip: input.skip,
                take: input.take,
            }),
        ]);
        return { total, items };
    }

    async queue(
        query: FulfilmentQueueQuery,
        organizationIds: string[] | null,
    ): Promise<{ total: number; items: FulfilmentOrderRow[] }> {
        const where: Prisma.OrderWhereInput = {
            ...waitingWhere(organizationIds),
            ...(query.productId ? { productId: query.productId } : {}),
            ...(query.variantId ? { variantId: query.variantId } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                select: fulfilmentSelect,
                // First come, first packed.
                orderBy: { placedAt: 'asc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    /** The oldest order waiting for a unit of this drop/variant — for scan-first packing. */
    findOldestWaiting(input: {
        productId: string;
        variantId: string | null;
        organizationIds: string[] | null;
    }): Promise<{ id: string } | null> {
        return this.prisma.order.findFirst({
            where: {
                ...waitingWhere(input.organizationIds),
                productId: input.productId,
                variantId: input.variantId,
            },
            select: { id: true },
            orderBy: { placedAt: 'asc' },
        });
    }

    /**
     * Moves the order's hold onto `toSkuId` and confirms it — one transaction.
     *
     *  1. `toSkuId` must be free by the same rule checkout uses: on no order,
     *     held by no live reservation. Checked inside the transaction.
     *  2. The order's reservation is moved from the placeholder to the scanned
     *     unit (guarded on its current unit, so a concurrent swap fails).
     *  3. The order gets the scanned unit and the confirmation stamp, and moves
     *     PAID → PROCESSING (guarded on the status and unit we read).
     *  4. Verify: exactly one live hold and one order now point at the scanned
     *     unit. Two packers who scanned the same shirt both pass step 1; one of
     *     them fails here and its whole transaction rolls back.
     *
     * The placeholder needs no write: with no reservation and no order on it,
     * it is available again by definition.
     */
    async assign(input: {
        orderId: string;
        reservationId: string;
        fromSkuId: string;
        toSkuId: string;
        expectedStatus: string;
        expectedOrderSkuId: string | null;
        actorId: string;
        now: Date;
    }): Promise<{ statusChanged: boolean }> {
        const conflict = () =>
            AppError.conflict(
                'This order or this unit changed while you were scanning (another packer?). Reload and scan again.',
                ORDERS_ERROR_CODES.ASSIGN_CONFLICT,
            );

        return this.prisma.$transaction(
            async (tx) => {
                if (input.toSkuId !== input.fromSkuId) {
                    // Same lock as checkout and settlement (sku-lock.ts).
                    await lockSku(tx, input.toSkuId);
                    const free = await tx.sku.findFirst({
                        where: {
                            id: input.toSkuId,
                            orders: { none: {} },
                            inventoryReservations: { none: liveHold(input.now) },
                        },
                        select: { id: true },
                    });
                    if (!free) {
                        throw AppError.conflict(
                            'That unit is already sold or held for another order. Scan a different one.',
                            ORDERS_ERROR_CODES.UNIT_UNAVAILABLE,
                        );
                    }

                    const moved = await tx.inventoryReservation.updateMany({
                        where: { id: input.reservationId, skuId: input.fromSkuId, status: 'COMMITTED' },
                        data: { skuId: input.toSkuId },
                    });
                    if (moved.count === 0) throw conflict();
                }

                const statusChanged = input.expectedStatus === 'PAID';
                const updated = await tx.order.updateMany({
                    where: {
                        id: input.orderId,
                        status: input.expectedStatus as never,
                        skuId: input.expectedOrderSkuId,
                    },
                    data: {
                        skuId: input.toSkuId,
                        unitAssignedAt: input.now,
                        unitAssignedById: input.actorId,
                        ...(statusChanged ? { status: 'PROCESSING' } : {}),
                        updatedAt: input.now,
                    },
                });
                if (updated.count === 0) throw conflict();
                if (statusChanged) {
                    await recordStatusChange(tx, {
                        orderId: input.orderId, from: 'PAID', to: 'PROCESSING', source: 'PACKING',
                        actorId: input.actorId, reason: 'Unit scanned and assigned at packing',
                        metadata: { skuId: input.toSkuId }, at: input.now,
                    });
                }

                const [holds, orders] = await Promise.all([
                    tx.inventoryReservation.count({ where: { skuId: input.toSkuId, ...liveHold(input.now) } }),
                    tx.order.count({ where: { skuId: input.toSkuId } }),
                ]);
                if (holds !== 1 || orders !== 1) throw conflict();

                return { statusChanged };
            },
            // Same figures as placeOrder / minting: remote round trips add up.
            { maxWait: 10_000, timeout: 20_000 },
        );
    }
}

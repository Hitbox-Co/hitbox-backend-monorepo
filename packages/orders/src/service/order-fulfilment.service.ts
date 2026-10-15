import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    ORDER_EVENTS,
    ORDERS_ERROR_CODES,
    UNIT_ASSIGNABLE_STATUSES,
} from '../constants/orders.constant';
import type {
    AssignByScanDto,
    AssignUnitDto,
    FulfilmentQueueQuery,
    FulfilmentUnit,
    OrderFulfilment,
} from '../dto/order-fulfilment.dto';
import type {
    FulfilmentOrderRow,
    OrderFulfilmentRepository,
    ScannedUnitRow,
} from '../repository/order-fulfilment.repository';

/** Who is scanning, and which organizations' orders they may touch. */
export interface FulfilmentCaller {
    userId: string;
    /** null = unrestricted (platform staff). */
    organizationIds: string[] | null;
}

interface OrderFulfilmentServiceDeps {
    fulfilment: OrderFulfilmentRepository;
    eventBus: IEventBus;
    logger: Logger;
}

function toUnit(sku: FulfilmentOrderRow['sku']): FulfilmentUnit | null {
    if (!sku) return null;
    return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialNumber: sku.serialNumber,
        tagId: sku.tagId,
        variantId: sku.variantId,
    };
}

export function toFulfilment(row: FulfilmentOrderRow): OrderFulfilment {
    const hold = row.inventoryReservations[0] ?? null;
    const assigned = row.unitAssignedAt !== null;
    const unitState: OrderFulfilment['unitState'] = assigned ? 'ASSIGNED' : hold ? 'PROVISIONAL' : 'NONE';
    return {
        orderId: row.id,
        publicCode: row.publicCode,
        status: row.status,
        productId: row.productId,
        productCode: row.drop.groupCode,
        productName: row.drop.name,
        variantId: row.variantId,
        variantLabel: row.variant?.label ?? null,
        variantCode: row.variant?.variantCode ?? null,
        unitState,
        // Confirmed → the order's unit. Provisional → the placeholder hold.
        unit: assigned ? toUnit(row.sku) : toUnit(hold?.sku ?? null),
        unitAssignedAt: row.unitAssignedAt?.toISOString() ?? null,
        unitAssignedById: row.unitAssignedById,
        readyToShip: assigned && row.status === 'PROCESSING',
        placedAt: row.placedAt.toISOString(),
    };
}

/**
 * Scan-to-assign at packing — docs/orders/order-unit-assignment-api.md.
 *
 * Checkout holds *a* unit of the variant (a placeholder that guarantees
 * stock). Packing decides *which* physical unit: the packer takes any matching
 * item and scans it, and the order is bound to exactly that tag.
 */
export class OrderFulfilmentService {
    constructor(private readonly deps: OrderFulfilmentServiceDeps) { }

    async queue(
        query: FulfilmentQueueQuery,
        caller: FulfilmentCaller,
    ): Promise<{ page: number; limit: number; total: number; items: OrderFulfilment[] }> {
        const { total, items } = await this.deps.fulfilment.queue(query, caller.organizationIds);
        return { page: query.page, limit: query.limit, total, items: items.map(toFulfilment) };
    }

    async get(orderId: string, caller: FulfilmentCaller): Promise<OrderFulfilment> {
        return toFulfilment(await this.requireInScope(orderId, caller));
    }

    /** Order first: the packer opened this order, then scanned an item for it. */
    async assign(orderId: string, dto: AssignUnitDto, caller: FulfilmentCaller): Promise<OrderFulfilment> {
        const order = await this.requireInScope(orderId, caller);
        const unit = await this.deps.fulfilment.findUnit({
            ...(dto.tagId !== undefined && { tagId: dto.tagId }),
            ...(dto.skuCode !== undefined && { skuCode: dto.skuCode }),
            ...(dto.serialNumber !== undefined && { serialNumber: dto.serialNumber, productId: order.productId }),
        });
        return this.assignUnit(order, unit, dto.replace, caller);
    }

    /**
     * Scan first: the packer scans an item and the server picks the order —
     * the oldest one waiting for exactly that drop and variant.
     */
    async assignByScan(
        dto: AssignByScanDto,
        caller: FulfilmentCaller,
    ): Promise<OrderFulfilment> {
        const unit = await this.deps.fulfilment.findUnit({
            ...(dto.tagId !== undefined && { tagId: dto.tagId }),
            ...(dto.skuCode !== undefined && { skuCode: dto.skuCode }),
        });
        if (!unit) throw this.unitNotFound();

        const waiting = await this.deps.fulfilment.findOldestWaiting({
            productId: unit.productId,
            variantId: unit.variantId,
            organizationIds: caller.organizationIds,
        });
        if (!waiting) {
            throw AppError.notFound(
                `No paid order is waiting for this item (${unit.skuCode}). Put it back on the shelf.`,
                ORDERS_ERROR_CODES.NO_WAITING_ORDER,
            );
        }
        const order = await this.requireInScope(waiting.id, caller);
        return this.assignUnit(order, unit, false, caller);
    }

    // ── The rules ───────────────────────────────────────────────────────────

    private async assignUnit(
        order: FulfilmentOrderRow,
        unit: ScannedUnitRow | null,
        replace: boolean,
        caller: FulfilmentCaller,
    ): Promise<OrderFulfilment> {
        if (!(UNIT_ASSIGNABLE_STATUSES as readonly string[]).includes(order.status)) {
            throw AppError.badRequest(
                `A unit can be assigned only to a PAID or PROCESSING order; this one is ${order.status}.`,
                ORDERS_ERROR_CODES.NOT_ASSIGNABLE,
                { status: order.status },
            );
        }
        const hold = order.inventoryReservations[0];
        if (!hold) {
            throw AppError.badRequest(
                'This order holds no stock, so there is nothing to assign a unit to.',
                ORDERS_ERROR_CODES.NOT_ASSIGNABLE,
            );
        }
        if (!unit) throw this.unitNotFound();

        // Scanning the unit that is already confirmed: a double scan, not an error.
        if (order.unitAssignedAt !== null && order.skuId === unit.id) {
            return toFulfilment(order);
        }
        if (order.unitAssignedAt !== null && !replace) {
            throw AppError.conflict(
                `This order already has ${order.sku?.skuCode ?? 'a unit'} assigned. ` +
                'Send replace: true to swap it for the one you scanned.',
                ORDERS_ERROR_CODES.UNIT_ALREADY_ASSIGNED,
                { assignedSkuCode: order.sku?.skuCode ?? null },
            );
        }

        // Right item?
        if (unit.productId !== order.productId || (order.variantId !== null && unit.variantId !== order.variantId)) {
            throw AppError.badRequest(
                `Wrong item: this order is for ${order.variant?.label ?? order.drop.name}, ` +
                `and the scanned unit (${unit.skuCode}) is not.`,
                ORDERS_ERROR_CODES.WRONG_ITEM,
                {
                    expected: { productId: order.productId, variantId: order.variantId },
                    scanned: { productId: unit.productId, variantId: unit.variantId, skuCode: unit.skuCode },
                },
            );
        }

        // Shippable?
        const problem = unshippableReason(unit);
        if (problem) {
            throw AppError.badRequest(
                `${unit.skuCode} can't be shipped: ${problem}. Set it aside and scan another.`,
                ORDERS_ERROR_CODES.UNIT_UNAVAILABLE,
                { skuCode: unit.skuCode },
            );
        }

        const now = new Date();
        const { statusChanged } = await this.deps.fulfilment.assign({
            orderId: order.id,
            reservationId: hold.id,
            fromSkuId: hold.skuId,
            toSkuId: unit.id,
            expectedStatus: order.status,
            expectedOrderSkuId: order.skuId,
            actorId: caller.userId,
            now,
        });

        await this.deps.eventBus.publish(ORDER_EVENTS.UNIT_ASSIGNED, {
            orderId: order.id,
            skuId: unit.id,
            skuCode: unit.skuCode,
            previousSkuId: hold.skuId === unit.id ? null : hold.skuId,
            replaced: order.unitAssignedAt !== null,
            actorId: caller.userId,
        });
        if (statusChanged) {
            await this.deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
                orderId: order.id,
                from: order.status,
                to: 'PROCESSING',
                actorId: caller.userId,
                reason: 'Unit scanned and assigned at packing',
            });
        }
        this.deps.logger.info(
            { orderId: order.id, skuId: unit.id, from: hold.skuId, actorId: caller.userId },
            'order unit assigned',
        );

        return toFulfilment((await this.deps.fulfilment.findOrder(order.id))!);
    }

    /** Missing and out-of-scope look the same (404), so ids can't be probed. */
    private async requireInScope(orderId: string, caller: FulfilmentCaller): Promise<FulfilmentOrderRow> {
        const order = await this.deps.fulfilment.findOrder(orderId);
        const visible =
            order !== null &&
            (caller.organizationIds === null ||
                (order.organizationId !== null && caller.organizationIds.includes(order.organizationId)));
        if (!visible) throw AppError.notFound('Order not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        return order;
    }

    private unitNotFound(): AppError {
        return AppError.notFound(
            'No unit matches that scan. Check the tag or code and try again.',
            ORDERS_ERROR_CODES.UNIT_NOT_FOUND,
        );
    }
}

/**
 * Why a physical unit must not go into a parcel, or null if it may.
 * Availability (sold / held elsewhere) is checked inside the transaction.
 */
export function unshippableReason(unit: ScannedUnitRow): string | null {
    if (unit.archivedAt !== null) return 'it is archived';
    if (!unit.isActive) return 'it is deactivated';
    if (unit.claimedStatus !== 'UNCLAIMED') return 'it has already been claimed by a buyer';
    if (unit.resaleBlocked) return 'it is blocked';
    if (!unit.tagId) return 'it has no NFC tag bound, so the buyer could never claim it';
    if (unit.tagLifecycleState !== 'BOUND') return `its tag is ${unit.tagLifecycleState}, not BOUND`;
    return null;
}

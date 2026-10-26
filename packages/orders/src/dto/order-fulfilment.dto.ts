import { z } from 'zod';
import { ORDERS_DEFAULT_LIMIT, ORDERS_MAX_LIMIT } from '../constants/orders.constant';

/**
 * Request schemas for scan-to-assign at packing.
 * See docs/orders/order-unit-assignment-api.md.
 *
 * A unit is identified by what the packer can scan:
 *  - `tagId`        — the NFC tag UID, read by tapping the tag;
 *  - `skuCode`      — the printed code on the hang tag (`123456780000-000214`);
 *  - `serialNumber` — the printed edition number (`214`), only together with
 *                     an order, because a serial is unique per drop only.
 * Exactly one per request.
 */

const scanFields = {
    tagId: z.string().trim().min(1).max(128).optional(),
    skuCode: z.string().trim().min(1).max(64).optional(),
    serialNumber: z.coerce.number().int().positive().optional(),
};

const exactlyOne = (value: { tagId?: unknown; skuCode?: unknown; serialNumber?: unknown }) =>
    [value.tagId, value.skuCode, value.serialNumber].filter((v) => v !== undefined).length === 1;

const booleanish = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/** POST /admin/orders/:orderId/unit */
export const assignUnitSchema = z
    .object({
        ...scanFields,
        /**
         * The order already has a confirmed unit and this scan should replace
         * it (wrong shirt packed, damage found). Without it a second scan is
         * refused, so a stray scan can't silently swap a parcel's contents.
         */
        replace: booleanish.default(false),
    })
    .strict()
    .refine(exactlyOne, { message: 'Provide exactly one of tagId, skuCode or serialNumber' });
export type AssignUnitDto = z.infer<typeof assignUnitSchema>;

/**
 * POST /admin/orders/assign-by-scan — scan first, the server picks the order.
 * `serialNumber` is not accepted here: without an order it is ambiguous.
 */
export const assignByScanSchema = z
    .object({
        tagId: scanFields.tagId,
        skuCode: scanFields.skuCode,
    })
    .strict()
    .refine((v) => (v.tagId === undefined) !== (v.skuCode === undefined), {
        message: 'Provide exactly one of tagId or skuCode',
    });
export type AssignByScanDto = z.infer<typeof assignByScanSchema>;

/** GET /admin/orders/fulfilment-queue */
export const fulfilmentQueueQuerySchema = z.object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(ORDERS_MAX_LIMIT).default(ORDERS_DEFAULT_LIMIT),
});
export type FulfilmentQueueQuery = z.infer<typeof fulfilmentQueueQuerySchema>;

/** One physical unit, as the packing screen shows it. */
export interface FulfilmentUnit {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    tagId: string | null;
    variantId: string | null;
}

/** An order's fulfilment state — the packing screen. */
export interface OrderFulfilment {
    orderId: string;
    publicCode: string | null;
    status: string;
    productId: string;
    productCode: string;
    productName: string;
    variantId: string | null;
    variantLabel: string | null;
    variantCode: string | null;
    /**
     * `ASSIGNED`    — a packer scanned a unit and it was confirmed; ready to ship.
     * `PROVISIONAL` — stock is held for the order, but no physical unit has
     *                 been scanned yet. `unit` is the placeholder held at
     *                 checkout and is NOT necessarily the item that will ship.
     * `NONE`        — nothing held (unpaid, cancelled, or the hold lapsed).
     */
    unitState: 'ASSIGNED' | 'PROVISIONAL' | 'NONE';
    unit: FulfilmentUnit | null;
    unitAssignedAt: string | null;
    unitAssignedById: string | null;
    /** True when the order can move to SHIPPED. */
    readyToShip: boolean;
    placedAt: string;
}

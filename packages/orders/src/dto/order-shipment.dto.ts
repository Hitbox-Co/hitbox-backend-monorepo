import { z } from 'zod';

/**
 * Shipments and tracking — docs/orders/order-history-and-shipments.md.
 *
 * No carrier integration: the warehouse ships with whichever carrier it uses
 * and types what the carrier gave it. So the validation here is about typos
 * and safety, not about any one carrier's format.
 */

/** "1Z 999 AA1 01" → "1Z999AA101". Carriers print numbers with spaces; nobody types them back with the same ones. */
const trackingNumber = z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(
        z
            .string()
            .regex(/^[A-Za-z0-9-]{4,40}$/, 'A tracking number is 4–40 letters, digits or dashes.'),
    );

/**
 * The carrier's tracking page for this parcel, copied from the carrier.
 * https only — this link is shown to the buyer, so a `javascript:` or plain
 * http URL is a phishing vector, not a convenience.
 */
const trackingUrl = z
    .string()
    .trim()
    .url('Paste the full tracking link, starting with https://')
    .max(500)
    .refine((value) => value.startsWith('https://'), 'The tracking link must start with https://');

export const recordShipmentSchema = z.object({
    /** Free text — whatever carrier was used ("Delhivery", "Royal Mail", "DHL Express"). */
    carrierName: z.string().trim().min(2).max(60),
    trackingNumber,
    trackingUrl: trackingUrl.optional(),
    /** Internal; never shown to the buyer. */
    note: z.string().trim().max(500).optional(),
    /**
     * The same carrier + number is already on another order — almost always a
     * paste from the wrong row. Set true only when it really is one parcel
     * for two orders.
     */
    allowDuplicate: z.boolean().default(false),
});
export type RecordShipmentDto = z.infer<typeof recordShipmentSchema>;

/** Correct the tracking on a shipped order: the old shipment is voided, never edited. */
export const replaceShipmentSchema = recordShipmentSchema.extend({
    reason: z.string().trim().min(3).max(500),
});
export type ReplaceShipmentDto = z.infer<typeof replaceShipmentSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export interface ShipmentView {
    id: string;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string | null;
    note: string | null;
    status: 'ACTIVE' | 'VOIDED';
    createdById: string;
    createdAt: string;
    deliveredAt: string | null;
    /** `ADMIN` (operator confirmed) or `NFC_CLAIM` (buyer tapped the tag). */
    deliveredVia: string | null;
    voidedAt: string | null;
    voidedById: string | null;
    voidReason: string | null;
}

export interface StatusHistoryView {
    id: string;
    fromStatus: string | null;
    toStatus: string;
    /** CHECKOUT, PAYMENT, ADMIN, PACKING, SHIPMENT, NFC_CLAIM, REFUND, CHECKOUT_SWEEP, BACKFILL */
    source: string;
    actorId: string | null;
    reason: string | null;
    metadata: unknown;
    occurredAt: string;
}

/** What the buyer sees. No internal notes, no staff ids, no voided parcels. */
export interface BuyerTrackingView {
    orderId: string;
    status: string;
    placedAt: string;
    paidAt: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    shipment: {
        carrierName: string;
        trackingNumber: string;
        trackingUrl: string | null;
        shippedAt: string;
        deliveredAt: string | null;
        deliveredVia: string | null;
    } | null;
    /** One entry per status the order reached, oldest first. */
    timeline: { status: string; at: string }[];
}

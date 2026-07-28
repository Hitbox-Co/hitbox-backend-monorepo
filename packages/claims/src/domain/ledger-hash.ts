import { createHash } from 'node:crypto';

/**
 * Ledger record hash, per the demo spec:
 *
 *     Hash = SHA-256( Product ID + Tag Id + Owner Id + DateTime of Creation )
 *
 * Every record's hash is derived from exactly these four fields, so the same
 * (product, tag, owner, timestamp) always yields the same hash and any change
 * to a record's contents changes its hash.
 */
export interface LedgerHashInput {
    /** The product's human code, e.g. "A1000000000000". */
    productId: string;
    /** The NFC tag id, e.g. "TAG111111111". */
    tagId: string | null;
    /** Owner label recorded on this row: "HitBox" for origin, else the owner. */
    ownerId: string;
    /** ISO timestamp of the record's creation. */
    dateTime: string;
}

export function computeLedgerHash(input: LedgerHashInput): string {
    const canonical = [input.productId, input.tagId ?? '', input.ownerId, input.dateTime].join('+');
    return createHash('sha256').update(canonical).digest('hex');
}

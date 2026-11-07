import { z } from 'zod';

export const generateBatchTagKeysSchema = z
    .object({
        /**
         * How many chips to key in this call. The plaintext keys exist only in
         * the response, so one call keys at most this many and the caller
         * repeats until `remaining` is 0.
         */
        limit: z.number().int().min(1).max(1000).default(500),
    })
    .strict();
export type GenerateBatchTagKeysDto = z.infer<typeof generateBatchTagKeysSchema>;

export const revokeTagKeysSchema = z
    .object({
        reason: z.string().trim().min(3).max(500),
    })
    .strict();
export type RevokeTagKeysDto = z.infer<typeof revokeTagKeysSchema>;

/**
 * A key row as every read and write returns it. Deliberately has no key field
 * of any kind (wrapped or plain) and no UID.
 */
export interface TagKeyView {
    id: string;
    publicCode: string | null;
    nfcTagId: string;
    kmsKeyRef: string;
    keyVersion: number;
    status: 'ACTIVE' | 'REVOKED';
    lastTapCounter: number;
    lastTapAt: string | null;
    personalizedAt: string | null;
    revokedAt: string | null;
    revokeReason: string | null;
    createdAt: string;
}

/**
 * Returned once, for the person programming that chip. Hex, 32 characters per
 * key. Nothing stores or logs these values, or the UID, after the response.
 */
export interface GeneratedTagKeys {
    key: TagKeyView;
    nfcTagCode: string;
    uid: string;
    keys: { key0: string; key1: string; key2: string };
    /** The exact URL to write onto the chip, `e` and `c` as zero placeholders. */
    url: string;
}

export interface GeneratedBatchTagKeys {
    supplyBatchId: string;
    /** How many chips were keyed by this call. */
    generated: number;
    /** Chips in the consignment that still have no ACTIVE keys. */
    remaining: number;
    filename: string;
    /** CSV: nfcTagCode,uid,key00,key01,key02,url. Contains secrets. */
    csv: string;
    warning: string;
}

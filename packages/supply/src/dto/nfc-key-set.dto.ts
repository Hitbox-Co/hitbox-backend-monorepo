import { z } from 'zod';

/**
 * Operator-facing label, e.g. KS-2026-07 or just 101. Fits `NfcKeySet.keySetCode`
 * VarChar(20). Also usable as the tag URL's `b`, so it is URL-safe by construction.
 */
const keySetCode = z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore only.')
    // The code is also what the tag URL's `b` can carry, next to the long `nks…`
    // public code, so it must never be able to look like one.
    .refine((value) => !/^nks/i.test(value), 'A key set code cannot start with "nks".');

export const createKeySetSchema = z
    .object({
        keySetCode,
        /** The consignment the keys are for. Optional: keys may exist first. */
        supplyBatchId: z.string().uuid().optional(),
    })
    .strict();
export type CreateKeySetDto = z.infer<typeof createKeySetSchema>;

export const personaliseTagsSchema = z
    .object({
        /** The consignment whose not-yet-personalised chips get this key set. */
        supplyBatchId: z.string().uuid(),
    })
    .strict();
export type PersonaliseTagsDto = z.infer<typeof personaliseTagsSchema>;

export const retireKeySetSchema = z
    .object({
        reason: z.string().trim().min(3).max(500),
    })
    .strict();
export type RetireKeySetDto = z.infer<typeof retireKeySetSchema>;

export const listKeySetsQuerySchema = z.object({
    status: z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(z.enum(['ACTIVE', 'RETIRED']))
        .optional(),
    supplyBatchId: z.string().uuid().optional(),
});
export type ListKeySetsQuery = z.infer<typeof listKeySetsQuerySchema>;

/**
 * A key set as every read and write returns it. Deliberately has no key field
 * of any kind — wrapped or plain.
 */
export interface KeySetView {
    id: string;
    publicCode: string | null;
    keySetCode: string;
    supplyBatchId: string | null;
    kmsKeyRef: string;
    keyVersion: number;
    status: 'ACTIVE' | 'RETIRED';
    retiredAt: string | null;
    retireReason: string | null;
    createdAt: string;
}

/**
 * Returned once, by key set creation, for the person programming the chips.
 * Hex, 32 characters each. Nothing stores or logs these values after the
 * response is written.
 */
export interface CreatedKeySet extends KeySetView {
    keys: { key0: string; key1: string; key2: string };
}

export interface PersonaliseResult {
    keySetId: string;
    supplyBatchId: string;
    personalised: number;
}

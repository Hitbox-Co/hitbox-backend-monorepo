import { z } from 'zod';

/**
 * NTAG 424 DNA chip input, validated in ONE place.
 *
 * The consignment manifest (supply) and every SKU route that adds a chip (skus)
 * take the same chip: a UID and the three AES-128 keys the vendor wrote onto it.
 * They used to validate it separately, and the SKU routes took a bare UID, which
 * is how a unit ended up with a chip that could never be verified by tap. Both
 * now build their schemas from the pieces below, so the rules cannot drift.
 *
 * The rules:
 *   - a UID is hex, separators tolerated and stripped, stored upper case;
 *   - a chip that carries keys is an NTAG 424 DNA, whose UID is exactly 7 bytes
 *     (14 hex), so a keyed UID of any other length is refused;
 *   - each key is 16 bytes (32 hex); all three are sent together or none;
 *   - key0, key1 and key2 must all differ.
 *
 * Keys are secrets: nothing here logs them, and they must never be echoed back.
 */

/** A keyed NTAG 424 DNA UID: 7 bytes. */
export const KEYED_CHIP_UID_HEX_LENGTH = 14;

/** Strips separators (space, colon, dash) and upper-cases a hex string. */
export function normaliseHex(value: string): string {
    return value.replace(/[\s:-]/g, '').toUpperCase();
}

/** One AES-128 chip key: 16 bytes as 32 hex. Separators tolerated and stripped. */
export const chipKeyField = z
    .string()
    .trim()
    .transform(normaliseHex)
    .pipe(z.string().regex(/^[0-9A-F]{32}$/, 'A chip key must be 32 hex characters (16 bytes).'));

/** A chip UID as a reader prints it. Length is checked separately, once keys are known. */
export const chipUidField = z
    .string()
    .trim()
    .min(8)
    .max(64)
    .transform(normaliseHex)
    .pipe(z.string().regex(/^[0-9A-F]+$/, 'A tag UID must be hexadecimal.'));

interface KeyedFields {
    uid: string;
    key0?: string | undefined;
    key1?: string | undefined;
    key2?: string | undefined;
}

/**
 * The cross-field rules for a chip row.
 *
 * `keysRequired`: the SKU routes need all three keys (a chip with no keys
 * cannot be verified, which is the bug this fixes). The manifest keeps keys
 * optional because a vendor may register chips before the keys exist.
 */
export function refineChip(
    row: KeyedFields,
    ctx: z.RefinementCtx,
    options: { keysRequired: boolean },
): void {
    const keys = [row.key0, row.key1, row.key2];
    const given = keys.filter((key) => key !== undefined).length;

    if (given === 0 && options.keysRequired) {
        ctx.addIssue({
            code: 'custom',
            message: 'A chip needs its keys: send key0, key1 and key2.',
            path: ['key0'],
        });
        return;
    }
    if (given !== 0 && given !== 3) {
        ctx.addIssue({ code: 'custom', message: 'Send all three keys (key0, key1, key2) or none.', path: ['key0'] });
        return;
    }
    if (given === 3) {
        if (new Set(keys).size !== 3) {
            ctx.addIssue({ code: 'custom', message: 'key0, key1 and key2 must all be different.', path: ['key0'] });
        }
        if (row.uid.length !== KEYED_CHIP_UID_HEX_LENGTH) {
            ctx.addIssue({
                code: 'custom',
                message: `An NTAG 424 DNA UID is ${KEYED_CHIP_UID_HEX_LENGTH} hex characters (7 bytes).`,
                path: ['uid'],
            });
        }
    }
}

/** A chip with all its keys: the shape the SKU routes take. */
export const chipSchema = z
    .object({ uid: chipUidField, key0: chipKeyField, key1: chipKeyField, key2: chipKeyField })
    .strict()
    .superRefine((row, ctx) => refineChip(row, ctx, { keysRequired: true }));

export type ChipInput = z.infer<typeof chipSchema>;

/** The three key fields on their own, for routes that attach keys to an existing chip. */
export const chipKeysSchema = z
    .object({ key0: chipKeyField, key1: chipKeyField, key2: chipKeyField })
    .strict()
    .superRefine((row, ctx) => {
        if (new Set([row.key0, row.key1, row.key2]).size !== 3) {
            ctx.addIssue({ code: 'custom', message: 'key0, key1 and key2 must all be different.', path: ['key0'] });
        }
    });

export type ChipKeysInput = z.infer<typeof chipKeysSchema>;

/** True when every UID in the list is distinct (after normalisation). */
export function hasDuplicateUids(uids: readonly string[]): boolean {
    return new Set(uids).size !== uids.length;
}

import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { ITagCipher } from '@hitbox/supply';

/**
 * The chip-UID cipher, implemented at the composition root.
 *
 * It lives here rather than in @hitbox/supply for one reason: the key belongs
 * to the deployment. A module that derived its own key would have that key in
 * the repository, and a chip UID is the platform's anti-counterfeiting
 * secret — whoever holds one can write it to a blank chip.
 *
 * Returns `undefined` when no key is configured, and the supply module then
 * answers 503 on chip registration. That is deliberately not a fallback: rows
 * written under an improvised key can never be matched against a real tap, so
 * a deployment without the key must refuse to write them rather than write
 * ones that look fine until the first scan in the field.
 *
 * The scheme matches the demo backfill (`packages/shared/database/prisma/
 * backfill-v31.ts`) so a row written by either is readable by the other — but
 * only when they hold the same key, which by construction they do not outside
 * a dev database.
 */
export function createTagCipher(env: {
    NFC_TAG_UID_KEY?: string | undefined;
    NFC_TAG_KEY_REFERENCE?: string | undefined;
}): ITagCipher | undefined {
    const secret = env.NFC_TAG_UID_KEY;
    if (!secret) return undefined;

    // Hashed to exactly 32 bytes rather than requiring a 32-byte input, so the
    // variable can hold hex, base64 or a passphrase without the operator
    // having to know which the cipher wanted.
    const key = createHash('sha256').update(secret).digest();
    const keyReference = env.NFC_TAG_KEY_REFERENCE ?? 'env:v1';

    return {
        keyReference,

        /** Deterministic by design — that is what makes it a lookup key. */
        hash(uid: string): string {
            return createHmac('sha256', key).update(uid.toUpperCase()).digest('hex');
        },

        /**
         * `iv.authTag.ciphertext`, all base64.
         *
         * Non-deterministic: encrypting the same UID twice gives two different
         * strings, which is why the hash above exists separately and why this
         * value is never compared or indexed.
         */
        encrypt(uid: string): string {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const ciphertext = Buffer.concat([
                cipher.update(uid.toUpperCase(), 'utf8'),
                cipher.final(),
            ]);
            return [iv, cipher.getAuthTag(), ciphertext]
                .map((buffer) => buffer.toString('base64'))
                .join('.');
        },
    };
}

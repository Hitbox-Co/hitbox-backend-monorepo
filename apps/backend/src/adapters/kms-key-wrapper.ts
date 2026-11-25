import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { KeyWrapper } from '@hitbox/skus';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * DEVELOPMENT-ONLY key wrapper: AES-256-GCM under a key taken from the
 * environment (`NFC_LOCAL_WRAP_KEY`). Layout of a wrapped blob: iv | tag |
 * ciphertext.
 *
 * It exists so the verify and claim flow can run on a developer machine. It is
 * not a KMS: the wrapping key sits in an environment variable next to the
 * database it is meant to protect, so a leak of one is a leak of both. For
 * that reason it refuses to be created when NODE_ENV is `production`, unless
 * the deployment opts in explicitly with `NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION=true`
 * (a host with no cloud KMS, accepting that trade-off).
 *
 * `kmsKeyRef` is bound in as additional authenticated data, so a blob cannot
 * be unwrapped under a different reference than the one it was wrapped with.
 */
/** True only for the literal string "true": a typo must not weaken production. */
export function localWrapAllowedInProduction(env: {
    NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION?: string | undefined;
}): boolean {
    return env.NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION === 'true';
}

export function createLocalKeyWrapper(env: {
    NODE_ENV?: string | undefined;
    NFC_LOCAL_WRAP_KEY?: string | undefined;
    NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION?: string | undefined;
}): KeyWrapper | undefined {
    if (env.NODE_ENV === 'production' && !localWrapAllowedInProduction(env)) {
        throw new Error(
            'LocalKeyWrapper must not run in production. Configure a cloud KMS key wrapper instead, ' +
            'or set NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION=true to accept the weaker local wrapper.',
        );
    }

    const secret = env.NFC_LOCAL_WRAP_KEY;
    if (!secret) return undefined;

    // Hashed to exactly 32 bytes so the variable can hold hex, base64 or a
    // passphrase, the same convention as the chip-UID cipher.
    const key = createHash('sha256').update(secret).digest();

    return {
        async wrap(plain, kmsKeyRef) {
            const iv = randomBytes(IV_LENGTH);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(Buffer.from(kmsKeyRef, 'utf8'));
            const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
        },

        async unwrap(wrapped, kmsKeyRef) {
            if (wrapped.length <= IV_LENGTH + TAG_LENGTH) {
                throw new Error('Wrapped key is too short');
            }
            const iv = wrapped.subarray(0, IV_LENGTH);
            const tag = wrapped.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
            const ciphertext = wrapped.subarray(IV_LENGTH + TAG_LENGTH);
            const decipher = createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAAD(Buffer.from(kmsKeyRef, 'utf8'));
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        },
    };
}

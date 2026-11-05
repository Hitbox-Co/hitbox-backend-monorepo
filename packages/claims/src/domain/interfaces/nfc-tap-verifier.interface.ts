/**
 * Tap authentication, as a port.
 *
 * Structurally identical to `INfcTapVerifier` in @hitbox/skus, which owns the
 * implementation (key lookup, decrypt, MAC, counter). Declared here so claims
 * imports nothing from skus; bootstrap hands it the real one.
 *
 * `reason` exists for logs and tests only. It must never reach an HTTP
 * response: it would tell a prober which part of a forged URL to fix next.
 */
export interface NfcTapInput {
    u: string;
    e: string;
    c: string;
    requestId: string;
}

export type TapVerification =
    | {
        ok: true;
        nfcTagId: string;
        /** The unit the chip is embedded in. */
        skuId: string;
        nfcTagKeyId: string;
        counter: number;
    }
    | { ok: false; reason: string };

export interface INfcTapVerifier {
    verifyTap(input: NfcTapInput): Promise<TapVerification>;
}

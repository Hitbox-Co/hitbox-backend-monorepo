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
interface NfcTapBase {
    e: string;
    c: string;
    requestId: string;
}

/** Either `u` (per-tag keys) or `b` (batch keys), never both. */
export type NfcTapInput = NfcTapBase & ({ u: string; b?: undefined } | { b: string; u?: undefined });

export type TapVerification =
    | {
        ok: true;
        nfcTagId: string;
        /** The unit the chip is embedded in. */
        skuId: string;
        keySetId?: string;
        nfcTagKeyId?: string;
        counter: number;
    }
    | { ok: false; reason: string };

export interface INfcTapVerifier {
    verifyTap(input: NfcTapInput): Promise<TapVerification>;
}

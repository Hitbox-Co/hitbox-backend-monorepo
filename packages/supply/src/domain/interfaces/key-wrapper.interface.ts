/**
 * Wraps and unwraps NFC batch keys, as a port.
 *
 * Structurally identical to the port in @hitbox/skus (which unwraps the same
 * keys to verify a tap), declared again here so neither package imports the
 * other; bootstrap hands both the same implementation.
 *
 * `NfcKeySet` stores Key 00/01/02 only as the blobs `wrap` returns. Callers
 * hold a plaintext key only in a local Buffer, zero it afterwards, and never
 * log it.
 */
export interface IKeyWrapper {
    /** Encrypts a plaintext key under the KMS key named by `kmsKeyRef`. */
    wrap(plain: Buffer, kmsKeyRef: string): Promise<Buffer>;
    /** Reverses `wrap`. Rejects when the blob or `kmsKeyRef` is wrong. */
    unwrap(wrapped: Buffer, kmsKeyRef: string): Promise<Buffer>;
}

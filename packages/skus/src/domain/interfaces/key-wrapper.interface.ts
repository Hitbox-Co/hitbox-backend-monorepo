/**
 * Wraps and unwraps NFC batch keys, as a port.
 *
 * `NfcKeySet` stores Key 00/01/02 only as the blobs this returns: the database
 * never holds a plaintext key. Defined here and implemented at the bootstrap
 * boundary because the wrapping key belongs to the deployment (a cloud KMS
 * key), not to the package.
 *
 * Callers hold an unwrapped key only in a local Buffer for the length of one
 * operation, zero it afterwards, and never log it.
 */
export interface KeyWrapper {
    /** Encrypts a plaintext key under the KMS key named by `kmsKeyRef`. */
    wrap(plain: Buffer, kmsKeyRef: string): Promise<Buffer>;
    /** Reverses `wrap`. Rejects when the blob or `kmsKeyRef` is wrong. */
    unwrap(wrapped: Buffer, kmsKeyRef: string): Promise<Buffer>;
}

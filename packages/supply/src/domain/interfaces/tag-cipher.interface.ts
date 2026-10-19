/**
 * The chip-UID cipher, as a port.
 *
 * A tag UID is the platform's anti-counterfeiting secret: whoever holds one can
 * write it to a blank chip. It is therefore never stored in the clear —
 * `NfcTag.tagUidHash` is a deterministic lookup key and `tagUidEncrypted` is
 * the recoverable copy, and this module knows how to ask for both without
 * knowing how either is computed.
 *
 * Defined here and implemented at the bootstrap boundary for one reason: the
 * key belongs to the deployment, not to the package. A module that derived its
 * own key would have that key in the repository.
 */
export interface ITagCipher {
    /**
     * Deterministic lookup key for a UID — the same UID always hashes to the
     * same value, which is what makes "is this chip already registered?" a
     * single indexed read rather than a scan-and-decrypt.
     */
    hash(uid: string): string;
    /** The recoverable copy. Non-deterministic; never used as a lookup key. */
    encrypt(uid: string): string;
    /**
     * Which key produced these values, stored on the row as
     * `NfcTag.keyReference` — a pointer, never a key. Rotating the deployment
     * key changes this string, so a row written under the old one is still
     * identifiable as such.
     */
    readonly keyReference: string;
}

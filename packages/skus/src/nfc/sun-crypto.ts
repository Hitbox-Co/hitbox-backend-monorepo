import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * NTAG 424 DNA "secure unique NFC" (SUN) message primitives.
 *
 * A tap URL carries two values this file understands:
 *
 *   e  32 hex — PICC data, AES-128-CBC (zero IV) under Key 01. Decrypted it is
 *      0xC7 | UID(7) | counter(3, little-endian) | padding.
 *   c  16 hex — the SDM MAC: eight bytes of an AES-CMAC computed under a
 *      session key derived from Key 02, the UID and the counter.
 *
 * Pure functions over Buffers: no I/O, no logging, no key storage. A caller
 * holds the plaintext keys only for the length of one verification and zeroes
 * them afterwards.
 */

const BLOCK = 16;
const RB = 0x87;

/** First byte of PICC data: UID mirror on, read counter mirror on, 7-byte UID. */
const PICC_DATA_TAG = 0xc7;
const UID_LENGTH = 7;
const COUNTER_LENGTH = 3;

const E_HEX = /^[0-9a-fA-F]{32}$/;
const C_HEX = /^[0-9a-fA-F]{16}$/;

/** AES-128 on one block, no padding. ECB is only ever used as the CMAC primitive. */
function aesBlock(key: Buffer, block: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Shift a block left by one bit; XOR the last byte with Rb when a bit fell off. */
function doubleBlock(block: Buffer): Buffer {
    const out = Buffer.alloc(BLOCK);
    let carry = 0;
    for (let i = BLOCK - 1; i >= 0; i -= 1) {
        const byte = block[i]!;
        out[i] = ((byte << 1) & 0xff) | carry;
        carry = byte >> 7;
    }
    if (block[0]! & 0x80) out[BLOCK - 1] = out[BLOCK - 1]! ^ RB;
    return out;
}

function xor(a: Buffer, b: Buffer): Buffer {
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
    return out;
}

/** AES-CMAC, RFC 4493. `key` is 16 bytes; the result is the full 16-byte tag. */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
    if (key.length !== 16) throw new Error('AES-CMAC key must be 16 bytes');

    const k1 = doubleBlock(aesBlock(key, Buffer.alloc(BLOCK)));
    const k2 = doubleBlock(k1);

    const complete = message.length > 0 && message.length % BLOCK === 0;
    const blocks = Math.max(1, Math.ceil(message.length / BLOCK));

    let last: Buffer;
    if (complete) {
        last = xor(message.subarray((blocks - 1) * BLOCK), k1);
    } else {
        const rest = message.subarray((blocks - 1) * BLOCK);
        const padded = Buffer.alloc(BLOCK);
        rest.copy(padded);
        padded[rest.length] = 0x80;
        last = xor(padded, k2);
    }

    let x: Buffer = Buffer.alloc(BLOCK);
    for (let i = 0; i < blocks - 1; i += 1) {
        x = aesBlock(key, xor(x, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
    }
    return aesBlock(key, xor(x, last));
}

export interface PiccData {
    /** 7-byte chip UID. */
    uid: Buffer;
    /** Upper-case hex of `uid` — the form `ITagCipher.hash` expects. */
    uidHex: string;
    /** The 3 counter bytes exactly as the chip sent them (little-endian). */
    ctr: Buffer;
    /** The counter as a number. */
    counter: number;
}

/**
 * Decrypts `e` with Key 01. Returns null when `e` is not 32 hex or the
 * decrypted block does not start with 0xC7 — which is what a wrong key, a
 * tampered value or a random string all look like.
 */
export function decryptPicc(eHex: string, key1: Buffer): PiccData | null {
    if (!E_HEX.test(eHex) || key1.length !== 16) return null;

    const decipher = createDecipheriv('aes-128-cbc', key1, Buffer.alloc(BLOCK));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(Buffer.from(eHex, 'hex')), decipher.final()]);

    try {
        if (plain[0] !== PICC_DATA_TAG) return null;
        const uid = Buffer.from(plain.subarray(1, 1 + UID_LENGTH));
        const ctr = Buffer.from(plain.subarray(1 + UID_LENGTH, 1 + UID_LENGTH + COUNTER_LENGTH));
        return {
            uid,
            uidHex: uid.toString('hex').toUpperCase(),
            ctr,
            counter: ctr.readUIntLE(0, COUNTER_LENGTH),
        };
    } finally {
        plain.fill(0);
    }
}

/** The 8 bytes of the CMAC at odd indexes (1, 3, … 15) — what the chip prints as `c`. */
function truncateMac(full: Buffer): Buffer {
    const out = Buffer.alloc(8);
    for (let i = 0; i < 8; i += 1) out[i] = full[2 * i + 1]!;
    return out;
}

/** The MAC the chip would print for this UID and counter under Key 02. */
export function computeSdmMac(key2: Buffer, picc: Pick<PiccData, 'uid' | 'ctr'>): Buffer {
    const sv2 = Buffer.concat([
        Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]),
        picc.uid,
        picc.ctr,
    ]);
    const sessionKey = aesCmac(key2, sv2);
    try {
        return truncateMac(aesCmac(sessionKey, Buffer.alloc(0)));
    } finally {
        sessionKey.fill(0);
    }
}

/** Checks `c` against Key 02 in constant time. False on any malformed input. */
export function verifySdmMac(
    cHex: string,
    key2: Buffer,
    picc: Pick<PiccData, 'uid' | 'ctr'>,
): boolean {
    if (!C_HEX.test(cHex) || key2.length !== 16) return false;
    const expected = computeSdmMac(key2, picc);
    const given = Buffer.from(cHex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A fresh random AES-128 key. */
export function generateAesKey(): Buffer {
    return randomBytes(16);
}

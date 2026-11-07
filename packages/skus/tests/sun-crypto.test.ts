import { describe, expect, it } from '@jest/globals';
import {
    aesCmac,
    computeSdmMac,
    decryptPicc,
    generateAesKey,
    verifySdmMac,
} from '../src/nfc/sun-crypto';

const hex = (value: string) => Buffer.from(value.replace(/\s/g, ''), 'hex');

describe('aesCmac — RFC 4493 section 4 vectors', () => {
    const key = hex('2b7e1516 28aed2a6 abf71588 09cf4f3c');
    const message = hex(
        '6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51' +
            '30c81c46 a35ce411 e5fbc119 1a0a52ef f69f2445 df4f9b17 ad2b417b e66c3710',
    );

    it.each([
        [0, 'bb1d6929 e9593728 7fa37d12 9b756746'],
        [16, '070a16b4 6b4d4144 f79bdd9d d04a287c'],
        [40, 'dfa66747 de9ae630 30ca3261 1497c827'],
        [64, '51f0bebf 7e3b9d92 fc497417 79363cfe'],
    ])('message of %i bytes', (length, expected) => {
        expect(aesCmac(key, message.subarray(0, length)).toString('hex')).toBe(
            expected.replace(/\s/g, ''),
        );
    });

    it('rejects a key that is not 16 bytes', () => {
        expect(() => aesCmac(Buffer.alloc(15), Buffer.alloc(0))).toThrow();
    });
});

describe('NXP AN12196 SUN example (all-zero Key 01 and Key 02)', () => {
    const zero = Buffer.alloc(16);
    const e = 'EF963FF7828658A599F3041510671E88';
    const c = '94EED9EE65337086';

    it('decrypts e to the UID and counter', () => {
        const picc = decryptPicc(e, zero);
        expect(picc).not.toBeNull();
        expect(picc!.uidHex).toBe('04DE5F1EACC040');
        expect(picc!.counter).toBe(61);
    });

    it('accepts the matching MAC, in either letter case', () => {
        const picc = decryptPicc(e, zero)!;
        expect(verifySdmMac(c, zero, picc)).toBe(true);
        expect(verifySdmMac(c.toLowerCase(), zero, picc)).toBe(true);
        expect(computeSdmMac(zero, picc).toString('hex').toUpperCase()).toBe(c);
    });

    it('rejects a MAC with one bit changed', () => {
        const picc = decryptPicc(e, zero)!;
        expect(verifySdmMac('94EED9EE65337087', zero, picc)).toBe(false);
    });

    it('rejects the MAC under a different Key 02', () => {
        const picc = decryptPicc(e, zero)!;
        expect(verifySdmMac(c, Buffer.alloc(16, 1), picc)).toBe(false);
    });

    it('rejects the MAC when the counter is different', () => {
        const picc = decryptPicc(e, zero)!;
        const other = { uid: picc.uid, ctr: Buffer.from([62, 0, 0]) };
        expect(verifySdmMac(c, zero, other)).toBe(false);
    });
});

describe('decryptPicc — bad input', () => {
    const zero = Buffer.alloc(16);

    it('returns null for a wrong key (first byte is not 0xC7)', () => {
        expect(decryptPicc('EF963FF7828658A599F3041510671E88', Buffer.alloc(16, 7))).toBeNull();
    });

    it.each(['', 'abc', 'EF963FF7828658A599F3041510671E8', 'ZZ963FF7828658A599F3041510671E88'])(
        'returns null for malformed e %p',
        (value) => {
            expect(decryptPicc(value, zero)).toBeNull();
        },
    );

    it('verifySdmMac is false for malformed c', () => {
        const picc = decryptPicc('EF963FF7828658A599F3041510671E88', zero)!;
        expect(verifySdmMac('', zero, picc)).toBe(false);
        expect(verifySdmMac('94EED9EE6533708', zero, picc)).toBe(false);
        expect(verifySdmMac('94EED9EE6533708G', zero, picc)).toBe(false);
    });
});

describe('generateAesKey', () => {
    it('returns 16 random bytes each time', () => {
        const a = generateAesKey();
        const b = generateAesKey();
        expect(a).toHaveLength(16);
        expect(a.equals(b)).toBe(false);
    });
});

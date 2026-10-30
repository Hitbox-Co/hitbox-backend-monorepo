import { createCipheriv, randomBytes } from 'node:crypto';
import { NfcVerifyService, NFC_TAP_REASON } from '../src/nfc/nfc-verify.service';
import type { NfcTapInput } from '../src/nfc/nfc-verify.service';
import { computeSdmMac } from '../src/nfc/sun-crypto';
import type { KeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';

/**
 * verifyTap against an in-memory store, with REAL keys and REAL SUN URLs built
 * the way the chip builds them (so the crypto path is genuinely exercised).
 */

const UID = '04A1B2C3D4E5F6';
const KMS_REF = 'test-ref';

const wrapper: KeyWrapper = {
    wrap: async (plain) => Buffer.from(plain).reverse(),
    unwrap: async (wrapped) => Buffer.from(wrapped).reverse(),
};
const tagUidHash = (uid: string) => `H:${uid.toUpperCase()}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The `e` and `c` a chip with these keys prints for (uid, counter). */
function makeTap(key1: Buffer, key2: Buffer, uidHex: string, counter: number) {
    const uid = Buffer.from(uidHex, 'hex');
    const ctr = Buffer.alloc(3);
    ctr.writeUIntLE(counter, 0, 3);
    const plain = Buffer.concat([Buffer.from([0xc7]), uid, ctr, randomBytes(5)]);
    const cipher = createCipheriv('aes-128-cbc', key1, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex').toUpperCase();
    const c = computeSdmMac(key2, { uid, ctr }).toString('hex').toUpperCase();
    return { e, c };
}

interface Options {
    keySetStatus?: 'ACTIVE' | 'RETIRED';
    tagKeySetId?: string | null;
    lifecycle?: string;
    withItem?: boolean;
    lastTapCounter?: number;
    failUnwrap?: boolean;
    failLogWrites?: boolean;
}

function setup(options: Options = {}) {
    const key0 = randomBytes(16);
    const key1 = randomBytes(16);
    const key2 = randomBytes(16);
    const keySet = {
        id: 'ks-1',
        publicCode: 'nks068cs53pdkc2rkpkc0w',
        keySetCode: '786',
        status: options.keySetStatus ?? 'ACTIVE',
        kmsKeyRef: KMS_REF,
        key1Wrapped: new Uint8Array(Buffer.from(key1).reverse()),
        key2Wrapped: new Uint8Array(Buffer.from(key2).reverse()),
    };
    const tag = {
        id: 'tag-1',
        tagUidHash: tagUidHash(UID),
        keySetId: options.tagKeySetId === undefined ? 'ks-1' : options.tagKeySetId,
        lifecycleState: options.lifecycle ?? 'BOUND',
        lastTapCounter: options.lastTapCounter ?? -1,
        currentFor: options.withItem === false ? null : { id: 'sku-1' },
    };
    const verifications: Record<string, any>[] = [];
    const errors: unknown[][] = [];

    const prisma = {
        nfcKeySet: {
            findUnique: async ({ where }: any) =>
                where.publicCode === keySet.publicCode || where.keySetCode === keySet.keySetCode ? keySet : null,
        },
        nfcTag: {
            findUnique: async ({ where }: any) => (where.tagUidHash === tag.tagUidHash ? { ...tag } : null),
            updateMany: async ({ where, data }: any) => {
                // An await BEFORE the compare-and-set, so concurrent callers interleave.
                await tick();
                if (tag.id === where.id && tag.lastTapCounter < where.lastTapCounter.lt) {
                    tag.lastTapCounter = data.lastTapCounter;
                    return { count: 1 };
                }
                return { count: 0 };
            },
        },
        nfcVerification: {
            create: async ({ data }: any) => {
                if (options.failLogWrites) throw new Error('db down');
                verifications.push(data);
                return data;
            },
        },
    };

    const keyWrapper: KeyWrapper = options.failUnwrap
        ? { wrap: wrapper.wrap, unwrap: async () => { throw new Error('kms down'); } }
        : wrapper;

    const service = new NfcVerifyService({
        prisma: prisma as never,
        keyWrapper,
        tagUidHash,
        logger: { error: (...args: unknown[]) => void errors.push(args), warn() { }, info() { } } as never,
    });

    const input = (counter: number, overrides: Partial<NfcTapInput> = {}): NfcTapInput => ({
        b: keySet.publicCode,
        requestId: `req-${counter}`,
        ...makeTap(key1, key2, UID, counter),
        ...overrides,
    });

    return { service, input, tag, verifications, errors, key0, key1, key2, keySet };
}

describe('the batch value b', () => {
    it('accepts the short key set code (e.g. b=786)', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(3, { b: '786' }))).resolves.toMatchObject({
            ok: true,
            keySetId: 'ks-1',
        });
    });

    it('accepts the long public code', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(3))).resolves.toMatchObject({ ok: true });
    });

    it('an unknown short code is UNKNOWN_BATCH', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(3, { b: '999' }))).resolves.toEqual({
            ok: false,
            reason: 'UNKNOWN_BATCH',
        });
    });

    it('knowing b alone gets nothing: right batch, forged e and c, is refused', async () => {
        const t = setup();
        const forged = { b: '786', e: 'A'.repeat(32), c: 'B'.repeat(16), requestId: 'r' };
        await expect(t.service.verifyTap(forged)).resolves.toMatchObject({ ok: false });
        expect(t.tag.lastTapCounter).toBe(-1);
    });
});

describe('a genuine tap', () => {
    it('verifies, returns the chip and unit, and advances the counter', async () => {
        const t = setup();
        const result = await t.service.verifyTap(t.input(5));
        expect(result).toEqual({
            ok: true,
            nfcTagId: 'tag-1',
            skuId: 'sku-1',
            keySetId: 'ks-1',
            counter: 5,
        });
        expect(t.tag.lastTapCounter).toBe(5);
    });

    it('accepts counter 0 as the first tap of a never-tapped chip (-1)', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(0))).resolves.toMatchObject({ ok: true, counter: 0 });
    });

    it('accepts an ACTIVE chip too', async () => {
        const t = setup({ lifecycle: 'ACTIVE' });
        await expect(t.service.verifyTap(t.input(1))).resolves.toMatchObject({ ok: true });
    });

    it('writes one VERIFIED row with ids and counter, and nothing secret', async () => {
        const t = setup();
        const tap = t.input(9);
        await t.service.verifyTap(tap);

        expect(t.verifications).toHaveLength(1);
        const row = t.verifications[0]!;
        expect(row).toMatchObject({
            result: 'VERIFIED',
            reasonCode: null,
            nfcTagId: 'tag-1',
            skuId: 'sku-1',
            keySetId: 'ks-1',
            counter: 9,
            requestId: 'req-9',
        });
        expect(row.verificationCode).toMatch(/^NV\d{8}$/);
        const dump = JSON.stringify(row);
        for (const secret of [tap.e, tap.c, UID, t.key1.toString('hex'), t.key2.toString('hex')]) {
            expect(dump).not.toContain(secret);
        }
    });
});

describe('every rejection reason', () => {
    const reasonOf = (t: ReturnType<typeof setup>) => t.verifications.at(-1)?.reasonCode;

    it('UNKNOWN_BATCH', async () => {
        const t = setup();
        const result = await t.service.verifyTap(t.input(1, { b: 'nksunknown' }));
        expect(result).toEqual({ ok: false, reason: NFC_TAP_REASON.UNKNOWN_BATCH });
        expect(reasonOf(t)).toBe('UNKNOWN_BATCH');
        expect(t.verifications[0]).toMatchObject({ result: 'REJECTED', keySetId: null });
    });

    it('KEY_SET_RETIRED', async () => {
        const t = setup({ keySetStatus: 'RETIRED' });
        await expect(t.service.verifyTap(t.input(1))).resolves.toEqual({
            ok: false,
            reason: 'KEY_SET_RETIRED',
        });
        expect(t.tag.lastTapCounter).toBe(-1);
    });

    it('BAD_PICC — e encrypted under the wrong key', async () => {
        const t = setup();
        const forged = makeTap(randomBytes(16), t.key2, UID, 3);
        await expect(t.service.verifyTap(t.input(3, forged))).resolves.toEqual({
            ok: false,
            reason: 'BAD_PICC',
        });
    });

    it('BAD_PICC — e that is not even hex', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(3, { e: 'zz' }))).resolves.toMatchObject({
            reason: 'BAD_PICC',
        });
    });

    it('UNKNOWN_TAG — a valid URL for a UID we never registered', async () => {
        const t = setup();
        const other = makeTap(t.key1, t.key2, '04FFEEDDCCBBAA', 3);
        await expect(t.service.verifyTap(t.input(3, other))).resolves.toEqual({
            ok: false,
            reason: 'UNKNOWN_TAG',
        });
    });

    it('BATCH_MISMATCH — the chip belongs to another key set', async () => {
        const t = setup({ tagKeySetId: 'ks-other' });
        await expect(t.service.verifyTap(t.input(3))).resolves.toEqual({
            ok: false,
            reason: 'BATCH_MISMATCH',
        });
    });

    it('BATCH_MISMATCH — a chip with no key set at all', async () => {
        const t = setup({ tagKeySetId: null });
        await expect(t.service.verifyTap(t.input(3))).resolves.toMatchObject({ reason: 'BATCH_MISMATCH' });
    });

    it.each(['UNPROVISIONED', 'LOST', 'REVOKED', 'DISPUTED'])('TAG_NOT_ACTIVE — %s', async (state) => {
        const t = setup({ lifecycle: state });
        await expect(t.service.verifyTap(t.input(3))).resolves.toEqual({
            ok: false,
            reason: 'TAG_NOT_ACTIVE',
        });
    });

    it('BAD_CMAC — right key for e, wrong MAC', async () => {
        const t = setup();
        const good = t.input(4);
        const flipped = good.c.slice(0, 15) + (good.c.endsWith('0') ? '1' : '0');
        await expect(t.service.verifyTap({ ...good, c: flipped })).resolves.toEqual({
            ok: false,
            reason: 'BAD_CMAC',
        });
    });

    it('BAD_CMAC — a MAC made with the wrong Key 02', async () => {
        const t = setup();
        const forged = makeTap(t.key1, randomBytes(16), UID, 4);
        await expect(t.service.verifyTap(t.input(4, forged))).resolves.toMatchObject({
            reason: 'BAD_CMAC',
        });
    });

    it('NO_ITEM — a genuine chip not yet embedded in a unit', async () => {
        const t = setup({ withItem: false });
        await expect(t.service.verifyTap(t.input(4))).resolves.toEqual({
            ok: false,
            reason: 'NO_ITEM',
        });
    });

    it('REPLAY — the same URL twice', async () => {
        const t = setup();
        const tap = t.input(6);
        await expect(t.service.verifyTap(tap)).resolves.toMatchObject({ ok: true });
        await expect(t.service.verifyTap(tap)).resolves.toEqual({ ok: false, reason: 'REPLAY' });
        expect(t.verifications.map((v) => v.result)).toEqual(['VERIFIED', 'REJECTED']);
        expect(reasonOf(t)).toBe('REPLAY');
    });

    it('REPLAY — an older counter after a newer one', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(10));
        await expect(t.service.verifyTap(t.input(9))).resolves.toMatchObject({ reason: 'REPLAY' });
        await expect(t.service.verifyTap(t.input(11))).resolves.toMatchObject({ ok: true });
    });
});

describe('order of the checks', () => {
    it('a retired set is refused before e is even decrypted', async () => {
        const t = setup({ keySetStatus: 'RETIRED' });
        const result = await t.service.verifyTap(t.input(1, { e: 'zz' }));
        expect(result).toMatchObject({ reason: 'KEY_SET_RETIRED' });
    });

    it('batch mismatch is reported before the MAC is checked', async () => {
        const t = setup({ tagKeySetId: 'ks-other' });
        const bad = t.input(1, { c: '0000000000000000' });
        await expect(t.service.verifyTap(bad)).resolves.toMatchObject({ reason: 'BATCH_MISMATCH' });
    });

    it('lifecycle is checked before the MAC', async () => {
        const t = setup({ lifecycle: 'LOST' });
        const bad = t.input(1, { c: '0000000000000000' });
        await expect(t.service.verifyTap(bad)).resolves.toMatchObject({ reason: 'TAG_NOT_ACTIVE' });
    });

    it('a forged URL cannot burn the counter of a real chip', async () => {
        const t = setup({ lastTapCounter: 3 });
        await t.service.verifyTap(t.input(50, { c: '0000000000000000' }));
        expect(t.tag.lastTapCounter).toBe(3);
        // ...so the real tap with a lower-but-valid counter still works.
        await expect(t.service.verifyTap(t.input(4))).resolves.toMatchObject({ ok: true });
    });

    it('a chip with no item does not have its counter consumed', async () => {
        const t = setup({ withItem: false, lastTapCounter: 3 });
        await t.service.verifyTap(t.input(8));
        expect(t.tag.lastTapCounter).toBe(3);
    });
});

describe('simultaneous taps', () => {
    it('two taps with the same counter: exactly one passes', async () => {
        const t = setup();
        const tap = t.input(7);
        const results = await Promise.all([t.service.verifyTap(tap), t.service.verifyTap(tap)]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'REPLAY' }]);
        expect(t.tag.lastTapCounter).toBe(7);
    });

    it('five at once: still exactly one winner', async () => {
        const t = setup();
        const tap = t.input(2);
        const results = await Promise.all(Array.from({ length: 5 }, () => t.service.verifyTap(tap)));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
});

describe('failures that are not the caller\'s fault', () => {
    it('an unwrap failure is a 500, is not logged as a rejection, and leaks nothing', async () => {
        const t = setup({ failUnwrap: true });
        await expect(t.service.verifyTap(t.input(1))).rejects.toMatchObject({ statusCode: 500 });
        expect(t.verifications).toHaveLength(0);
        expect(JSON.stringify(t.errors)).not.toContain(t.key1.toString('hex'));
    });

    it('a failed log write does not fail a genuine tap', async () => {
        const t = setup({ failLogWrites: true });
        await expect(t.service.verifyTap(t.input(1))).resolves.toMatchObject({ ok: true });
        expect(t.errors.length).toBeGreaterThan(0);
    });
});

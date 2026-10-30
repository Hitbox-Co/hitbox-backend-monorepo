import { createCipheriv, randomBytes } from 'node:crypto';
import { NfcVerifyService } from '../src/nfc/nfc-verify.service';
import type { NfcTapInput } from '../src/nfc/nfc-verify.service';
import { computeSdmMac } from '../src/nfc/sun-crypto';
import type { KeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';

/**
 * verifyTap with per-tag keys (`u`), against an in-memory store, with REAL keys
 * and REAL SUN values built the way the chip builds them.
 */

const UID_A = '04A1B2C3D4E5F6';
const UID_B = '04B2C3D4E5F607';
const KMS_REF = 'test-ref';

const wrapper: KeyWrapper = {
    wrap: async (plain) => Buffer.from(plain).reverse(),
    unwrap: async (wrapped) => Buffer.from(wrapped).reverse(),
};
const tagUidHash = (uid: string) => `H:${uid.toUpperCase()}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    lifecycle?: string;
    withItem?: boolean;
    keyStatus?: 'ACTIVE' | 'REVOKED' | 'NONE';
    keyRowUidHash?: string | null;
    failUnwrap?: boolean;
}

function setup(options: Options = {}) {
    const mk = () => ({ key0: randomBytes(16), key1: randomBytes(16), key2: randomBytes(16) });
    const keysA = mk();
    const keysB = mk();

    const tags: Record<string, any> = {
        [tagUidHash(UID_A)]: {
            id: 'tag-a',
            tagUidHash: tagUidHash(UID_A),
            lifecycleState: options.lifecycle ?? 'BOUND',
            lastTapCounter: 0,
            currentFor: options.withItem === false ? null : { id: 'sku-a' },
        },
        [tagUidHash(UID_B)]: {
            id: 'tag-b',
            tagUidHash: tagUidHash(UID_B),
            lifecycleState: 'BOUND',
            lastTapCounter: 0,
            currentFor: { id: 'sku-b' },
        },
    };
    const tagsBefore = JSON.stringify(tags);

    const rows: Record<string, any>[] = [];
    if (options.keyStatus !== 'NONE') {
        rows.push({
            id: 'key-a',
            nfcTagId: 'tag-a',
            status: options.keyStatus ?? 'ACTIVE',
            tagUidHash:
                options.keyRowUidHash === undefined ? tagUidHash(UID_A) : options.keyRowUidHash,
            kmsKeyRef: KMS_REF,
            key1Wrapped: new Uint8Array(Buffer.from(keysA.key1).reverse()),
            key2Wrapped: new Uint8Array(Buffer.from(keysA.key2).reverse()),
            lastTapCounter: -1,
        });
    }
    rows.push({
        id: 'key-b',
        nfcTagId: 'tag-b',
        status: 'ACTIVE',
        tagUidHash: tagUidHash(UID_B),
        kmsKeyRef: KMS_REF,
        key1Wrapped: new Uint8Array(Buffer.from(keysB.key1).reverse()),
        key2Wrapped: new Uint8Array(Buffer.from(keysB.key2).reverse()),
        lastTapCounter: -1,
    });

    const verifications: Record<string, any>[] = [];
    const errors: unknown[][] = [];
    const calls: string[] = [];

    const prisma = {
        nfcTag: {
            findUnique: async ({ where }: any) => {
                calls.push('tag');
                const tag = tags[where.tagUidHash];
                return tag ? { ...tag } : null;
            },
            updateMany: async () => {
                throw new Error('NfcTag must not be written by a per-tag tap');
            },
        },
        nfcTagKey: {
            findFirst: async ({ where }: any) => {
                calls.push('key');
                return rows.find((r) => r.nfcTagId === where.nfcTagId && r.status === where.status) ?? null;
            },
            updateMany: async ({ where, data }: any) => {
                calls.push('counter');
                await tick(); // concurrent callers interleave before the compare-and-set
                const row = rows.find((r) => r.id === where.id);
                if (row && row.lastTapCounter < where.lastTapCounter.lt) {
                    row.lastTapCounter = data.lastTapCounter;
                    row.lastTapAt = data.lastTapAt;
                    return { count: 1 };
                }
                return { count: 0 };
            },
        },
        nfcVerification: {
            create: async ({ data }: any) => {
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

    const input = (counter: number, overrides: Record<string, unknown> = {}): NfcTapInput =>
        ({
            u: UID_A,
            requestId: `req-${counter}`,
            ...makeTap(keysA.key1, keysA.key2, UID_A, counter),
            ...overrides,
        }) as NfcTapInput;

    return {
        service, input, rows, verifications, errors, calls, keysA, keysB,
        tagsUntouched: () => JSON.stringify(tags) === tagsBefore,
    };
}

const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? 'OK' : r.reason);

describe('a genuine per-tag tap', () => {
    it('verifies and returns the chip, the unit and the key row', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(5))).resolves.toEqual({
            ok: true,
            nfcTagId: 'tag-a',
            skuId: 'sku-a',
            nfcTagKeyId: 'key-a',
            counter: 5,
        });
    });

    it('accepts a first tap with counter 0 (key rows start at -1)', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(0))).resolves.toMatchObject({ ok: true, counter: 0 });
    });

    it('accepts u in lower case', async () => {
        const t = setup();
        await expect(t.service.verifyTap(t.input(2, { u: UID_A.toLowerCase() }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it('records the counter on the key row, never on NfcTag', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(7));
        expect(t.rows.find((r) => r.id === 'key-a')!.lastTapCounter).toBe(7);
        expect(t.rows.find((r) => r.id === 'key-a')!.lastTapAt).toBeInstanceOf(Date);
        expect(t.tagsUntouched()).toBe(true);
    });

    it('writes one VERIFIED row naming the key row, with no secrets in it', async () => {
        const t = setup();
        const tap = t.input(4);
        await t.service.verifyTap(tap);
        expect(t.verifications).toHaveLength(1);
        expect(t.verifications[0]).toMatchObject({
            result: 'VERIFIED',
            nfcTagId: 'tag-a',
            skuId: 'sku-a',
            nfcTagKeyId: 'key-a',
            counter: 4,
            keySetId: null,
        });
        const logged = JSON.stringify(t.verifications);
        for (const secret of [UID_A, tap.e, tap.c, t.keysA.key1.toString('hex'), t.keysA.key2.toString('hex')]) {
            expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
        }
        expect(t.verifications[0]!.verificationCode).toMatch(/^NV\d{8}$/);
    });
});

describe('every refusal has its reason and writes one REJECTED row', () => {
    const cases: [string, (t: ReturnType<typeof setup>) => NfcTapInput, Options, string][] = [
        ['bad u', (t) => t.input(1, { u: 'ZZ' }), {}, 'BAD_FORMAT'],
        ['short u', (t) => t.input(1, { u: '04A1B2' }), {}, 'BAD_FORMAT'],
        ['bad e', (t) => t.input(1, { e: 'abc' }), {}, 'BAD_FORMAT'],
        ['bad c', (t) => t.input(1, { c: '12' }), {}, 'BAD_FORMAT'],
        ['unregistered UID', (t) => t.input(1, { u: '04FFFFFFFFFFFF' }), {}, 'UNKNOWN_TAG'],
        ['chip not BOUND/ACTIVE', (t) => t.input(1), { lifecycle: 'UNPROVISIONED' }, 'TAG_NOT_ACTIVE'],
        ['chip never keyed', (t) => t.input(1), { keyStatus: 'NONE' }, 'NO_KEYS'],
        ['revoked keys', (t) => t.input(1), { keyStatus: 'REVOKED' }, 'NO_KEYS'],
        ['key row belongs to another UID', (t) => t.input(1), { keyRowUidHash: 'H:OTHER' }, 'NO_KEYS'],
        ['e not from this chip', (t) => t.input(1, { e: 'A'.repeat(32) }), {}, 'BAD_PICC'],
        ['chip not in a unit', (t) => t.input(1), { withItem: false }, 'NO_ITEM'],
    ];

    it.each(cases)('%s → %s', async (_name, build, options, reason) => {
        const t = setup(options);
        expect(reasonOf(await t.service.verifyTap(build(t)) as never)).toBe(reason);
        expect(t.verifications).toHaveLength(1);
        expect(t.verifications[0]).toMatchObject({ result: 'REJECTED', reasonCode: reason });
    });

    it('a changed c is BAD_CMAC', async () => {
        const t = setup();
        const tap = t.input(3);
        const flipped = ((parseInt(tap.c[0]!, 16) ^ 1) & 0xf).toString(16).toUpperCase() + tap.c.slice(1);
        expect(reasonOf(await t.service.verifyTap({ ...tap, c: flipped }) as never)).toBe('BAD_CMAC');
    });

    it('UID_MISMATCH: e decrypts fine but names a different UID than u', async () => {
        const t = setup();
        // Chip B's keys, but the UID of chip A inside e.
        const tap = { u: UID_B, requestId: 'r', ...makeTap(t.keysB.key1, t.keysB.key2, UID_A, 3) };
        expect(reasonOf(await t.service.verifyTap(tap as never) as never)).toBe('UID_MISMATCH');
    });

    it('a genuine tap from chip A sent with the u of chip B is refused', async () => {
        const t = setup();
        const tap = t.input(3, { u: UID_B });
        expect(reasonOf(await t.service.verifyTap(tap) as never)).toBe('BAD_PICC');
        expect(t.rows.find((r) => r.id === 'key-b')!.lastTapCounter).toBe(-1);
    });

    it('a refused tap never burns the counter', async () => {
        const t = setup();
        const tap = t.input(9);
        await t.service.verifyTap({ ...tap, c: '0'.repeat(16) });
        expect(t.rows.find((r) => r.id === 'key-a')!.lastTapCounter).toBe(-1);
        await expect(t.service.verifyTap(tap)).resolves.toMatchObject({ ok: true });
    });
});

describe('order of the checks', () => {
    it('refuses a bad format before touching the database', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(1, { u: 'nope' }));
        expect(t.calls).toEqual([]);
    });

    it('looks the chip up, then its lifecycle, then its key row, and the counter last', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(1));
        expect(t.calls).toEqual(['tag', 'key', 'counter']);
    });

    it('does not look for keys when the chip is not BOUND/ACTIVE', async () => {
        const t = setup({ lifecycle: 'RETIRED' });
        await t.service.verifyTap(t.input(1));
        expect(t.calls).toEqual(['tag']);
    });

    it('checks the MAC before the counter: a forged c never reaches the counter write', async () => {
        const t = setup();
        await t.service.verifyTap({ ...t.input(1), c: '1'.repeat(16) });
        expect(t.calls).not.toContain('counter');
    });
});

describe('replay', () => {
    it('the same URL twice: the second is REPLAY', async () => {
        const t = setup();
        const tap = t.input(6);
        await expect(t.service.verifyTap(tap)).resolves.toMatchObject({ ok: true });
        expect(reasonOf(await t.service.verifyTap({ ...tap, requestId: 'again' }) as never)).toBe('REPLAY');
        expect(t.verifications.map((v) => v.result)).toEqual(['VERIFIED', 'REJECTED']);
    });

    it('an older counter after a newer one is REPLAY', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(10));
        expect(reasonOf(await t.service.verifyTap(t.input(8)) as never)).toBe('REPLAY');
    });

    it('two simultaneous taps with the same counter: exactly one passes', async () => {
        const t = setup();
        const tap = t.input(12);
        const results = await Promise.all([
            t.service.verifyTap({ ...tap, requestId: 'r1' }),
            t.service.verifyTap({ ...tap, requestId: 'r2' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'REPLAY' }]);
    });
});

describe('server faults and isolation', () => {
    it('an unwrap failure is a 500, is not logged as a rejection, and leaks nothing', async () => {
        const t = setup({ failUnwrap: true });
        await expect(t.service.verifyTap(t.input(1))).rejects.toMatchObject({ statusCode: 500 });
        expect(t.verifications).toHaveLength(0);
        expect(JSON.stringify(t.errors)).not.toContain(UID_A);
    });

    it('never writes to an NfcTag row (the fake throws if it does)', async () => {
        const t = setup();
        await t.service.verifyTap(t.input(1));
        await t.service.verifyTap(t.input(1));
        expect(t.tagsUntouched()).toBe(true);
    });

    it("another chip's counter is unaffected", async () => {
        const t = setup();
        await t.service.verifyTap(t.input(20));
        expect(t.rows.find((r) => r.id === 'key-b')!.lastTapCounter).toBe(-1);
    });
});

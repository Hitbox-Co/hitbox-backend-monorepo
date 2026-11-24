import { createHash } from 'node:crypto';
import pino from 'pino';
import { ChipRegistryService } from '../src/service/chip-registry.service';
import type { IKeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';
import type { ITagCipher } from '../src/domain/interfaces/tag-cipher.interface';
import { createChipDb } from './chip-db';

/**
 * Chips that reach a unit outside a consignment. The registry creates (or
 * links) the NfcTag and writes the wrapped NfcTagKey, so a tap can be verified.
 * Keys and UIDs are secrets: they must not appear in a row in the clear, in an
 * error, or in a log.
 */

const logger = pino({ level: 'silent' });
const KMS = 'local-dev';

const wrapper: IKeyWrapper = {
    wrap: async (plain, ref) => Buffer.concat([Buffer.from(`W[${ref}]`), Buffer.from(plain).reverse()]),
    unwrap: async (wrapped, ref) => Buffer.from(wrapped.subarray(`W[${ref}]`.length)).reverse(),
};
const cipher: ITagCipher = {
    keyReference: 'test',
    hash: (uid) => `H:${uid.toUpperCase()}`,
    encrypt: (uid) => `E:${Buffer.from(uid.toUpperCase()).reverse().toString('hex')}`,
    decrypt: (payload) => Buffer.from(payload.slice(2), 'hex').reverse().toString(),
};

const UID_A = '04A39B2C5D6E80';
const UID_B = '04A39B2C5D6E81';
const K0 = '000102030405060708090A0B0C0D0E0F';
const K1 = '101112131415161718191A1B1C1D1E1F';
const K2 = '202122232425262728292A2B2C2D2E2F';
const O0 = 'A0A1A2A3A4A5A6A7A8A9AAABACADAEAF';
const chip = (uid = UID_A, keys = { key0: K0, key1: K1, key2: K2 }) => ({ uid, ...keys });

function build(over: { cipher?: ITagCipher | undefined; wrapper?: IKeyWrapper | undefined; kmsKeyRef?: string | undefined } = {}) {
    const db = createChipDb();
    const registry = new ChipRegistryService({
        cipher: 'cipher' in over ? over.cipher : cipher,
        wrapper: 'wrapper' in over ? over.wrapper : wrapper,
        kmsKeyRef: 'kmsKeyRef' in over ? over.kmsKeyRef : KMS,
        logger,
    });
    return { db, registry };
}

/** Everything a failed call could have shown anyone. */
const messageOf = async (work: Promise<unknown>) => {
    try {
        await work;
    } catch (error) {
        return JSON.stringify({ message: (error as Error).message, ...(error as object) });
    }
    return '';
};

describe('attachWithin: a new chip', () => {
    it('creates the NfcTag (no consignment) and an ACTIVE wrapped key row', async () => {
        const { db, registry } = build();
        const [result] = await registry.attachWithin(db.tx, { chips: [chip()], createdById: 'admin-1' });

        expect(result).toMatchObject({ created: true, keysWritten: true });
        expect(db.tags).toHaveLength(1);
        expect(db.tags[0]).toMatchObject({
            supplyBatchId: null,
            lifecycleState: 'UNPROVISIONED',
            tagUidHash: `H:${UID_A}`,
            nfcTagCode: 'NT00000001',
        });
        expect(db.keys).toHaveLength(1);
        expect(db.keys[0]).toMatchObject({
            nfcTagId: db.tags[0]!.id, status: 'ACTIVE', kmsKeyRef: KMS, createdById: 'admin-1',
            tagUidHash: `H:${UID_A}`,
        });
        expect(db.keys[0]!.personalizedAt).toBeInstanceOf(Date);
    });

    it('stores keys only wrapped and the UID only hashed and encrypted', async () => {
        // An opaque cipher: the readable test double above would put the UID in its "hash".
        const opaque: ITagCipher = {
            keyReference: 'opaque',
            hash: (uid) => createHash('sha256').update(`pepper:${uid}`).digest('hex'),
            encrypt: (uid) => Buffer.from(uid, 'hex').map((byte) => byte ^ 0x5a).toString('base64'),
            decrypt: () => '',
        };
        const { db, registry } = build({ cipher: opaque });
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        const stored = JSON.stringify([db.tags, db.keys.map((key) => ({
            ...key,
            key0Wrapped: Buffer.from(key.key0Wrapped).toString('hex'),
            key1Wrapped: Buffer.from(key.key1Wrapped).toString('hex'),
            key2Wrapped: Buffer.from(key.key2Wrapped).toString('hex'),
        }))]);
        for (const secret of [K0, K1, K2, UID_A]) expect(stored).not.toContain(secret);
        // ...and what is stored really is the wrapped key.
        const unwrapped = await wrapper.unwrap(Buffer.from(db.keys[0]!.key1Wrapped), KMS);
        expect(unwrapped.toString('hex').toUpperCase()).toBe(K1);
    });

    it('numbers chips in sequence and records the variant', async () => {
        const { db, registry } = build();
        const variantId = 'c3d4e5f6-0000-4000-8000-000000000001';
        const out = await registry.attachWithin(db.tx, {
            chips: [{ ...chip(UID_A), variantId }, chip(UID_B)],
            createdById: null,
        });
        expect(out.map((r) => r.created)).toEqual([true, true]);
        expect(db.tags.map((t) => t.nfcTagCode)).toEqual(['NT00000001', 'NT00000002']);
        expect(db.tags[0]!.variantId).toBe(variantId);
    });
});

describe('attachWithin: a chip already on file', () => {
    it('same keys: an idempotent re-send, nothing new is written', async () => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        const [again] = await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        expect(again).toMatchObject({ created: false, keysWritten: false });
        expect(db.tags).toHaveLength(1);
        expect(db.keys).toHaveLength(1);
    });

    it('different keys: refused, and the chip keeps the keys it has', async () => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        const shown = await messageOf(registry.attachWithin(db.tx, {
            chips: [chip(UID_A, { key0: O0, key1: K1, key2: K2 })], createdById: null,
        }));
        expect(shown).toContain('SUPPLY_TAG_KEYS_MISMATCH');
        for (const secret of [K0, O0, UID_A]) expect(shown).not.toContain(secret);
        expect(db.keys).toHaveLength(1);
    });

    it('registered keyless: the keys are added', async () => {
        const { db, registry } = build();
        db.tags.push({
            id: 't-keyless', nfcTagCode: 'NT00000007', tagUidHash: `H:${UID_A}`, tagUidEncrypted: 'E:x',
            lifecycleState: 'UNPROVISIONED', qcStatus: 'PASSED', supplyBatchId: 'batch-1', variantId: null,
        });
        const [result] = await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        expect(result).toMatchObject({ nfcTagId: 't-keyless', created: false, keysWritten: true });
        expect(db.keys).toHaveLength(1);
        expect(db.tags).toHaveLength(1);
    });

    it('already the chip of another unit: refused; of this same unit: allowed', async () => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        db.skus.push({ id: 'sku-1', currentNfcTagId: db.tags[0]!.id });

        await expect(
            registry.attachWithin(db.tx, { chips: [chip()], forSkuIds: ['sku-2'], createdById: null }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'SUPPLY_TAG_UID_TAKEN' });
        await expect(
            registry.attachWithin(db.tx, { chips: [chip()], forSkuIds: ['sku-1'], createdById: null }),
        ).resolves.toHaveLength(1);
    });

    it.each([
        ['LOST', { lifecycleState: 'LOST' }],
        ['REVOKED', { lifecycleState: 'REVOKED' }],
        ['DISPUTED', { lifecycleState: 'DISPUTED' }],
        ['failed QC', { qcStatus: 'FAILED' }],
    ])('a %s chip cannot be bound', async (_label, patch) => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        Object.assign(db.tags[0]!, patch);
        await expect(
            registry.attachWithin(db.tx, { chips: [chip()], createdById: null }),
        ).rejects.toMatchObject({ code: 'SUPPLY_TAG_UNUSABLE' });
    });

    it('a chip registered for another variant is refused', async () => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [{ ...chip(), variantId: 'variant-a' }], createdById: null });
        await expect(
            registry.attachWithin(db.tx, { chips: [{ ...chip(), variantId: 'variant-b' }], createdById: null }),
        ).rejects.toMatchObject({ code: 'SUPPLY_TAG_VARIANT_MISMATCH' });
    });
});

describe('attachWithin: refusals', () => {
    it('a UID that is not 7 bytes is refused even if a caller skipped the DTO', async () => {
        const { db, registry } = build();
        await expect(
            registry.attachWithin(db.tx, { chips: [chip('04A39B2C')], createdById: null }),
        ).rejects.toMatchObject({ code: 'SUPPLY_TAG_UID_INVALID' });
        expect(db.tags).toHaveLength(0);
    });

    it('the same chip twice in one request is refused', async () => {
        const { db, registry } = build();
        await expect(
            registry.attachWithin(db.tx, { chips: [chip(), chip()], createdById: null }),
        ).rejects.toMatchObject({ code: 'SUPPLY_TAG_UID_DUPLICATED' });
    });

    it('no tag cipher: 503, nothing written', async () => {
        const { db, registry } = build({ cipher: undefined });
        await expect(registry.attachWithin(db.tx, { chips: [chip()], createdById: null })).rejects.toMatchObject({
            statusCode: 503, code: 'SUPPLY_TAG_KEY_UNAVAILABLE',
        });
        expect(db.tags).toHaveLength(0);
    });

    it('no key wrapper: 503, so keys are never stored unwrapped', async () => {
        const { db, registry } = build({ wrapper: undefined });
        await expect(registry.attachWithin(db.tx, { chips: [chip()], createdById: null })).rejects.toMatchObject({
            statusCode: 503, code: 'SUPPLY_KEY_WRAPPER_UNAVAILABLE',
        });
        expect(db.keys).toHaveLength(0);
    });

    it('a concurrent registration of the same chip is a 409, not a 500', async () => {
        const { db, registry } = build();
        const original = db.tx.nfcTag.createMany;
        db.tx.nfcTag.createMany = async () => {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
        };
        await expect(registry.attachWithin(db.tx, { chips: [chip()], createdById: null })).rejects.toMatchObject({
            statusCode: 409,
        });
        db.tx.nfcTag.createMany = original;
    });
});

describe('addKeysManyWithin', () => {
    const keyless = (id: string, over: Record<string, unknown> = {}) => ({
        id, nfcTagCode: `NT${id}`, tagUidHash: `H:${id}`, tagUidEncrypted: `E:${id}`,
        lifecycleState: 'BOUND', qcStatus: 'PASSED', ...over,
    });

    it('writes the keys of many chips in one batch, wrapped, keeping each chip\'s UID hash', async () => {
        const { db, registry } = build();
        db.tags.push(keyless('00000001'), keyless('00000002'));
        const createMany = jest.spyOn(db.tx.nfcTagKey, 'createMany');
        await registry.addKeysManyWithin(db.tx, {
            items: [
                { nfcTagId: '00000001', key0: K0, key1: K1, key2: K2 },
                { nfcTagId: '00000002', key0: O0, key1: K1, key2: K2 },
            ],
            createdById: 'admin-1',
        });
        expect(createMany).toHaveBeenCalledTimes(1);
        expect(db.keys.map((key) => key.tagUidHash)).toEqual(['H:00000001', 'H:00000002']);
        expect(db.keys.every((key) => key.status === 'ACTIVE')).toBe(true);
        expect(JSON.stringify(db.keys.map((key) => Buffer.from(key.key0Wrapped).toString('hex')))).not.toContain(K0);
    });

    it('refuses, writing nothing, when a chip already has ACTIVE keys', async () => {
        const { db, registry } = build();
        db.tags.push(keyless('00000001'), keyless('00000002'));
        db.keys.push({ id: 'k', nfcTagId: '00000002', status: 'ACTIVE' });
        const shown = await messageOf(registry.addKeysManyWithin(db.tx, {
            items: [
                { nfcTagId: '00000001', key0: K0, key1: K1, key2: K2 },
                { nfcTagId: '00000002', key0: O0, key1: K1, key2: K2 },
            ],
            createdById: null,
        }));
        expect(shown).toContain('SUPPLY_TAG_KEYS_EXIST');
        expect(shown).toContain('Row 2');
        for (const secret of [K0, O0]) expect(shown).not.toContain(secret);
        expect(db.keys).toHaveLength(1);
    });

    it('an unknown chip is a 404 and a LOST chip is refused', async () => {
        const { db, registry } = build();
        await expect(
            registry.addKeysManyWithin(db.tx, { items: [{ nfcTagId: 'nope', key0: K0, key1: K1, key2: K2 }], createdById: null }),
        ).rejects.toMatchObject({ statusCode: 404 });
        db.tags.push(keyless('00000003', { lifecycleState: 'LOST' }));
        await expect(
            registry.addKeysManyWithin(db.tx, { items: [{ nfcTagId: '00000003', key0: K0, key1: K1, key2: K2 }], createdById: null }),
        ).rejects.toMatchObject({ code: 'SUPPLY_TAG_UNUSABLE' });
    });
});

describe('revokeWithin', () => {
    it('takes the chip out of service: REVOKED, keys revoked', async () => {
        const { db, registry } = build();
        await registry.attachWithin(db.tx, { chips: [chip()], createdById: null });
        const id = db.tags[0]!.id;
        await registry.revokeWithin(db.tx, { nfcTagId: id, reason: 'Replaced: re-tagged' });
        expect(db.tags[0]).toMatchObject({ lifecycleState: 'REVOKED' });
        expect(db.tags[0]!.retiredAt).toBeInstanceOf(Date);
        expect(db.keys[0]).toMatchObject({ status: 'REVOKED', revokeReason: 'Replaced: re-tagged' });
        expect(db.activeKeys(id)).toHaveLength(0);
    });
});

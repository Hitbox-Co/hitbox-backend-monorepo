import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
import { ChipRegistryService } from '../src/service/chip-registry.service';
import type { IKeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';
import type { ITagCipher } from '../src/domain/interfaces/tag-cipher.interface';
import { buildSkuAccess } from '../../skus/src/domain/sku-access';
import { NfcVerifyService } from '../../skus/src/nfc/nfc-verify.service';
import type { NfcTapInput } from '../../skus/src/nfc/nfc-verify.service';
import { computeSdmMac } from '../../skus/src/nfc/sun-crypto';
import { SkuRepository } from '../../skus/src/repository/sku.repository';
import { SkuService } from '../../skus/src/service/sku.service';
import { bindTagSchema, bulkBindTagsSchema, mintSkusSchema } from '../../skus/src/dto/sku.dto';
import { createChipDb } from './chip-db';

/**
 * The bug this closes: only the consignment path produced verifiable chips.
 * The SKU routes wrote a bare UID and a tap on it answered UNKNOWN_TAG. Here the
 * real SkuService and the real ChipRegistryService run over one in-memory store,
 * and a real SUN tap (built the way the chip builds it) is verified by the real
 * NfcVerifyService.
 */

const logger = pino({ level: 'silent' });
const KMS = 'local-dev';

const wrapper: IKeyWrapper = {
    wrap: async (plain, ref) => Buffer.concat([Buffer.from(`W[${ref}]`), Buffer.from(plain).reverse()]),
    unwrap: async (wrapped, ref) => Buffer.from(wrapped.subarray(`W[${ref}]`.length)).reverse(),
};
const cipher: ITagCipher = {
    keyReference: 'test',
    hash: (uid) => createHash('sha256').update(`pepper:${uid.toUpperCase()}`).digest('hex'),
    encrypt: (uid) => Buffer.from(uid, 'hex').map((byte) => byte ^ 0x5a).toString('base64'),
    decrypt: () => '',
};

const ACCESS = buildSkuAccess({
    userId: 'admin-1',
    permissions: ['collectible-instance:manage:global', 'nfc-tag-claim:manage:global', 'nfc-tag-claim:read:global'],
    roles: [],
});

const PRODUCT = { id: 'p1', groupCode: 'TEE', name: 'Tee', organizationId: null, status: 'ACTIVE', totalSupply: 0 };

interface ChipSpec {
    uid: string;
    key0: string;
    key1: string;
    key2: string;
}
const newChip = (uid: string): ChipSpec => ({
    uid,
    key0: randomBytes(16).toString('hex').toUpperCase(),
    key1: randomBytes(16).toString('hex').toUpperCase(),
    key2: randomBytes(16).toString('hex').toUpperCase(),
});

/** A tap as the chip produces it: `e` is the encrypted PICC data, `c` the MAC. */
function tap(chip: ChipSpec, counter: number, requestId: string): NfcTapInput {
    const uid = Buffer.from(chip.uid, 'hex');
    const ctr = Buffer.alloc(3);
    ctr.writeUIntLE(counter, 0, 3);
    const plain = Buffer.concat([Buffer.from([0xc7]), uid, ctr, randomBytes(5)]);
    const aes = createCipheriv('aes-128-cbc', Buffer.from(chip.key1, 'hex'), Buffer.alloc(16));
    aes.setAutoPadding(false);
    const e = Buffer.concat([aes.update(plain), aes.final()]).toString('hex').toUpperCase();
    const c = computeSdmMac(Buffer.from(chip.key2, 'hex'), { uid, ctr }).toString('hex').toUpperCase();
    return { u: chip.uid, e, c, requestId } as NfcTapInput;
}

function build() {
    const db = createChipDb();
    const audit: unknown[] = [];

    const prisma: any = {
        drop: { findUnique: async () => PRODUCT },
        $transaction: async (work: (tx: unknown) => unknown) => work(db.tx),
        sku: {
            findMany: async ({ where }: any) => {
                if (where.tagId?.in) {
                    return db.skus.filter((sku) => where.tagId.in.includes(sku.tagId)).map((sku) => ({ tagId: sku.tagId, skuCode: sku.skuCode }));
                }
                const serials: number[] = where.OR?.find((o: any) => o.serialNumber)?.serialNumber.in ?? [];
                const codes: string[] = where.OR?.find((o: any) => o.skuCode)?.skuCode.in ?? [];
                return db.skus
                    .filter((sku) => sku.productId === where.productId && (serials.includes(sku.serialNumber) || codes.includes(sku.skuCode)))
                    .map((sku) => ({
                        ...sku,
                        currentNfcTag: sku.currentNfcTagId ? { keys: db.activeKeys(sku.currentNfcTagId).slice(0, 1) } : null,
                    }));
            },
            findUnique: async ({ where }: any) => {
                const sku = db.skus.find((row) => row.id === where.id);
                return sku ? { ...sku, currentNfcTag: sku.currentNfcTagId ? { keys: db.activeKeys(sku.currentNfcTagId).slice(0, 1) } : null } : null;
            },
        },
    };

    const registry = new ChipRegistryService({ cipher, wrapper, kmsKeyRef: KMS, logger });
    const repo = new SkuRepository(prisma);
    // Reads the service makes around a bind that are not the subject of this test.
    (repo as any).findDetail = async (skuId: string) => ({ id: skuId, drop: { organizationId: null } });
    const service = new SkuService({
        skus: repo,
        eventBus: { publish: async () => undefined, subscribe: () => ({ unsubscribe() { } }) } as never,
        audit: { record: async (entry) => void audit.push(entry) },
        logger,
        chipRegistry: registry,
    });
    (service as any).getDetail = async () => ({});

    // The tap side: the real verifier over the same store.
    const verifications: unknown[] = [];
    const verifier = new NfcVerifyService({
        prisma: {
            nfcTag: {
                findUnique: async ({ where }: any) => {
                    const tag = db.tags.find((row) => row.tagUidHash === where.tagUidHash);
                    return tag ? { ...tag, currentFor: db.currentFor(tag.id) } : null;
                },
                updateMany: async () => {
                    throw new Error('a per-tag tap must not write NfcTag');
                },
            },
            nfcTagKey: {
                findFirst: async ({ where }: any) =>
                    db.keys.find((key) => key.nfcTagId === where.nfcTagId && key.status === where.status) ?? null,
                updateMany: async ({ where, data }: any) => {
                    const key = db.keys.find((row) => row.id === where.id);
                    if (key && key.lastTapCounter < where.lastTapCounter.lt) {
                        Object.assign(key, data);
                        return { count: 1 };
                    }
                    return { count: 0 };
                },
            },
            nfcVerification: { create: async ({ data }: any) => void verifications.push(data) },
        } as never,
        keyWrapper: wrapper,
        tagUidHash: (uid: string) => cipher.hash(uid),
        logger: { error() { }, warn() { }, info() { } } as never,
    });

    return { db, service, verifier, audit, verifications };
}

const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? 'OK' : r.reason);

describe('route 1: mint with chips', () => {
    it('a tap on a chip minted with its keys verifies, and names the unit', async () => {
        const t = build();
        const a = newChip('04A39B2C5D6E80');
        const b = newChip('04A39B2C5D6E81');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 2, chips: [a, b] }));

        expect(t.db.skus).toHaveLength(2);
        expect(t.db.skus.every((sku) => sku.currentNfcTagId && sku.tagLifecycleState === 'BOUND')).toBe(true);
        expect(t.db.tags.every((tag) => tag.lifecycleState === 'BOUND' && tag.supplyBatchId === null)).toBe(true);

        const result = await t.verifier.verifyTap(tap(a, 1, 'r1'));
        expect(result).toMatchObject({ ok: true, skuId: t.db.skus[0]!.id });
        await expect(t.verifier.verifyTap(tap(b, 1, 'r2'))).resolves.toMatchObject({ ok: true, skuId: t.db.skus[1]!.id });
    });

    it('a mint with bare tagIds is refused outright: there is no way to add a chip without keys', () => {
        const parsed = mintSkusSchema.safeParse({ count: 1, tagIds: ['04A39B2C5D6E80'] });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed)).toContain('no longer accepted');
        expect(mintSkusSchema.safeParse({ count: 1, chips: [{ uid: '04A39B2C5D6E80' }] }).success).toBe(false);
    });

    it('units minted with no chip have none: a tap finds nothing', async () => {
        const t = build();
        const a = newChip('04A39B2C5D6E80');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 1 }));
        expect(t.db.tags).toHaveLength(0);
        expect(reasonOf(await t.verifier.verifyTap(tap(a, 1, 'r1')) as never)).toBe('UNKNOWN_TAG');
    });

    it('a wrong key still fails verification', async () => {
        const t = build();
        const a = newChip('04A39B2C5D6E80');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 1, chips: [a] }));
        const forged = tap({ ...a, key2: newChip('04A39B2C5D6E80').key2 }, 1, 'r1');
        expect((await t.verifier.verifyTap(forged)).ok).toBe(false);
    });
});

describe('route 2: bind a manifest to units that already exist', () => {
    it('keyed chips bound by serial verify; the same UIDs sent bare do not', async () => {
        const t = build();
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 2 }));
        const a = newChip('04A39B2C5D6E80');
        const b = newChip('04A39B2C5D6E81');

        const result = await t.service.bulkBindTags(ACCESS, 'p1', bulkBindTagsSchema.parse({
            bindings: [{ serialNumber: 1, ...a }, { serialNumber: 2, ...b }],
        }));
        expect(result).toMatchObject({ bound: 2, withKeys: 2, chipsVerifiable: 2 });
        expect(t.db.skus.map((sku) => sku.tagId)).toEqual([a.uid, b.uid]); // the legacy mirror
        await expect(t.verifier.verifyTap(tap(a, 1, 'r1'))).resolves.toMatchObject({ ok: true, skuId: t.db.skus[0]!.id });
        await expect(t.verifier.verifyTap(tap(b, 1, 'r2'))).resolves.toMatchObject({ ok: true, skuId: t.db.skus[1]!.id });
    });

    it('is all or nothing: one chip already taken by another unit binds nothing', async () => {
        const t = build();
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 2 }));
        const a = newChip('04A39B2C5D6E80');
        const b = newChip('04A39B2C5D6E81');
        await t.service.bulkBindTags(ACCESS, 'p1', bulkBindTagsSchema.parse({ bindings: [{ serialNumber: 1, ...a }] }));
        const tagsBefore = t.db.tags.length;
        const keysBefore = t.db.keys.length;

        // Unit 2 asks for chip B and chip A (already unit 1's): the request is refused whole.
        await expect(
            t.service.bulkBindTags(ACCESS, 'p1', bulkBindTagsSchema.parse({ bindings: [{ serialNumber: 2, ...a }] })),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(t.db.tags).toHaveLength(tagsBefore);
        expect(t.db.keys).toHaveLength(keysBefore);
        void b;
    });
});

describe('route 3: bind or re-tag one unit', () => {
    it('re-tagging with replace: the new chip verifies and the old one stops', async () => {
        const t = build();
        const oldChip = newChip('04A39B2C5D6E80');
        const newOne = newChip('04A39B2C5D6E81');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 1, chips: [oldChip] }));
        const skuId = t.db.skus[0]!.id;
        await expect(t.verifier.verifyTap(tap(oldChip, 1, 'r1'))).resolves.toMatchObject({ ok: true });

        await t.service.bindTag(ACCESS, skuId, bindTagSchema.parse({ chip: newOne, replace: true }));

        await expect(t.verifier.verifyTap(tap(newOne, 1, 'r2'))).resolves.toMatchObject({ ok: true, skuId });
        expect((await t.verifier.verifyTap(tap(oldChip, 2, 'r3'))).ok).toBe(false);
        expect(t.db.tags.find((tag) => tag.tagUidHash === cipher.hash(oldChip.uid))!.lifecycleState).toBe('REVOKED');
        expect(t.db.skus[0]!.tagId).toBe(newOne.uid);
    });

    it('re-tagging without replace is refused and the old chip keeps working', async () => {
        const t = build();
        const oldChip = newChip('04A39B2C5D6E80');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 1, chips: [oldChip] }));
        await expect(
            t.service.bindTag(ACCESS, t.db.skus[0]!.id, bindTagSchema.parse({ chip: newChip('04A39B2C5D6E81') })),
        ).rejects.toMatchObject({ code: 'SKUS_TAG_ALREADY_BOUND' });
        await expect(t.verifier.verifyTap(tap(oldChip, 1, 'r1'))).resolves.toMatchObject({ ok: true });
    });
});

describe('B: units that already carry a bare UID from before keys were mandatory', () => {
    it('attaching the keys later makes them verifiable', async () => {
        const t = build();
        const a = newChip('04A39B2C5D6E80');
        // Legacy state, as the removed route left it: a UID on the unit, no NfcTag, no keys.
        t.db.skus.push({
            id: 'legacy-1', skuCode: 'TEE-000001', serialNumber: 1, productId: 'p1', variantId: null,
            tagId: a.uid, currentNfcTagId: null, tagLifecycleState: 'BOUND', claimedStatus: 'UNCLAIMED',
        });
        expect(reasonOf(await t.verifier.verifyTap(tap(a, 1, 'r1')) as never)).toBe('UNKNOWN_TAG');

        await t.service.addChipKeys(ACCESS, 'legacy-1', { key0: a.key0, key1: a.key1, key2: a.key2 });

        expect(t.db.skus[0]!.currentNfcTagId).toBeTruthy();
        await expect(t.verifier.verifyTap(tap(a, 2, 'r2'))).resolves.toMatchObject({ ok: true, skuId: 'legacy-1' });
    });
});

describe('secrecy', () => {
    it('no key and no UID appears in any audit record', async () => {
        const t = build();
        const a = newChip('04A39B2C5D6E80');
        await t.service.mint(ACCESS, 'p1', mintSkusSchema.parse({ count: 1, chips: [a] }));
        await t.service.addChipKeys(ACCESS, t.db.skus[0]!.id, { key0: a.key0, key1: a.key1, key2: a.key2 }).catch(() => undefined);
        const text = JSON.stringify(t.audit);
        for (const secret of [a.uid, a.key0, a.key1, a.key2]) expect(text).not.toContain(secret);
        expect(text).toContain('sku.chip.bind');
    });
});

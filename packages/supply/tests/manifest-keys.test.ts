import pino from 'pino';
import { QcStatus, SupplyBatchStatus, SupplyItemType } from '@hitbox/database';
import type { IKeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';
import type { ISupplyAudit, SupplyAuditInput } from '../src/domain/interfaces/supply-audit.interface';
import type { ITagCipher } from '../src/domain/interfaces/tag-cipher.interface';
import { registerTagsSchema } from '../src/dto/supply.dto';
import type { SealedTag, SupplyRepository } from '../src/repository/supply.repository';
import { SupplyService } from '../src/service/supply.service';

/**
 * A chip manifest that carries each chip's Key 00/01/02 (the vendor wrote them
 * onto the chips). The property guarded here: the keys reach the repository
 * only wrapped, and never appear in a response, an audit row or an event.
 */

const logger = pino({ level: 'silent' });
const KMS_REF = 'local-dev';

const wrapper: IKeyWrapper = {
    wrap: async (plain, ref) => Buffer.concat([Buffer.from(`W[${ref}]`), Buffer.from(plain).reverse()]),
    unwrap: async (wrapped, ref) => Buffer.from(wrapped.subarray(`W[${ref}]`.length)).reverse(),
};
const cipher: ITagCipher = {
    keyReference: 'test',
    hash: (uid) => `H:${Buffer.from(uid.toUpperCase()).reverse().toString('hex')}`,
    encrypt: (uid) => `E:${Buffer.from(uid.toUpperCase()).reverse().toString('hex')}`,
    decrypt: (payload) => Buffer.from(payload.slice(2), 'hex').reverse().toString('utf8'),
};

const UID_A = '04A39B2C5D6E80';
const UID_B = '04A39B2C5D6E81';
const K0 = '000102030405060708090A0B0C0D0E0F';
const K1 = '101112131415161718191A1B1C1D1E1F';
const K2 = '202122232425262728292A2B2C2D2E2F';

const batch = {
    id: 'batch-1',
    itemType: SupplyItemType.FIGURE,
    status: SupplyBatchStatus.VALIDATED,
    quantity: 10,
    rowsReceived: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
    lines: [],
} as never;

function setup(options: { withWrapper?: boolean } = {}) {
    const written: SealedTag[][] = [];
    const audits: SupplyAuditInput[] = [];
    const events: unknown[] = [];
    const supply = {
        findExistingUidHashes: async () => new Set<string>(),
        registerTags: async (input: { tags: SealedTag[]; createdById?: string | null }) => {
            written.push(input.tags);
            return {
                created: input.tags.length,
                keysCreated: input.tags.filter((tag) => tag.keys).length,
                batch: {
                    rowsReceived: input.tags.length,
                    rowsAccepted: input.tags.length,
                    rowsRejected: 0,
                    status: SupplyBatchStatus.VALIDATED,
                    lines: [],
                },
            };
        },
    } as unknown as SupplyRepository;
    const audit: ISupplyAudit = { record: async (input) => void audits.push(input) };
    const service = new SupplyService({
        supply,
        eventBus: { publish: (name: string, payload: unknown) => void events.push({ name, payload }), subscribe() { } } as never,
        audit,
        logger,
        tagCipher: cipher,
        keyWrapper: options.withWrapper === false ? undefined : wrapper,
        kmsKeyRef: options.withWrapper === false ? undefined : KMS_REF,
    });
    const apply = (raw: unknown) =>
        service.applyManifest({
            actorId: 'vendor-user-1',
            actorType: 'VENDOR',
            correlationId: 'c',
            batch,
            dto: registerTagsSchema.parse(raw),
        });
    return { apply, written, audits, events };
}

describe('the manifest row schema', () => {
    it('accepts a row with all three keys, in any separator style, upper-cased', () => {
        const dto = registerTagsSchema.parse({
            tags: [{ uid: UID_A, key0: K0.toLowerCase(), key1: K1.match(/../g)!.join(':'), key2: K2 }],
        });
        expect(dto.tags[0]).toMatchObject({ key0: K0, key1: K1, key2: K2 });
    });

    it('still accepts a row with no keys', () => {
        expect(registerTagsSchema.safeParse({ tags: [{ uid: UID_A }] }).success).toBe(true);
    });

    it('refuses one or two keys, equal keys, and a key that is not 32 hex', () => {
        const bad = [
            { uid: UID_A, key1: K1 },
            { uid: UID_A, key0: K0, key1: K1 },
            { uid: UID_A, key0: K0, key1: K0, key2: K2 },
            { uid: UID_A, key0: 'ABC', key1: K1, key2: K2 },
            { uid: UID_A, key0: `${K0}00`, key1: K1, key2: K2 },
        ];
        for (const row of bad) expect(registerTagsSchema.safeParse({ tags: [row] }).success).toBe(false);
    });
});

describe('a manifest with chip keys', () => {
    it('hands the repository only wrapped keys that unwrap to the vendor ones', async () => {
        const t = setup();
        await t.apply({ tags: [{ uid: UID_A, key0: K0, key1: K1, key2: K2 }] });

        const keys = t.written[0]![0]!.keys!;
        expect(keys.kmsKeyRef).toBe(KMS_REF);
        const blobs = [keys.key0Wrapped, keys.key1Wrapped, keys.key2Wrapped];
        [K0, K1, K2].forEach((plain, index) => {
            expect(blobs[index]!.toString('hex').toUpperCase()).not.toContain(plain);
        });
        const unwrapped = await Promise.all(blobs.map((blob) => wrapper.unwrap(blob, KMS_REF)));
        expect(unwrapped.map((key) => key.toString('hex').toUpperCase())).toEqual([K0, K1, K2]);
    });

    it('stores keys only for the rows that sent them, and reports the count', async () => {
        const t = setup();
        const result = await t.apply({
            tags: [{ uid: UID_A, key0: K0, key1: K1, key2: K2 }, { uid: UID_B }],
        });
        expect(result).toMatchObject({ registered: 2, withKeys: 1 });
        expect(t.written[0]!.map((tag) => Boolean(tag.keys))).toEqual([true, false]);
    });

    it('never returns, audits or publishes a key', async () => {
        const t = setup();
        const result = await t.apply({ tags: [{ uid: UID_A, key0: K0, key1: K1, key2: K2 }] });
        const seen = JSON.stringify([result, t.audits, t.events]).toUpperCase();
        for (const secret of [K0, K1, K2, UID_A]) expect(seen).not.toContain(secret);
        expect(t.audits[0]!.metadata).toMatchObject({ registered: 1, keysRegistered: 1 });
    });

    it('a dry run checks the keys, counts them, and writes nothing', async () => {
        const t = setup();
        const result = await t.apply({ dryRun: true, tags: [{ uid: UID_A, key0: K0, key1: K1, key2: K2 }] });
        expect(result).toMatchObject({ dryRun: true, registered: 1, withKeys: 1 });
        expect(t.written).toHaveLength(0);
        expect(JSON.stringify(result).toUpperCase()).not.toContain(K1);
    });

    it('is refused with 503, before anything is written, when no key wrapper is configured', async () => {
        const t = setup({ withWrapper: false });
        await expect(
            t.apply({ tags: [{ uid: UID_A, key0: K0, key1: K1, key2: K2 }] }),
        ).rejects.toMatchObject({ statusCode: 503, code: 'SUPPLY_KEY_WRAPPER_UNAVAILABLE' });
        expect(t.written).toHaveLength(0);
    });

    it('a manifest without keys still works without a key wrapper', async () => {
        const t = setup({ withWrapper: false });
        await expect(t.apply({ tags: [{ uid: UID_A, qcStatus: QcStatus.PASSED }] })).resolves.toMatchObject({
            registered: 1,
            withKeys: 0,
        });
    });
});

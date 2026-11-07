import pino from 'pino';
import { buildSupplyAccess } from '../src/domain/supply-access';
import type { IKeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';
import type { ISupplyAudit, SupplyAuditInput } from '../src/domain/interfaces/supply-audit.interface';
import type { ITagCipher } from '../src/domain/interfaces/tag-cipher.interface';
import type {
    KeyableTag,
    NewTagKey,
    NfcTagKeyRepository,
    TagKeyRow,
} from '../src/repository/nfc-tag-key.repository';
import { NfcTagKeyService } from '../src/service/nfc-tag-key.service';

/**
 * Per-tag key management through the service, with in-memory stand-ins for the
 * repository, the KMS and the chip-UID cipher.
 *
 * What most of these guard: no plaintext key and no UID is ever stored,
 * audited or published, and nothing here can touch an existing NfcTag row.
 */

const logger = pino({ level: 'silent' });
const KMS_REF = 'local-dev';

const ADMIN = buildSupplyAccess({
    userId: 'admin-1',
    permissions: ['nfc-tag-claim:manage:global'],
    roles: [],
});
const READ_ONLY = buildSupplyAccess({
    userId: 'reader-1',
    permissions: ['nfc-tag-claim:read:global'],
    roles: [],
});
const ctx = (access = ADMIN) => ({ access, correlationId: 'corr-1' });

const wrapper: IKeyWrapper = {
    wrap: async (plain, ref) =>
        Buffer.concat([Buffer.from(`W[${ref}]`), Buffer.from(plain).reverse()]),
    unwrap: async (wrapped, ref) => {
        const head = Buffer.from(`W[${ref}]`);
        if (!wrapped.subarray(0, head.length).equals(head)) throw new Error('wrong ref');
        return Buffer.from(wrapped.subarray(head.length)).reverse();
    },
};

/** Not real crypto: a reversible tag so the tests can tell plaintext from stored. */
const cipher: ITagCipher = {
    keyReference: 'test',
    hash: (uid) => `H:${Buffer.from(uid.toUpperCase()).reverse().toString('hex')}`,
    encrypt: (uid) => `E:${Buffer.from(uid.toUpperCase()).reverse().toString('hex')}`,
    decrypt: (payload) => Buffer.from(payload.slice(2), 'hex').reverse().toString('utf8'),
};

const UIDS: Record<string, string> = {
    t1: '04DE5F1EACC040',
    t2: '04AAAAAAAAAAAA',
    t3: '04BBBBBBBBBBBB',
    t4: '04CCCCCCCCCCCC',
};

type StoredKey = TagKeyRow & NewTagKey;

function harness(options: { withWrapper?: boolean; withCipher?: boolean } = {}) {
    const tags: (KeyableTag & { lifecycleState: string; lastTapCounter: number })[] = Object.entries(UIDS).map(
        ([id, uid], index) => ({
            id,
            nfcTagCode: `NT0000000${index + 1}`,
            supplyBatchId: id === 't4' ? 'batch-2' : 'batch-1',
            tagUidEncrypted: cipher.encrypt(uid),
            tagUidHash: cipher.hash(uid),
            lifecycleState: 'BOUND',
            lastTapCounter: 0,
        }),
    );
    const tagsBefore = JSON.stringify(tags);
    const rows: StoredKey[] = [];
    const batches = new Set(['batch-1', 'batch-2']);
    const audits: SupplyAuditInput[] = [];
    const events: { name: string; payload: unknown }[] = [];
    let next = 1;

    const view = (row: StoredKey): TagKeyRow => ({
        id: row.id,
        publicCode: row.publicCode,
        nfcTagId: row.nfcTagId,
        kmsKeyRef: row.kmsKeyRef,
        keyVersion: row.keyVersion,
        status: row.status,
        lastTapCounter: row.lastTapCounter,
        lastTapAt: row.lastTapAt,
        personalizedAt: row.personalizedAt,
        revokedAt: row.revokedAt,
        revokeReason: row.revokeReason,
        createdAt: row.createdAt,
    });
    const insert = (input: NewTagKey): StoredKey => {
        // The partial unique index: one ACTIVE row per tag.
        if (rows.some((r) => r.nfcTagId === input.nfcTagId && r.status === 'ACTIVE')) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row: StoredKey = {
            ...input,
            id: `k-${next++}`,
            publicCode: `ntk-${next}`,
            keyVersion: 1,
            status: 'ACTIVE',
            lastTapCounter: -1,
            lastTapAt: null,
            personalizedAt: null,
            revokedAt: null,
            revokeReason: null,
            createdAt: new Date('2026-10-28T00:00:00Z'),
        };
        rows.push(row);
        return row;
    };
    const hasActive = (id: string) => rows.some((r) => r.nfcTagId === id && r.status === 'ACTIVE');

    const keys = {
        async findTag(id: string) {
            return tags.find((t) => t.id === id) ?? null;
        },
        async batchExists(id: string) {
            return batches.has(id);
        },
        async hasActiveKey(id: string) {
            return hasActive(id);
        },
        async findById(id: string) {
            const row = rows.find((r) => r.id === id);
            return row ? view(row) : null;
        },
        async findActiveForTag(id: string) {
            const row = rows.find((r) => r.nfcTagId === id && r.status === 'ACTIVE');
            return row ? view(row) : null;
        },
        async create(input: NewTagKey) {
            return view(insert(input));
        },
        async createMany(inputs: NewTagKey[]) {
            const snapshot = rows.length;
            try {
                return inputs.map((i) => view(insert(i)));
            } catch (error) {
                rows.length = snapshot; // all or none
                throw error;
            }
        },
        async tagsNeedingKeys(batchId: string, limit: number) {
            return tags.filter((t) => t.supplyBatchId === batchId && !hasActive(t.id)).slice(0, limit);
        },
        async countTagsNeedingKeys(batchId: string) {
            return tags.filter((t) => t.supplyBatchId === batchId && !hasActive(t.id)).length;
        },
        async markPersonalized(id: string, now: Date) {
            const row = rows.find((r) => r.id === id && r.status === 'ACTIVE' && !r.personalizedAt);
            if (!row) return false;
            row.personalizedAt = now;
            return true;
        },
        async revokeActive(p: { nfcTagId: string; reason: string; now: Date }) {
            const row = rows.find((r) => r.nfcTagId === p.nfcTagId && r.status === 'ACTIVE');
            if (!row) return false;
            row.status = 'REVOKED';
            row.revokedAt = p.now;
            row.revokeReason = p.reason;
            return true;
        },
    } as unknown as NfcTagKeyRepository;

    const audit: ISupplyAudit = { record: async (input) => void audits.push(input) };
    const eventBus = {
        publish: jest.fn((name: string, payload: unknown) => void events.push({ name, payload })),
        subscribe: jest.fn(),
    };

    const service = new NfcTagKeyService({
        keys,
        eventBus: eventBus as never,
        audit,
        logger,
        keyWrapper: options.withWrapper === false ? undefined : wrapper,
        kmsKeyRef: options.withWrapper === false ? undefined : KMS_REF,
        tagCipher: options.withCipher === false ? undefined : cipher,
    });
    return { service, rows, tags, tagsUnchanged: () => JSON.stringify(tags) === tagsBefore, audits, events };
}

describe('generateTagKeys', () => {
    it('returns three different 16-byte keys, the UID and the URL to write', async () => {
        const h = harness();
        const out = await h.service.generateTagKeys(ctx(), 't1');

        const { key0, key1, key2 } = out.keys;
        for (const key of [key0, key1, key2]) expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(new Set([key0, key1, key2]).size).toBe(3);
        expect(out.uid).toBe(UIDS.t1);
        expect(out.url).toBe(
            `https://hitboxcollectibles.com/verify?u=${UIDS.t1}&e=${'0'.repeat(32)}&c=${'0'.repeat(16)}`,
        );
        expect(out.key.status).toBe('ACTIVE');
        expect(out.key.personalizedAt).toBeNull();
    });

    it('stores the UID (encrypted + hash) and only wrapped keys that unwrap to the returned ones', async () => {
        const h = harness();
        const out = await h.service.generateTagKeys(ctx(), 't1');
        const stored = h.rows[0]!;

        expect(stored.tagUidEncrypted).toBe(cipher.encrypt(UIDS.t1!));
        expect(stored.tagUidHash).toBe(cipher.hash(UIDS.t1!));
        expect(JSON.stringify(stored)).not.toContain(UIDS.t1!);

        const returned = [out.keys.key0, out.keys.key1, out.keys.key2];
        const blobs = [stored.key0Wrapped, stored.key1Wrapped, stored.key2Wrapped];
        for (const [index, blob] of blobs.entries()) {
            expect(blob.toString('hex')).not.toContain(returned[index]!);
            expect((await wrapper.unwrap(blob, KMS_REF)).toString('hex')).toBe(returned[index]);
        }
        expect(stored.kmsKeyRef).toBe(KMS_REF);
    });

    it('never puts a key or the UID in the audit row or the event', async () => {
        const h = harness();
        const out = await h.service.generateTagKeys(ctx(), 't1');
        const recorded = JSON.stringify([h.audits, h.events]);

        for (const secret of [out.keys.key0, out.keys.key1, out.keys.key2, UIDS.t1!]) {
            expect(recorded).not.toContain(secret);
        }
        expect(h.audits[0]).toMatchObject({
            eventType: 'supply.tag-keys.generate',
            resourceType: 'NfcTagKey',
        });
    });

    it('refuses a chip that already has active keys', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't1');
        await expect(h.service.generateTagKeys(ctx(), 't1')).rejects.toMatchObject({
            code: 'SUPPLY_TAG_KEYS_EXIST',
        });
        expect(h.rows).toHaveLength(1);
    });

    it('answers 404 for an unknown chip', async () => {
        await expect(harness().service.generateTagKeys(ctx(), 'nope')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('answers 503 without a key wrapper, and 503 without the UID cipher', async () => {
        await expect(harness({ withWrapper: false }).service.generateTagKeys(ctx(), 't1')).rejects.toMatchObject({
            statusCode: 503,
            code: 'SUPPLY_KEY_WRAPPER_UNAVAILABLE',
        });
        const noCipher = harness({ withCipher: false });
        await expect(noCipher.service.generateTagKeys(ctx(), 't1')).rejects.toMatchObject({
            statusCode: 503,
            code: 'SUPPLY_TAG_UID_KEY_UNAVAILABLE',
        });
        expect(noCipher.rows).toHaveLength(0);
    });

    it('requires write access', async () => {
        const h = harness();
        await expect(h.service.generateTagKeys(ctx(READ_ONLY), 't1')).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(h.rows).toHaveLength(0);
    });

    it('does not change any NfcTag field', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't1');
        expect(h.tagsUnchanged()).toBe(true);
    });
});

describe('generateKeysForBatch', () => {
    it('keys every un-keyed chip of the consignment and returns a CSV of keys + UID + URL', async () => {
        const h = harness();
        const out = await h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 500 });

        expect(out.generated).toBe(3);
        expect(out.remaining).toBe(0);
        const lines = out.csv.trim().split('\n');
        expect(lines[0]).toBe('nfcTagCode,uid,key00,key01,key02,url');
        expect(lines).toHaveLength(4);
        expect(lines[1]).toContain(UIDS.t1!);
        expect(lines[1]).toMatch(/,[0-9a-f]{32},[0-9a-f]{32},[0-9a-f]{32},https:\/\/hitboxcollectibles\.com\/verify\?u=/);
        expect(out.warning).toMatch(/secret/i);
        expect(h.rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(3);
        expect(h.rows.every((r) => r.nfcTagId !== 't4')).toBe(true);
    });

    it('skips chips that already have active keys', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't2');
        const out = await h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 500 });
        expect(out.generated).toBe(2);
        expect(out.csv).not.toContain(UIDS.t2!);
    });

    it('honours the limit and reports what remains', async () => {
        const h = harness();
        const out = await h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 2 });
        expect(out.generated).toBe(2);
        expect(out.remaining).toBe(1);
    });

    it('stores nothing when a chip was keyed in the meantime (all or none)', async () => {
        const h = harness();
        const realTagsNeedingKeys = (h.service as never as { deps: { keys: NfcTagKeyRepository } }).deps.keys
            .tagsNeedingKeys;
        // t1 gets keys after the read of "tags needing keys" but before the write.
        const deps = (h.service as never as { deps: { keys: NfcTagKeyRepository } }).deps;
        deps.keys.tagsNeedingKeys = async (batchId: string, limit: number) => {
            const tags = await realTagsNeedingKeys.call(deps.keys, batchId, limit);
            await h.service.generateTagKeys(ctx(), 't1');
            return tags;
        };
        await expect(h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 500 })).rejects.toMatchObject({
            code: 'SUPPLY_TAG_KEYS_EXIST',
        });
        expect(h.rows).toHaveLength(1); // only the single-chip row
    });

    it('answers 404 for an unknown consignment and 409 when nothing needs keys', async () => {
        const h = harness();
        await expect(h.service.generateKeysForBatch(ctx(), 'nope', { limit: 5 })).rejects.toMatchObject({
            statusCode: 404,
        });
        await h.service.generateKeysForBatch(ctx(), 'batch-2', { limit: 5 });
        await expect(h.service.generateKeysForBatch(ctx(), 'batch-2', { limit: 5 })).rejects.toMatchObject({
            code: 'SUPPLY_NO_TAGS_NEED_KEYS',
        });
    });

    it('puts only counts in the audit row and event', async () => {
        const h = harness();
        const out = await h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 500 });
        const recorded = JSON.stringify([h.audits, h.events]);
        for (const uid of Object.values(UIDS)) expect(recorded).not.toContain(uid);
        for (const line of out.csv.trim().split('\n').slice(1)) {
            for (const key of line.split(',').slice(2, 5)) expect(recorded).not.toContain(key);
        }
        expect(h.audits[0]!.metadata).toMatchObject({ generated: 3 });
    });

    it('does not change any NfcTag field', async () => {
        const h = harness();
        await h.service.generateKeysForBatch(ctx(), 'batch-1', { limit: 500 });
        expect(h.tagsUnchanged()).toBe(true);
    });
});

describe('markTagPersonalized', () => {
    it('sets personalizedAt on that key row only', async () => {
        const h = harness();
        const a = await h.service.generateTagKeys(ctx(), 't1');
        await h.service.generateTagKeys(ctx(), 't2');

        const view = await h.service.markTagPersonalized(ctx(), a.key.id);
        expect(view.personalizedAt).not.toBeNull();
        expect(h.rows.filter((r) => r.personalizedAt)).toHaveLength(1);
        expect(h.audits.at(-1)).toMatchObject({ eventType: 'supply.tag-keys.personalize' });
        expect(h.tagsUnchanged()).toBe(true);
    });

    it('refuses a second call, a revoked row and an unknown id', async () => {
        const h = harness();
        const a = await h.service.generateTagKeys(ctx(), 't1');
        await h.service.markTagPersonalized(ctx(), a.key.id);
        await expect(h.service.markTagPersonalized(ctx(), a.key.id)).rejects.toMatchObject({
            code: 'SUPPLY_TAG_KEYS_ALREADY_PERSONALIZED',
        });

        const b = await h.service.generateTagKeys(ctx(), 't2');
        await h.service.revokeTagKeys(ctx(), 't2', { reason: 'lost chip' });
        await expect(h.service.markTagPersonalized(ctx(), b.key.id)).rejects.toMatchObject({
            code: 'SUPPLY_TAG_KEYS_NOT_ACTIVE',
        });
        await expect(h.service.markTagPersonalized(ctx(), 'nope')).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('revokeTagKeys', () => {
    it('revokes the active row, keeps it, and audits the reason', async () => {
        const h = harness();
        const a = await h.service.generateTagKeys(ctx(), 't1');
        const view = await h.service.revokeTagKeys(ctx(), 't1', { reason: 'keys leaked' });

        expect(view.status).toBe('REVOKED');
        expect(view.revokeReason).toBe('keys leaked');
        expect(h.rows).toHaveLength(1);
        expect(h.rows[0]!.id).toBe(a.key.id);
        expect(h.audits.at(-1)).toMatchObject({
            eventType: 'supply.tag-keys.revoke',
            before: { status: 'ACTIVE' },
            after: { status: 'REVOKED' },
        });
        expect(h.tagsUnchanged()).toBe(true);
    });

    it('lets a chip be re-keyed afterwards, keeping the old row', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't1');
        await h.service.revokeTagKeys(ctx(), 't1', { reason: 'rotate keys' });
        const second = await h.service.generateTagKeys(ctx(), 't1');

        expect(h.rows).toHaveLength(2);
        expect(h.rows.map((r) => r.status)).toEqual(['REVOKED', 'ACTIVE']);
        expect(second.key.status).toBe('ACTIVE');
    });

    it('answers 409 when there is nothing to revoke and 404 for an unknown chip', async () => {
        const h = harness();
        await expect(h.service.revokeTagKeys(ctx(), 't1', { reason: 'no keys yet' })).rejects.toMatchObject({
            code: 'SUPPLY_TAG_KEYS_NOT_ACTIVE',
        });
        await expect(h.service.revokeTagKeys(ctx(), 'nope', { reason: 'unknown' })).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('requires write access', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't1');
        await expect(
            h.service.revokeTagKeys(ctx(READ_ONLY), 't1', { reason: 'not allowed' }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(h.rows[0]!.status).toBe('ACTIVE');
    });
});

describe('getActiveKey', () => {
    it('returns metadata with no key or UID field', async () => {
        const h = harness();
        await h.service.generateTagKeys(ctx(), 't1');
        const view = await h.service.getActiveKey(READ_ONLY, 't1');

        expect(view).not.toBeNull();
        expect(Object.keys(view!).join(',')).not.toMatch(/Wrapped|uid|key0|key1|key2/i);
    });
});

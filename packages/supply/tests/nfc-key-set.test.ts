import pino from 'pino';
import { buildSupplyAccess } from '../src/domain/supply-access';
import type { IKeyWrapper } from '../src/domain/interfaces/key-wrapper.interface';
import type { ISupplyAudit, SupplyAuditInput } from '../src/domain/interfaces/supply-audit.interface';
import type { KeySetRow, NfcKeySetRepository, NewKeySet } from '../src/repository/nfc-key-set.repository';
import { NfcKeySetService } from '../src/service/nfc-key-set.service';

/**
 * Key set management, end to end through the service with in-memory
 * stand-ins for the repository and the KMS.
 *
 * The property most of these tests guard: no plaintext key is ever stored,
 * audited or published — it exists only in the single create response.
 */

const logger = pino({ level: 'silent' });
const KMS_REF = 'test-kms-ref';

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
const NOBODY = buildSupplyAccess({ userId: 'nobody-1', permissions: [], roles: [] });
const ctx = (access = ADMIN) => ({ access, correlationId: 'corr-1' });

/** Reversible and obviously not the plaintext: reversed bytes behind a tag. */
const wrapper: IKeyWrapper = {
    wrap: async (plain, ref) =>
        Buffer.concat([Buffer.from(`W[${ref}]`), Buffer.from(plain).reverse()]),
    unwrap: async (wrapped, ref) => {
        const head = Buffer.from(`W[${ref}]`);
        if (!wrapped.subarray(0, head.length).equals(head)) throw new Error('wrong ref');
        return Buffer.from(wrapped.subarray(head.length)).reverse();
    },
};

interface FakeTag {
    id: string;
    supplyBatchId: string;
    keySetId: string | null;
    personalizedAt: Date | null;
    lastTapCounter: number;
}

function harness(options: { withWrapper?: boolean } = {}) {
    const keySets: (KeySetRow & { key0Wrapped: Buffer; key1Wrapped: Buffer; key2Wrapped: Buffer })[] = [];
    const tags: FakeTag[] = [
        { id: 't1', supplyBatchId: 'batch-1', keySetId: null, personalizedAt: null, lastTapCounter: 0 },
        { id: 't2', supplyBatchId: 'batch-1', keySetId: null, personalizedAt: null, lastTapCounter: 0 },
        { id: 't3', supplyBatchId: 'batch-1', keySetId: 'other-set', personalizedAt: new Date(0), lastTapCounter: 7 },
        { id: 't4', supplyBatchId: 'batch-2', keySetId: null, personalizedAt: null, lastTapCounter: 0 },
    ];
    const batches = new Set(['batch-1', 'batch-2']);
    const audits: SupplyAuditInput[] = [];
    const events: { name: string; payload: unknown }[] = [];
    let next = 1;

    const keys = {
        async create(input: NewKeySet) {
            if (keySets.some((row) => row.keySetCode === input.keySetCode)) {
                throw Object.assign(new Error('unique'), { code: 'P2002' });
            }
            const row = {
                id: `ks-${next++}`,
                publicCode: `nks-public-${next}`,
                keySetCode: input.keySetCode,
                supplyBatchId: input.supplyBatchId,
                kmsKeyRef: input.kmsKeyRef,
                keyVersion: 1,
                status: 'ACTIVE' as const,
                retiredAt: null,
                retireReason: null,
                createdAt: new Date('2026-10-26T00:00:00Z'),
                key0Wrapped: input.key0Wrapped,
                key1Wrapped: input.key1Wrapped,
                key2Wrapped: input.key2Wrapped,
            };
            keySets.push(row);
            return viewOf(row);
        },
        async findById(id: string) {
            const row = keySets.find((r) => r.id === id);
            return row ? viewOf(row) : null;
        },
        async list() {
            return keySets.map(viewOf);
        },
        async batchExists(id: string) {
            return batches.has(id);
        },
        async personaliseBatch(p: { keySetId: string; supplyBatchId: string; now: Date }) {
            let count = 0;
            for (const tag of tags) {
                if (tag.supplyBatchId === p.supplyBatchId && tag.keySetId === null) {
                    tag.keySetId = p.keySetId;
                    tag.personalizedAt = p.now;
                    tag.lastTapCounter = -1;
                    count += 1;
                }
            }
            return count;
        },
        async retire(p: { id: string; reason: string; now: Date }) {
            const row = keySets.find((r) => r.id === p.id && r.status === 'ACTIVE');
            if (!row) return false;
            row.status = 'RETIRED';
            row.retiredAt = p.now;
            row.retireReason = p.reason;
            return true;
        },
    } as unknown as NfcKeySetRepository;

    const audit: ISupplyAudit = { record: async (input) => void audits.push(input) };
    const eventBus = {
        publish: jest.fn((name: string, payload: unknown) => void events.push({ name, payload })),
        subscribe: jest.fn(),
    };

    const service = new NfcKeySetService({
        keys,
        eventBus: eventBus as never,
        audit,
        logger,
        keyWrapper: options.withWrapper === false ? undefined : wrapper,
        kmsKeyRef: options.withWrapper === false ? undefined : KMS_REF,
    });
    return { service, keySets, tags, audits, events };
}

function viewOf(row: KeySetRow): KeySetRow {
    const { id, publicCode, keySetCode, supplyBatchId, kmsKeyRef, keyVersion, status, retiredAt, retireReason, createdAt } = row;
    return { id, publicCode, keySetCode, supplyBatchId, kmsKeyRef, keyVersion, status, retiredAt, retireReason, createdAt };
}

describe('createKeySet', () => {
    it('returns three different 16-byte keys, once, as hex', async () => {
        const h = harness();
        const created = await h.service.createKeySet(ctx(), { keySetCode: 'KS-2026-01' });

        const { key0, key1, key2 } = created.keys;
        for (const key of [key0, key1, key2]) expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(new Set([key0, key1, key2]).size).toBe(3);
        expect(created.status).toBe('ACTIVE');
    });

    it('stores only wrapped keys that unwrap to the returned ones', async () => {
        const h = harness();
        const created = await h.service.createKeySet(ctx(), { keySetCode: 'KS-2026-01' });
        const stored = h.keySets[0]!;

        const returned = [created.keys.key0, created.keys.key1, created.keys.key2];
        const blobs = [stored.key0Wrapped, stored.key1Wrapped, stored.key2Wrapped];
        for (const [index, blob] of blobs.entries()) {
            expect(blob.toString('hex')).not.toContain(returned[index]);
            expect((await wrapper.unwrap(blob, KMS_REF)).toString('hex')).toBe(returned[index]);
        }
    });

    it('puts no key in the audit record, the event or the list view', async () => {
        const h = harness();
        const created = await h.service.createKeySet(ctx(), { keySetCode: 'KS-2026-01' });
        const keysHex = Object.values(created.keys);

        const leaked = JSON.stringify([
            h.audits,
            h.events,
            await h.service.listKeySets(ADMIN, {}),
        ]);
        for (const key of keysHex) expect(leaked).not.toContain(key);
        expect(h.audits[0]!.eventType).toBe('supply.keyset.create');
        expect(h.audits[0]!.resourceType).toBe('NfcKeySet');
    });

    it('answers 503 when no key wrapper is configured, and stores nothing', async () => {
        const h = harness({ withWrapper: false });
        await expect(h.service.createKeySet(ctx(), { keySetCode: 'KS-1' })).rejects.toMatchObject({
            statusCode: 503,
        });
        expect(h.keySets).toHaveLength(0);
    });

    it('refuses a caller without the manage grant', async () => {
        const h = harness();
        await expect(h.service.createKeySet(ctx(READ_ONLY), { keySetCode: 'KS-1' })).rejects.toMatchObject({
            statusCode: 403,
        });
        await expect(h.service.createKeySet(ctx(NOBODY), { keySetCode: 'KS-1' })).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(h.keySets).toHaveLength(0);
    });

    it('answers 409 for a code already in use', async () => {
        const h = harness();
        await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await expect(h.service.createKeySet(ctx(), { keySetCode: 'KS-1' })).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    it('answers 404 for an unknown consignment', async () => {
        const h = harness();
        await expect(
            h.service.createKeySet(ctx(), { keySetCode: 'KS-1', supplyBatchId: 'nope' }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('personaliseBatchTags', () => {
    it("keys only the batch's un-keyed chips and resets their counter to -1", async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });

        const result = await h.service.personaliseBatchTags(ctx(), id, { supplyBatchId: 'batch-1' });

        expect(result.personalised).toBe(2);
        const byId = Object.fromEntries(h.tags.map((t) => [t.id, t]));
        expect(byId.t1).toMatchObject({ keySetId: id, lastTapCounter: -1 });
        expect(byId.t1!.personalizedAt).toBeInstanceOf(Date);
        expect(byId.t2).toMatchObject({ keySetId: id, lastTapCounter: -1 });
        // Already keyed by another set: not a re-key, so untouched.
        expect(byId.t3).toMatchObject({ keySetId: 'other-set', lastTapCounter: 7 });
        // Another consignment: untouched.
        expect(byId.t4).toMatchObject({ keySetId: null, lastTapCounter: 0 });
    });

    it('audits a count and the key set id, never UIDs or keys', async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await h.service.personaliseBatchTags(ctx(), id, { supplyBatchId: 'batch-1' });

        const audit = h.audits.find((a) => a.eventType === 'supply.tags.personalise')!;
        expect(audit.metadata).toEqual({ keySetId: id, personalised: 2 });
    });

    it('refuses a retired key set', async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await h.service.retireKeySet(ctx(), id, { reason: 'leaked' });
        await expect(
            h.service.personaliseBatchTags(ctx(), id, { supplyBatchId: 'batch-1' }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(h.tags.every((t) => t.keySetId !== id)).toBe(true);
    });

    it('answers 404 for an unknown key set or consignment', async () => {
        const h = harness();
        await expect(
            h.service.personaliseBatchTags(ctx(), 'missing', { supplyBatchId: 'batch-1' }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await expect(
            h.service.personaliseBatchTags(ctx(), id, { supplyBatchId: 'nope' }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a caller without the manage grant', async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await expect(
            h.service.personaliseBatchTags(ctx(READ_ONLY), id, { supplyBatchId: 'batch-1' }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('retireKeySet', () => {
    it('marks the set RETIRED with the reason and audits before/after', async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });

        const view = await h.service.retireKeySet(ctx(), id, { reason: 'key leaked' });

        expect(view.status).toBe('RETIRED');
        expect(view.retireReason).toBe('key leaked');
        expect(view.retiredAt).not.toBeNull();
        const audit = h.audits.find((a) => a.eventType === 'supply.keyset.retire')!;
        expect(audit.before).toEqual({ status: 'ACTIVE' });
        expect(audit.after).toEqual({ status: 'RETIRED' });
    });

    it('cannot be retired twice', async () => {
        const h = harness();
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await h.service.retireKeySet(ctx(), id, { reason: 'first' });
        await expect(h.service.retireKeySet(ctx(), id, { reason: 'second' })).rejects.toMatchObject({
            statusCode: 409,
        });
        expect(h.audits.filter((a) => a.eventType === 'supply.keyset.retire')).toHaveLength(1);
    });

    it('answers 404 for an unknown key set and 403 without the grant', async () => {
        const h = harness();
        await expect(h.service.retireKeySet(ctx(), 'missing', { reason: 'x1y' })).rejects.toMatchObject({
            statusCode: 404,
        });
        const { id } = await h.service.createKeySet(ctx(), { keySetCode: 'KS-1' });
        await expect(h.service.retireKeySet(ctx(READ_ONLY), id, { reason: 'x1y' })).rejects.toMatchObject({
            statusCode: 403,
        });
    });
});

describe('listKeySets', () => {
    it('needs tag-inventory access', async () => {
        const h = harness();
        await expect(h.service.listKeySets(NOBODY, {})).rejects.toMatchObject({ statusCode: 403 });
        await expect(h.service.listKeySets(READ_ONLY, {})).resolves.toEqual([]);
    });
});

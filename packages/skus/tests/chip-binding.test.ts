import {
    bindTagSchema,
    bulkBindTagsSchema,
    chipKeysBodySchema,
    chipReportQuerySchema,
    importChipKeysSchema,
    mintSkusSchema,
} from '../src/dto/sku.dto';
import { buildSkuAccess } from '../src/domain/sku-access';
import { chipStatusOf } from '../src/domain/chip-state';
import { SkuService } from '../src/service/sku.service';

/**
 * One chip model on every route: `{ uid, key0, key1, key2 }` instead of a bare
 * UID. The keys are what make a tap verifiable, so a chip without them is
 * refused, and the keys are never echoed, logged or audited.
 */

const UID_A = '04A39B2C5D6E80';
const UID_B = '04A39B2C5D6E81';
const K0 = '000102030405060708090A0B0C0D0E0F';
const K1 = '101112131415161718191A1B1C1D1E1F';
const K2 = '202122232425262728292A2B2C2D2E2F';
const chip = (uid = UID_A) => ({ uid, key0: K0, key1: K1, key2: K2 });

// ── Request shapes ──────────────────────────────────────────────────────────

describe('mint takes chips', () => {
    it('accepts exactly `count` keyed chips and normalises UID and keys', () => {
        const parsed = mintSkusSchema.parse({
            count: 2,
            chips: [
                { uid: '04:a3:9b:2c:5d:6e:80', key0: K0.toLowerCase(), key1: K1.match(/../g)!.join(':'), key2: K2 },
                chip(UID_B),
            ],
        });
        expect(parsed.chips![0]).toEqual(chip(UID_A));
    });

    it('requires the keys: a bare UID chip is refused', () => {
        const result = mintSkusSchema.safeParse({ count: 1, chips: [{ uid: UID_A }] });
        expect(result.success).toBe(false);
        const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
        expect(paths).toEqual(expect.arrayContaining(['chips.0.key0', 'chips.0.key1', 'chips.0.key2']));
    });

    it.each([
        ['one key missing', { uid: UID_A, key0: K0, key1: K1 }],
        ['a short key', { uid: UID_A, key0: 'ABC', key1: K1, key2: K2 }],
        ['two equal keys', { uid: UID_A, key0: K0, key1: K0, key2: K2 }],
        ['a UID that is not 7 bytes', { uid: '04A39B2C5D6E', key0: K0, key1: K1, key2: K2 }],
        ['a non-hex key', { uid: UID_A, key0: 'Z'.repeat(32), key1: K1, key2: K2 }],
    ])('refuses %s', (_label, bad) => {
        expect(mintSkusSchema.safeParse({ count: 1, chips: [bad] }).success).toBe(false);
    });

    it('refuses a count mismatch, a repeated chip, and chips together with tagIds', () => {
        expect(mintSkusSchema.safeParse({ count: 2, chips: [chip()] }).success).toBe(false);
        expect(mintSkusSchema.safeParse({ count: 2, chips: [chip(), chip()] }).success).toBe(false);
        expect(mintSkusSchema.safeParse({ count: 1, chips: [chip()], tagIds: [UID_A] }).success).toBe(false);
    });

    it('still accepts the deprecated tagIds', () => {
        expect(mintSkusSchema.safeParse({ count: 1, tagIds: [UID_A] }).success).toBe(true);
    });

    it('does not echo a key in a validation message', () => {
        const result = mintSkusSchema.safeParse({ count: 1, chips: [{ uid: UID_A, key0: K0, key1: K0, key2: K2 }] });
        expect(JSON.stringify(result)).not.toContain(K0);
    });
});

describe('PATCH /admin/skus/:skuId/tag takes one chip', () => {
    it('accepts chip, or the deprecated tagId, not both and not neither', () => {
        expect(bindTagSchema.safeParse({ chip: chip() }).success).toBe(true);
        expect(bindTagSchema.safeParse({ tagId: UID_A }).success).toBe(true);
        expect(bindTagSchema.safeParse({ chip: chip(), tagId: UID_A }).success).toBe(false);
        expect(bindTagSchema.safeParse({}).success).toBe(false);
        expect(bindTagSchema.safeParse({ chip: { uid: UID_A } }).success).toBe(false);
    });
});

describe('bulk bind takes the chip inline on each binding', () => {
    it('accepts uid + keys with serialNumber or skuCode', () => {
        const parsed = bulkBindTagsSchema.parse({
            bindings: [{ serialNumber: 1, ...chip(UID_A) }, { skuCode: 'X-000002', ...chip(UID_B) }],
        });
        expect(parsed.bindings[0]).toMatchObject({ serialNumber: 1, uid: UID_A, key0: K0 });
    });

    it('refuses a keyless binding, a mix of both forms, and a repeated chip', () => {
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, uid: UID_A }] }).success).toBe(false);
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, tagId: UID_A, ...chip() }] }).success).toBe(false);
        expect(
            bulkBindTagsSchema.safeParse({
                bindings: [{ serialNumber: 1, ...chip() }, { serialNumber: 2, ...chip() }],
            }).success,
        ).toBe(false);
    });

    it('still accepts the deprecated tagId form', () => {
        expect(bulkBindTagsSchema.safeParse({ bindings: [{ serialNumber: 1, tagId: UID_A }] }).success).toBe(true);
    });
});

describe('attaching keys later', () => {
    it('chip-keys body: three different 32-hex keys', () => {
        expect(chipKeysBodySchema.safeParse({ key0: K0, key1: K1, key2: K2 }).success).toBe(true);
        expect(chipKeysBodySchema.safeParse({ key0: K0, key1: K0, key2: K2 }).success).toBe(false);
        expect(chipKeysBodySchema.safeParse({ key0: K0, key1: K1 }).success).toBe(false);
    });

    it('import accepts rows, or the text of a CSV (header optional, serial or code)', () => {
        const rows = importChipKeysSchema.parse({ rows: [{ serialNumber: 1, key0: K0, key1: K1, key2: K2 }] });
        expect(rows.rows).toHaveLength(1);

        const csv = importChipKeysSchema.parse({
            csv: `serial,key0,key1,key2\n1,${K0},${K1},${K2}\n\nX-000002,${K2},${K1},${K0}\n`,
        });
        expect(csv.rows).toEqual([
            { serialNumber: 1, key0: K0, key1: K1, key2: K2 },
            { skuCode: 'X-000002', key0: K2, key1: K1, key2: K0 },
        ]);
    });

    it('import: exactly one of rows or csv; bad CSV lines are named by line, never by value', () => {
        expect(importChipKeysSchema.safeParse({}).success).toBe(false);
        expect(importChipKeysSchema.safeParse({ rows: [{ serialNumber: 1, key0: K0, key1: K1, key2: K2 }], csv: 'x' }).success).toBe(false);

        const bad = importChipKeysSchema.safeParse({ csv: `1,${K0},${K0},${K2}\n2,short,${K1},${K2}` });
        expect(bad.success).toBe(false);
        const text = JSON.stringify(bad);
        expect(text).toContain('line 1');
        expect(text).toContain('line 2');
        expect(text).not.toContain(K0);
        expect(text).not.toContain(K2);
    });

    it('import: the same unit twice is refused', () => {
        const dup = importChipKeysSchema.safeParse({
            rows: [
                { serialNumber: 1, key0: K0, key1: K1, key2: K2 },
                { serialNumber: 1, key0: K2, key1: K1, key2: K0 },
            ],
        });
        expect(dup.success).toBe(false);
    });

    it('report query defaults to every unverifiable unit', () => {
        expect(chipReportQuerySchema.parse({})).toMatchObject({ state: 'ALL', page: 1 });
        expect(chipReportQuerySchema.safeParse({ state: 'NOPE' }).success).toBe(false);
    });
});

// ── Chip state on reads ─────────────────────────────────────────────────────

describe('chipStatusOf: can a tap on this unit be verified?', () => {
    const linked = (lifecycleState: string, keys: number) => ({
        tagId: UID_A,
        currentNfcTagId: 'tag-1',
        currentNfcTag: { lifecycleState: lifecycleState as never, keys: Array(keys).fill({ id: 'k' }) },
    });

    it.each([
        ['no chip', { tagId: null }, 'NONE', false],
        ['a bare UID only', { tagId: UID_A }, 'UID_ONLY', false],
        ['linked, no keys', linked('BOUND', 0), 'LINKED_NO_KEYS', false],
        ['linked BOUND with keys', linked('BOUND', 1), 'VERIFIABLE', true],
        ['linked ACTIVE with keys', linked('ACTIVE', 1), 'VERIFIABLE', true],
        ['a revoked chip', linked('REVOKED', 1), 'INACTIVE', false],
        ['a lost chip', linked('LOST', 1), 'INACTIVE', false],
    ])('%s', (_label, facts, state, verifiable) => {
        expect(chipStatusOf(facts as never)).toEqual({ state, verifiable });
    });
});

// ── The service: mint, bind, re-tag, keys ───────────────────────────────────

const ACCESS = buildSkuAccess({
    userId: 'admin-1',
    permissions: ['collectible-instance:manage:global', 'nfc-tag-claim:manage:global', 'nfc-tag-claim:read:global'],
    roles: [],
});
const NO_TAG_ACCESS = buildSkuAccess({
    userId: 'drop-manager',
    permissions: ['collectible-instance:manage:global'],
    roles: [],
});

function target(over: Record<string, unknown> = {}) {
    return {
        id: 'sku-1', skuCode: 'TEE-000001', serialNumber: 1, productId: 'p1', variantId: null,
        tagId: null, currentNfcTagId: null, tagLifecycleState: 'UNPROVISIONED', claimedStatus: 'UNCLAIMED',
        chipHasKeys: false, ...over,
    };
}

function build(opts: { targets?: ReturnType<typeof target>[]; registry?: boolean } = {}) {
    const tx = { __tx: true };
    const targets = opts.targets ?? [target()];
    const attachWithin = jest.fn(async (_tx: unknown, input: { chips: unknown[] }) =>
        input.chips.map((_c, i) => ({ nfcTagId: `chip-${i + 1}`, created: true, keysWritten: true })));
    const addKeysManyWithin = jest.fn(async () => undefined);
    const revokeWithin = jest.fn(async () => undefined);
    const skus = {
        findProduct: async () => ({ id: 'p1', groupCode: 'TEE', name: 'Tee', organizationId: null, status: 'ACTIVE', totalSupply: 0 }),
        variantBelongsTo: async () => true,
        findBoundTags: jest.fn(async () => []),
        runInTransaction: async (fn: (t: unknown) => unknown) => fn(tx),
        countForProduct: async () => 0,
        variantCapWithin: async () => null,
        mintWithin: jest.fn(async (_t: unknown, spec: { count: number; tagIds?: string[] }) => ({
            outcome: {
                minted: spec.count, firstSerial: 1, lastSerial: spec.count,
                skuCodes: Array.from({ length: spec.count }, (_, i) => `TEE-00000${i + 1}`),
                tagsBound: spec.tagIds?.length ?? 0,
            },
            units: [],
        })),
        findForBinding: jest.fn(async () => targets),
        findByIdForBinding: jest.fn(async () => targets[0] ?? null),
        findForChipKeys: jest.fn(async () => targets),
        findDetail: jest.fn(async () => ({ id: 'sku-1', drop: { organizationId: null } })),
        bindChipsWithin: jest.fn(async () => undefined),
        bindTagsWithin: jest.fn(async () => undefined),
        chipReport: jest.fn(async () => ({ total: 0, items: [] })),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const logs: unknown[][] = [];
    const logger = {
        warn: (...a: unknown[]) => void logs.push(a),
        info: (...a: unknown[]) => void logs.push(a),
        error: (...a: unknown[]) => void logs.push(a),
    };
    const service = new SkuService({
        skus: skus as never,
        eventBus: { publish: async () => undefined, subscribe: () => ({ unsubscribe() { } }) } as never,
        audit,
        logger: logger as never,
        chipRegistry: opts.registry === false ? undefined : ({ attachWithin, addKeysManyWithin, revokeWithin } as never),
    });
    // A service built this way must not be able to leak: capture everything it can emit.
    const leaked = (result: unknown) =>
        JSON.stringify([result, audit.record.mock.calls, logs]);
    return { service, skus, audit, logs, tx, attachWithin, addKeysManyWithin, revokeWithin, leaked };
}

describe('mint with chips', () => {
    it('makes the chips verifiable first (NfcTag + keys), then mints units already pointing at them', async () => {
        const t = build();
        const result = await t.service.mint(ACCESS, 'p1', { count: 2, chips: [chip(UID_A), chip(UID_B)], isActive: true } as never);

        expect(t.attachWithin).toHaveBeenCalledWith(t.tx, expect.objectContaining({
            chips: [expect.objectContaining({ uid: UID_A, key0: K0 }), expect.objectContaining({ uid: UID_B })],
            createdById: 'admin-1',
        }));
        const spec = (t.skus.mintWithin.mock.calls[0] as unknown as [unknown, { nfcTagIds: string[]; tagIds: string[] }])[1];
        expect(spec.nfcTagIds).toEqual(['chip-1', 'chip-2']);
        expect(spec.tagIds).toEqual([UID_A, UID_B]); // the legacy UID is only a mirror
        expect(result).toMatchObject({ minted: 2, withKeys: 2, chipsVerifiable: 2 });
    });

    it('audits the bind with counts only, and leaks no key or UID anywhere', async () => {
        const t = build();
        const result = await t.service.mint(ACCESS, 'p1', { count: 1, chips: [chip()], isActive: true } as never);
        expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'sku.chip.bind',
            metadata: expect.objectContaining({ source: 'mint', units: 1, withKeys: 1 }),
        }));
        const everything = t.leaked(result);
        for (const secret of [K0, K1, K2, UID_A]) expect(everything).not.toContain(secret);
    });

    it('the deprecated tagIds still mint, with a warning, and report chipsVerifiable 0', async () => {
        const t = build();
        const result = await t.service.mint(ACCESS, 'p1', { count: 1, tagIds: [UID_A], isActive: true } as never);
        expect(result).toMatchObject({ tagsBound: 1, withKeys: 0, chipsVerifiable: 0 });
        expect(t.attachWithin).not.toHaveBeenCalled();
        expect(JSON.stringify(t.logs)).toContain('deprecated');
        expect(t.audit.record).not.toHaveBeenCalled();
    });

    it('is a 503, not a silent bare UID, when no chip registry is wired', async () => {
        const t = build({ registry: false });
        await expect(
            t.service.mint(ACCESS, 'p1', { count: 1, chips: [chip()], isActive: true } as never),
        ).rejects.toMatchObject({ statusCode: 503, code: 'SKUS_CHIP_REGISTRY_UNAVAILABLE' });
        expect(t.skus.mintWithin).not.toHaveBeenCalled();
    });

    it('needs tag custody to bind chips at mint time', async () => {
        const t = build();
        await expect(
            t.service.mint(NO_TAG_ACCESS, 'p1', { count: 1, chips: [chip()], isActive: true } as never),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('bulk bind', () => {
    const body = (extra: Record<string, unknown> = {}) =>
        bulkBindTagsSchema.parse({ bindings: [{ serialNumber: 1, ...chip() }], ...extra });

    it('creates and links the chip, binds the unit, and reports counts only', async () => {
        const t = build();
        const result = await t.service.bulkBindTags(ACCESS, 'p1', body());

        expect(t.attachWithin).toHaveBeenCalledWith(t.tx, expect.objectContaining({ forSkuIds: ['sku-1'] }));
        expect(t.skus.bindChipsWithin).toHaveBeenCalledWith(t.tx, [
            expect.objectContaining({ skuId: 'sku-1', nfcTagId: 'chip-1', uid: UID_A }),
        ]);
        expect(result).toMatchObject({ bound: 1, withKeys: 1, chipsVerifiable: 1 });
        expect(result.items[0]).toEqual({ skuCode: 'TEE-000001', serialNumber: 1, replaced: false, verifiable: true });
        const everything = t.leaked(result);
        for (const secret of [K0, K1, K2, UID_A]) expect(everything).not.toContain(secret);
    });

    it('is all-or-nothing: a chip the registry refuses writes no binding', async () => {
        const t = build();
        t.attachWithin.mockRejectedValueOnce(Object.assign(new Error('taken'), { statusCode: 409 }));
        await expect(t.service.bulkBindTags(ACCESS, 'p1', body())).rejects.toThrow('taken');
        expect(t.skus.bindChipsWithin).not.toHaveBeenCalled();
    });

    it('the deprecated tagId form binds a bare UID, warns, and reports chipsVerifiable 0', async () => {
        const t = build();
        const dto = bulkBindTagsSchema.parse({ bindings: [{ serialNumber: 1, tagId: UID_A }] });
        const result = await t.service.bulkBindTags(ACCESS, 'p1', dto);
        expect(t.attachWithin).not.toHaveBeenCalled();
        expect(t.skus.bindTagsWithin).toHaveBeenCalled();
        expect(result).toMatchObject({ bound: 1, withKeys: 0, chipsVerifiable: 0 });
        expect(result.items[0]).toMatchObject({ tagId: UID_A, verifiable: false });
        expect(JSON.stringify(t.logs)).toContain('deprecated');
    });

    it('refuses a bare UID on a unit that already has a verifiable chip', async () => {
        const t = build({ targets: [target({ currentNfcTagId: 'old', chipHasKeys: true, tagLifecycleState: 'BOUND' })] });
        const dto = bulkBindTagsSchema.parse({ bindings: [{ serialNumber: 1, tagId: UID_B }], replace: true });
        await expect(t.service.bulkBindTags(ACCESS, 'p1', dto)).rejects.toMatchObject({ statusCode: 409 });
    });
});

describe('re-tagging a unit', () => {
    const withChip = (over: Record<string, unknown> = {}) =>
        build({ targets: [target({ currentNfcTagId: 'old-chip', tagId: UID_A, chipHasKeys: true, tagLifecycleState: 'BOUND', ...over })] });
    const bindChip = (uid = UID_B, replace = false) => bindTagSchema.parse({ chip: chip(uid), replace });

    it('without replace, a different chip is refused and nothing is written', async () => {
        const t = withChip();
        await expect(t.service.bindTag(ACCESS, 'sku-1', bindChip())).rejects.toMatchObject({
            statusCode: 409, code: 'SKUS_TAG_ALREADY_BOUND',
        });
        expect(t.skus.bindChipsWithin).not.toHaveBeenCalled();
        expect(t.revokeWithin).not.toHaveBeenCalled();
    });

    it('with replace, the new chip is bound and the old one is revoked', async () => {
        const t = withChip();
        await t.service.bindTag(ACCESS, 'sku-1', bindChip(UID_B, true)).catch(() => undefined);
        expect(t.skus.bindChipsWithin).toHaveBeenCalledWith(t.tx, [expect.objectContaining({ nfcTagId: 'chip-1' })]);
        expect(t.revokeWithin).toHaveBeenCalledWith(t.tx, expect.objectContaining({ nfcTagId: 'old-chip' }));
        expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'sku.chip.bind', skuId: 'sku-1',
            metadata: expect.objectContaining({ source: 'bind', replaced: 1 }),
        }));
    });

    it('sending the unit\'s own chip again is idempotent: no replace needed, no revoke', async () => {
        const t = withChip();
        t.attachWithin.mockResolvedValueOnce([{ nfcTagId: 'old-chip', created: false, keysWritten: false }]);
        await t.service.bindTag(ACCESS, 'sku-1', bindChip(UID_A)).catch(() => undefined);
        expect(t.revokeWithin).not.toHaveBeenCalled();
        expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ replaced: 0 }),
        }));
    });

    it('a claimed unit whose chip is healthy cannot be re-tagged, even with replace', async () => {
        const t = withChip({ claimedStatus: 'CLAIMED' });
        await expect(t.service.bindTag(ACCESS, 'sku-1', bindChip(UID_B, true))).rejects.toMatchObject({
            code: 'SKUS_TAG_REPLACE_REFUSED',
        });
        expect(t.skus.bindChipsWithin).not.toHaveBeenCalled();
    });

    it('a claimed unit whose chip is LOST can be re-tagged', async () => {
        const t = withChip({ claimedStatus: 'CLAIMED', tagLifecycleState: 'LOST' });
        await t.service.bindTag(ACCESS, 'sku-1', bindChip(UID_B, true)).catch(() => undefined);
        expect(t.revokeWithin).toHaveBeenCalled();
    });
});

describe('keys for chips that are already bound', () => {
    const keys = { key0: K0, key1: K1, key2: K2 };

    it('a linked chip with no keys gets its keys (batch call, one chip)', async () => {
        const t = build({ targets: [target({ currentNfcTagId: 'tag-9', tagId: null })] });
        const result = await t.service.addChipKeys(ACCESS, 'sku-1', keys);
        expect(t.addKeysManyWithin).toHaveBeenCalledWith(t.tx, {
            items: [{ nfcTagId: 'tag-9', ...keys }],
            createdById: 'admin-1',
        });
        expect(result).toEqual({ skuId: 'sku-1', skuCode: 'TEE-000001', verifiable: true });
        const everything = t.leaked(result);
        for (const secret of [K0, K1, K2]) expect(everything).not.toContain(secret);
        expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'sku.chip.keys', skuId: 'sku-1' }));
    });

    it('a bare-UID unit gets an NfcTag created from the UID it already carries, and is linked', async () => {
        const t = build({ targets: [target({ tagId: UID_A, currentNfcTagId: null })] });
        await t.service.addChipKeys(ACCESS, 'sku-1', keys);
        expect(t.attachWithin).toHaveBeenCalledWith(t.tx, expect.objectContaining({
            chips: [expect.objectContaining({ uid: UID_A, ...keys })],
            forSkuIds: ['sku-1'],
        }));
        expect(t.skus.bindChipsWithin).toHaveBeenCalledWith(t.tx, [
            expect.objectContaining({ skuId: 'sku-1', nfcTagId: 'chip-1', uid: UID_A }),
        ]);
    });

    it('a unit with no chip at all is refused', async () => {
        const t = build({ targets: [target()] });
        await expect(t.service.addChipKeys(ACCESS, 'sku-1', keys)).rejects.toMatchObject({ code: 'SKUS_NO_CHIP' });
    });

    it('the CSV/rows import attaches in one transaction and refuses the whole file on any bad row', async () => {
        const ok = build({
            targets: [
                target({ id: 's1', skuCode: 'TEE-000001', serialNumber: 1, currentNfcTagId: 'tag-1', tagId: null }),
                target({ id: 's2', skuCode: 'TEE-000002', serialNumber: 2, tagId: UID_B, currentNfcTagId: null }),
            ],
        });
        const dto = importChipKeysSchema.parse({
            rows: [{ serialNumber: 1, ...keys }, { serialNumber: 2, key0: K2, key1: K1, key2: K0 }],
        });
        const result = await ok.service.importChipKeys(ACCESS, 'p1', dto);
        expect(result.attached).toBe(2);
        expect(ok.addKeysManyWithin).toHaveBeenCalledTimes(1);
        expect(ok.attachWithin).toHaveBeenCalledTimes(1);
        expect(ok.leaked(result)).not.toContain(K0);

        const bad = build({ targets: [target({ chipHasKeys: true, currentNfcTagId: 'tag-1' })] });
        await expect(bad.service.importChipKeys(ACCESS, 'p1', dto)).rejects.toMatchObject({ statusCode: 409 });
        expect(bad.addKeysManyWithin).not.toHaveBeenCalled();
        expect(bad.attachWithin).not.toHaveBeenCalled();
    });

    it('the report lists units by what is wrong with their chip, with no UID or key', async () => {
        const t = build();
        t.skus.chipReport.mockResolvedValueOnce({
            total: 2,
            items: [
                { id: 'a', skuCode: 'TEE-000001', serialNumber: 1, productId: 'p1', currentNfcTagId: null },
                { id: 'b', skuCode: 'TEE-000002', serialNumber: 2, productId: 'p1', currentNfcTagId: 'tag-2' },
            ],
        });
        const report = await t.service.chipReport(ACCESS, chipReportQuerySchema.parse({}));
        expect(report.items.map((item) => item.state)).toEqual(['UID_ONLY', 'LINKED_NO_KEYS']);
        expect(report.meta.total).toBe(2);
        for (const item of report.items) expect(Object.keys(item)).toEqual(['skuId', 'skuCode', 'serialNumber', 'productId', 'state']);
    });

    it('all of it needs tag custody', async () => {
        const t = build();
        await expect(t.service.addChipKeys(NO_TAG_ACCESS, 'sku-1', keys)).rejects.toMatchObject({ statusCode: 403 });
        await expect(t.service.chipReport(NO_TAG_ACCESS, chipReportQuerySchema.parse({}))).rejects.toMatchObject({ statusCode: 403 });
    });
});

import pino from 'pino';
import { SupplyBatchStatus, SupplyItemType } from '@hitbox/database';
import { buildSupplyAccess } from '../src/domain/supply-access';
import { createBatchSchema, updateBatchLinesSchema } from '../src/dto/supply.dto';
import { SupplyRepository } from '../src/repository/supply.repository';
import { SupplyService } from '../src/service/supply.service';

/**
 * A consignment of a drop whose type REQUIRES variants must say which variants,
 * at booking time. Before this, such a booking was accepted without lines, could
 * never be ACCEPTED (409 PRODUCTS_VARIANTS_REQUIRED), and no route could add
 * lines to it. Now it is refused up front, and a bad booking can be corrected.
 */

const logger = pino({ level: 'silent' });
const DROP = 'd0000000-0000-4000-8000-000000000001';
const VENDOR = 'e0000000-0000-4000-8000-000000000001';
const V_M = 'a0000000-0000-4000-8000-00000000000a';
const V_L = 'a0000000-0000-4000-8000-00000000000b';
const V_OLD = 'a0000000-0000-4000-8000-00000000000c';

const ADMIN = buildSupplyAccess({
    userId: 'admin-1',
    permissions: ['drop:manage:global', 'nfc-tag-claim:manage:global'],
    roles: [],
});

const NOW = new Date('2026-11-24T10:00:00Z');
/** Everything `toBatchResponse` reads. */
const batchRow = (over: Record<string, unknown> = {}) => ({
    id: 'batch-1', vendorId: VENDOR, vendor: null, dropId: DROP, drop: null, itemType: SupplyItemType.APPAREL,
    status: SupplyBatchStatus.UPLOADED, quantity: 10, batchRef: null, vendorInvoiceRef: null,
    receivedAt: NOW, batchDate: NOW, rowsReceived: 0, rowsAccepted: 0, rowsRejected: 0,
    sourceFileRef: null, validationReportRef: null, enteredById: 'admin-1', notes: null,
    createdAt: NOW, updatedAt: NOW, lines: [], _count: { nfcTags: 0 }, ...over,
});

const liveVariant = (id: string) => ({
    id, variantCode: id.slice(-1), label: id.slice(-1), optionsKey: id, position: 1, isActive: true, archivedAt: null,
});

function build(opts: {
    mode?: 'NONE' | 'OPTIONAL' | 'REQUIRED' | null;
    variants?: ReturnType<typeof liveVariant>[];
    batch?: Record<string, unknown>;
} = {}) {
    const created: unknown[] = [];
    const audits: any[] = [];
    const replaceBatchLines = jest.fn(async (input: { lines: { variantId: string; quantity: number }[] }) =>
        batchRow({
            rowsReceived: 4, rowsAccepted: 4,
            lines: input.lines.map((line) => ({ ...line, variant: { variantCode: 'X', label: 'X', position: 1 }, rowsReceived: 0, rowsAccepted: 0, rowsRejected: 0 })),
            _count: { nfcTags: 4 },
        }));
    const supply = {
        findVendorById: async () => ({ id: VENDOR, archivedAt: null }),
        findDropOrganization: async () => null,
        findDropVariantRule: jest.fn(async () => (opts.mode === null ? null : { variantMode: opts.mode ?? 'REQUIRED', typeCode: 'TSHIRT' })),
        findDropVariants: async () => opts.variants ?? [liveVariant(V_M), liveVariant(V_L)],
        createBatch: jest.fn(async (data: Record<string, unknown>) => {
            created.push(data);
            return batchRow({ itemType: data.itemType, quantity: data.quantity });
        }),
        findBatchById: async () => batchRow({ rowsReceived: 4, ...(opts.batch ?? {}) }),
        replaceBatchLines,
    } as unknown as SupplyRepository;
    const service = new SupplyService({
        supply,
        eventBus: { publish() { }, subscribe() { } } as never,
        audit: { record: async (input) => void audits.push(input) },
        logger,
    });
    return { service, supply, created, audits, replaceBatchLines };
}

const booking = (over: Record<string, unknown> = {}) =>
    createBatchSchema.parse({ vendorId: VENDOR, dropId: DROP, itemType: 'APPAREL', quantity: 10, ...over });

describe('booking a consignment: the drop\'s type decides', () => {
    it('REQUIRED and no lines: 422 SUPPLY_VARIANT_LINES_REQUIRED, nothing is written', async () => {
        const t = build();
        await expect(t.service.createBatch({ access: ADMIN, correlationId: 'c' }, booking())).rejects.toMatchObject({
            statusCode: 422, code: 'SUPPLY_VARIANT_LINES_REQUIRED',
        });
        expect(t.created).toHaveLength(0);
    });

    it('REQUIRED but the drop has no live variant: 409 PRODUCTS_VARIANTS_REQUIRED', async () => {
        const t = build({ variants: [] });
        await expect(t.service.createBatch({ access: ADMIN, correlationId: 'c' }, booking())).rejects.toMatchObject({
            statusCode: 409, code: 'PRODUCTS_VARIANTS_REQUIRED',
        });
        const archived = build({ variants: [{ ...liveVariant(V_M), isActive: false }] });
        await expect(archived.service.createBatch({ access: ADMIN, correlationId: 'c' }, booking())).rejects.toMatchObject({
            code: 'PRODUCTS_VARIANTS_REQUIRED',
        });
        expect(archived.created).toHaveLength(0);
    });

    it('REQUIRED with lines books, and the lines are what is written', async () => {
        const t = build();
        const dto = booking({ quantity: undefined, lines: [{ variantId: V_M, quantity: 6 }, { variantId: V_L, quantity: 4 }] });
        await t.service.createBatch({ access: ADMIN, correlationId: 'c' }, dto);
        expect(t.created[0]).toMatchObject({ quantity: 10, lines: [{ variantId: V_M, quantity: 6 }, { variantId: V_L, quantity: 4 }] });
    });

    it.each([
        ['OPTIONAL', 'OPTIONAL' as const],
        ['NONE', 'NONE' as const],
        ['a legacy untyped drop', null],
    ])('%s: a booking with no lines is fine', async (_label, mode) => {
        const t = build({ mode });
        await t.service.createBatch({ access: ADMIN, correlationId: 'c' }, booking());
        expect(t.created).toHaveLength(1);
    });

    it('a consignment with no drop is not held to it (chip stock is bought ahead of any drop)', async () => {
        const noDrop = build();
        await noDrop.service.createBatch({ access: ADMIN, correlationId: 'c' }, createBatchSchema.parse({ vendorId: VENDOR, itemType: 'APPAREL', quantity: 5 }));
        expect(noDrop.supply.findDropVariantRule).not.toHaveBeenCalled();
        expect(noDrop.created).toHaveLength(1);
    });

    it('the vendor portal books through the same check', async () => {
        // The portal calls bookConsignment, which is where the rule lives.
        const t = build();
        await expect(
            t.service.bookConsignment({
                actorId: 'vendor-user', actorType: 'VENDOR', correlationId: 'c', organizationId: null,
                dto: { ...booking(), vendorId: VENDOR },
            }),
        ).rejects.toMatchObject({ code: 'SUPPLY_VARIANT_LINES_REQUIRED' });
    });
});

describe('PATCH /admin/supply/batches/:batchId/lines', () => {
    const lines = [{ variantId: V_M, quantity: 6 }, { variantId: V_L, quantity: 4 }];
    const dto = () => updateBatchLinesSchema.parse({ lines });

    it('replaces the lines of an open consignment and audits before/after', async () => {
        const t = build();
        const result = await t.service.updateBatchLines({ access: ADMIN, correlationId: 'c' }, 'batch-1', dto());
        expect(t.replaceBatchLines).toHaveBeenCalledWith({ batchId: 'batch-1', lines });
        expect(result.lines.map((line) => line.variantId)).toEqual([V_M, V_L]);
        expect(t.audits[0]).toMatchObject({
            eventType: 'supply.batch.lines',
            resourceId: 'batch-1',
            before: { lines: [] },
            after: { lines: [{ variantId: V_M, quantity: 6 }, { variantId: V_L, quantity: 4 }] },
        });
    });

    it.each([
        ['ACCEPTED', SupplyBatchStatus.ACCEPTED],
        ['REJECTED', SupplyBatchStatus.REJECTED],
    ])('a %s consignment cannot be changed', async (_label, status) => {
        const t = build({ batch: { status } });
        await expect(t.service.updateBatchLines({ access: ADMIN, correlationId: 'c' }, 'batch-1', dto())).rejects.toMatchObject({
            statusCode: 409, code: 'SUPPLY_BATCH_STATE_INVALID',
        });
        expect(t.replaceBatchLines).not.toHaveBeenCalled();
    });

    it('a variant that is not a live variant of the drop is refused', async () => {
        const t = build({ variants: [liveVariant(V_M)] });
        await expect(t.service.updateBatchLines({ access: ADMIN, correlationId: 'c' }, 'batch-1', dto())).rejects.toMatchObject({
            code: 'SUPPLY_VARIANT_INVALID',
        });
        expect(t.replaceBatchLines).not.toHaveBeenCalled();
    });

    it('a consignment that is not for a drop has no lines to correct', async () => {
        const t = build({ batch: { dropId: null } });
        await expect(t.service.updateBatchLines({ access: ADMIN, correlationId: 'c' }, 'batch-1', dto())).rejects.toMatchObject({ statusCode: 400 });
    });

    it('needs the write capability', async () => {
        const t = build();
        const reader = buildSupplyAccess({ userId: 'u', permissions: ['drop:read:global'], roles: [] });
        await expect(t.service.updateBatchLines({ access: reader, correlationId: 'c' }, 'batch-1', dto())).rejects.toMatchObject({ statusCode: 403 });
    });

    it('the body is lines only, each variant once', () => {
        expect(updateBatchLinesSchema.safeParse({ lines: [{ variantId: V_M, quantity: 1 }, { variantId: V_M, quantity: 2 }] }).success).toBe(false);
        expect(updateBatchLinesSchema.safeParse({ lines: [] }).success).toBe(false);
        expect(updateBatchLinesSchema.safeParse({ lines, extra: 1 }).success).toBe(false);
    });
});

// ── The transaction: chips already registered are re-pointed ─────────────────

function repoOver(opts: { status?: SupplyBatchStatus; quantity?: number; tags: { id: string; variantId: string | null; qcStatus?: string }[] }) {
    const tags = opts.tags.map((tag) => ({ qcStatus: 'PASSED', ...tag }));
    const writes: { updateMany: unknown[]; deleted: unknown[]; created: any[] } = { updateMany: [], deleted: [], created: [] };
    const tx: any = {
        $queryRaw: async () => [{ status: opts.status ?? SupplyBatchStatus.UPLOADED, quantity: opts.quantity ?? 10, rowsReceived: tags.length }],
        nfcTag: {
            findMany: async () => tags,
            updateMany: async (args: any) => {
                writes.updateMany.push(args);
                for (const tag of tags) if (args.where.id.in.includes(tag.id)) tag.variantId = args.data.variantId;
                return { count: args.where.id.in.length };
            },
        },
        supplyBatchLine: {
            deleteMany: async (args: unknown) => void writes.deleted.push(args),
            createMany: async ({ data }: { data: unknown[] }) => void writes.created.push(...data),
        },
        supplyBatch: { findUniqueOrThrow: async () => ({ id: 'batch-1', lines: writes.created }) },
    };
    const repo = new SupplyRepository({ $transaction: async (work: (t: unknown) => unknown) => work(tx) } as never);
    return { repo, tags, writes };
}

describe('SupplyRepository.replaceBatchLines', () => {
    const lines = (...q: [string, number][]) => q.map(([variantId, quantity]) => ({ variantId, quantity }));

    it('gives variant-less chips a variant, oldest first, line by line, and recomputes the counters', async () => {
        const { repo, tags, writes } = repoOver({
            tags: [
                { id: 't1', variantId: null }, { id: 't2', variantId: null }, { id: 't3', variantId: null, qcStatus: 'FAILED' },
                { id: 't4', variantId: null },
            ],
        });
        await repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 6], [V_L, 4]) });

        // M has room for 6, so all four chips go to M (in order); L stays empty.
        expect(tags.map((t) => t.variantId)).toEqual([V_M, V_M, V_M, V_M]);
        expect(writes.deleted).toHaveLength(1);
        expect(writes.created).toEqual([
            expect.objectContaining({ variantId: V_M, quantity: 6, rowsReceived: 4, rowsAccepted: 3, rowsRejected: 1 }),
            expect.objectContaining({ variantId: V_L, quantity: 4, rowsReceived: 0, rowsAccepted: 0, rowsRejected: 0 }),
        ]);
    });

    it('fills each line up to its quantity before moving to the next', async () => {
        const { repo, tags } = repoOver({
            quantity: 4,
            tags: [{ id: 't1', variantId: null }, { id: 't2', variantId: null }, { id: 't3', variantId: null }, { id: 't4', variantId: null }],
        });
        await repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 3], [V_L, 1]) });
        expect(tags.map((t) => t.variantId)).toEqual([V_M, V_M, V_M, V_L]);
    });

    it('keeps chips that already have a variant on that variant, and counts them against its line', async () => {
        const { repo, tags, writes } = repoOver({
            quantity: 4,
            tags: [{ id: 't1', variantId: V_M }, { id: 't2', variantId: V_M }, { id: 't3', variantId: null }, { id: 't4', variantId: null }],
        });
        await repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 3], [V_L, 1]) });
        expect(tags.map((t) => t.variantId)).toEqual([V_M, V_M, V_M, V_L]);
        expect(writes.created[0]).toMatchObject({ variantId: V_M, rowsReceived: 3 });
    });

    it('refuses lines that drop a variant chips are already on', async () => {
        const { repo } = repoOver({ tags: [{ id: 't1', variantId: V_OLD }] });
        await expect(repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 6], [V_L, 4]) })).rejects.toMatchObject({
            statusCode: 409, code: 'SUPPLY_LINES_LOCKED',
        });
    });

    it('refuses lines that do not add up to the declared quantity', async () => {
        const { repo } = repoOver({ tags: [] });
        await expect(repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 6], [V_L, 3]) })).rejects.toMatchObject({
            statusCode: 400, code: 'SUPPLY_LINES_QUANTITY_MISMATCH',
        });
    });

    it('refuses a line smaller than the chips already on its variant', async () => {
        const { repo } = repoOver({ quantity: 4, tags: [{ id: 't1', variantId: V_M }, { id: 't2', variantId: V_M }, { id: 't3', variantId: V_M }] });
        await expect(repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 2], [V_L, 2]) })).rejects.toMatchObject({
            code: 'SUPPLY_LINE_QUANTITY_EXCEEDED',
        });
    });

    it('is refused once the consignment is accepted, and writes nothing', async () => {
        const { repo, writes } = repoOver({ status: SupplyBatchStatus.ACCEPTED, tags: [] });
        await expect(repo.replaceBatchLines({ batchId: 'batch-1', lines: lines([V_M, 10]) })).rejects.toMatchObject({
            code: 'SUPPLY_BATCH_STATE_INVALID',
        });
        expect(writes.deleted).toHaveLength(0);
        expect(writes.created).toHaveLength(0);
    });
});

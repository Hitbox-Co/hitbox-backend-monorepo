import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ClaimedStatus, TagLifecycleState } from '@hitbox/database';
import { SkuService } from '../src/service/sku.service';
import { batchUpdateSkusSchema } from '../src/dto/sku.dto';
import { ReadScope, Visibility } from '../src/domain/sku-access';
import type { SkuAccess } from '../src/domain/sku-access';

/**
 * The batch edit, against fakes.
 *
 * What is pinned here is the property the endpoint lives or dies on: **it is
 * all or nothing**. An operator who selects 400 rows and gets "312 of them
 * worked" has a reconciliation problem that the database cannot help them
 * with — which unit took the change is a question only the warehouse can
 * answer. So a single refusal has to leave the table untouched.
 *
 * The other half is the opposite mistake: refusing the whole batch because 13
 * of 200 units were *already* in the requested state. That is ordinary, it is
 * what selecting a filtered list looks like, and treating it as a failure would
 * make the endpoint unusable for its actual purpose.
 */

const PRODUCT = {
    id: 'product-1',
    groupCode: '123456780042',
    name: 'Neon Drift',
    organizationId: 'org-1',
    status: 'ACTIVE',
    totalSupply: 500,
};

/** Unit ids are uuids on the wire, so the fixtures use real ones. */
const skuId = (serial: number) => `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;

const row = (serial: number, overrides: Record<string, unknown> = {}) => ({
    id: skuId(serial),
    skuCode: `123456780042-${String(serial).padStart(6, '0')}`,
    serialNumber: serial,
    productId: 'product-1',
    variantId: null,
    claimedStatus: ClaimedStatus.UNCLAIMED,
    ownerId: null,
    tagId: '04A39B2C5D6E80',
    tagLifecycleState: TagLifecycleState.BOUND,
    vendorId: null,
    provisioningBatchId: null,
    vendorAuthenticatedAt: null,
    resaleBlocked: false,
    resaleBlockedReason: null,
    tamperStatus: null,
    isActive: true,
    archivedAt: null,
    drop: { id: 'product-1', organizationId: 'org-1' },
    ...overrides,
});

const ACCESS: SkuAccess = {
    userId: 'admin-1',
    instance: { scope: ReadScope.GLOBAL, visibility: Visibility.FULL },
    tag: { scope: ReadScope.GLOBAL, visibility: Visibility.FULL },
    buyer: { scope: ReadScope.GLOBAL, visibility: Visibility.FULL },
    order: null,
    canSeeMoney: false,
    canManageTags: true,
    canManageUnits: true,
    organizationIds: null,
};

const CONTEXT = { access: ACCESS, correlationId: 'corr-1' };

function build(rows: ReturnType<typeof row>[]) {
    const skus = {
        findProduct: jest.fn(async () => PRODUCT),
        findBatchTargets: jest.fn(async () => rows),
        applyUpdates: jest.fn(async () => undefined),
        variantBelongsTo: jest.fn(async () => true),
    };
    const deps = {
        skus,
        eventBus: { publish: jest.fn(async () => undefined), subscribe: jest.fn() },
        audit: { record: jest.fn(async () => undefined) },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new SkuService(deps as any), deps };
}

const dto = (body: Record<string, unknown>) => batchUpdateSkusSchema.parse(body);

const BLOCK = { resaleBlocked: true, resaleBlockedReason: 'chargeback wave #41' };

describe('applying one change to many units', () => {
    it('writes every selected unit in one call', async () => {
        const { service, deps } = build([row(1), row(2), row(3)]);

        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { serialFrom: 1, serialTo: 3 }, changes: BLOCK }),
        );

        expect(result.matched).toBe(3);
        expect(result.changed).toBe(3);
        expect(result.unchanged).toBe(0);
        expect(deps.skus.applyUpdates).toHaveBeenCalledTimes(1);
        const [updates] = deps.skus.applyUpdates.mock.calls[0] as [{ skuId: string }[]];
        expect(updates.map((update) => update.skuId)).toEqual([skuId(1), skuId(2), skuId(3)]);
    });

    it('reports which columns each unit changed', async () => {
        const { service } = build([row(1)]);
        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { skuIds: [skuId(1)] }, changes: BLOCK }),
        );
        expect(result.items[0]?.changed).toEqual(['resaleBlocked', 'resaleBlockedReason']);
    });
});

describe('units already in the requested state', () => {
    it('counts them as unchanged rather than failing the batch', async () => {
        // Selecting 200 rows of which some are already blocked is ordinary.
        const { service, deps } = build([
            row(1),
            row(2, { resaleBlocked: true, resaleBlockedReason: 'chargeback wave #41' }),
        ]);

        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { skuIds: [skuId(1), skuId(2)] }, changes: BLOCK }),
        );

        expect(result.matched).toBe(2);
        expect(result.changed).toBe(1);
        expect(result.unchanged).toBe(1);
        const [updates] = deps.skus.applyUpdates.mock.calls[0] as [{ skuId: string }[]];
        expect(updates).toHaveLength(1);
    });

    it('writes nothing at all when every unit is already there', async () => {
        const { service, deps } = build([
            row(1, { resaleBlocked: true, resaleBlockedReason: 'chargeback wave #41' }),
        ]);
        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { skuIds: [skuId(1)] }, changes: BLOCK }),
        );
        expect(result.changed).toBe(0);
        expect(deps.skus.applyUpdates).not.toHaveBeenCalled();
    });
});

describe('all or nothing', () => {
    let context: ReturnType<typeof build>;

    beforeEach(() => {
        // #2 is claimed, so it cannot be archived. #1 and #3 could be.
        context = build([
            row(1),
            row(2, { claimedStatus: ClaimedStatus.CLAIMED, ownerId: 'u-9' }),
            row(3),
        ]);
    });

    it('refuses the whole batch when one unit refuses', async () => {
        await expect(
            context.service.batchUpdate(
                CONTEXT,
                'product-1',
                dto({
                    targets: { serialFrom: 1, serialTo: 3 },
                    changes: { archived: true, reason: 'edition recalled' },
                }),
            ),
        ).rejects.toThrow(/Batch rejected, nothing was written/);
    });

    it('writes nothing when it refuses', async () => {
        await context.service
            .batchUpdate(
                CONTEXT,
                'product-1',
                dto({
                    targets: { serialFrom: 1, serialTo: 3 },
                    changes: { archived: true, reason: 'edition recalled' },
                }),
            )
            .catch(() => undefined);
        expect(context.deps.skus.applyUpdates).not.toHaveBeenCalled();
    });

    it('names the offending unit, not just a count', async () => {
        await expect(
            context.service.batchUpdate(
                CONTEXT,
                'product-1',
                dto({
                    targets: { serialFrom: 1, serialTo: 3 },
                    changes: { archived: true, reason: 'edition recalled' },
                }),
            ),
        ).rejects.toThrow(/123456780042-000002/);
    });

    it('records the refusal in the audit trail', async () => {
        await context.service
            .batchUpdate(
                CONTEXT,
                'product-1',
                dto({
                    targets: { serialFrom: 1, serialTo: 3 },
                    changes: { archived: true, reason: 'edition recalled' },
                }),
            )
            .catch(() => undefined);
        expect(context.deps.audit.record).toHaveBeenCalledWith(
            expect.objectContaining({ result: 'DENIED' }),
        );
    });
});

describe('targets that do not resolve', () => {
    it('refuses a batch naming a unit that is not there', async () => {
        const { service } = build([row(1)]);
        await expect(
            service.batchUpdate(
                CONTEXT,
                'product-1',
                dto({ targets: { skuIds: [skuId(1), skuId(404)] }, changes: BLOCK }),
            ),
        ).rejects.toThrow(new RegExp(`${skuId(404)}: no such unit`));
    });

    it('does not mind a serial range running past the end of an edition', async () => {
        // "#1–500" over an edition that only reached 3 is a perfectly ordinary
        // way to say "the whole drop".
        const { service } = build([row(1), row(2), row(3)]);
        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { serialFrom: 1, serialTo: 500 }, changes: BLOCK }),
        );
        expect(result.requested).toBe(500);
        expect(result.matched).toBe(3);
    });

    it('404s a selection that matched nothing at all', async () => {
        const { service } = build([]);
        await expect(
            service.batchUpdate(
                CONTEXT,
                'product-1',
                dto({ targets: { serialFrom: 900, serialTo: 950 }, changes: BLOCK }),
            ),
        ).rejects.toThrow(/matched no units/);
    });
});

describe('dry run', () => {
    it('reports what would happen and writes nothing', async () => {
        const { service, deps } = build([
            row(1),
            row(2, { resaleBlocked: true, resaleBlockedReason: 'chargeback wave #41' }),
        ]);

        const result = await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { serialFrom: 1, serialTo: 2 }, changes: BLOCK, dryRun: true }),
        );

        expect(result.dryRun).toBe(true);
        expect(result.changed).toBe(1);
        expect(result.unchanged).toBe(1);
        expect(deps.skus.applyUpdates).not.toHaveBeenCalled();
        expect(deps.audit.record).not.toHaveBeenCalled();
    });
});

describe('guards that run before any unit is loaded', () => {
    it('refuses a tag-custody change from a caller without tag custody', async () => {
        const { service, deps } = build([row(1)]);
        await expect(
            service.batchUpdate(
                { ...CONTEXT, access: { ...ACCESS, canManageTags: false } },
                'product-1',
                dto({
                    targets: { skuIds: [skuId(1)] },
                    changes: { tagLifecycleState: 'REVOKED', reason: 'cloned' },
                }),
            ),
        ).rejects.toThrow(/tagLifecycleState/);
        expect(deps.skus.findBatchTargets).not.toHaveBeenCalled();
    });

    it('refuses a serial selector with no drop to count serials within', async () => {
        const { service } = build([row(1)]);
        await expect(
            service.batchUpdate(
                CONTEXT,
                undefined,
                dto({ targets: { serialFrom: 1, serialTo: 3 }, changes: BLOCK }),
            ),
        ).rejects.toThrow(/needs a productId/);
    });

    it('allows a cross-drop batch selected by id', async () => {
        const { service } = build([row(1)]);
        const result = await service.batchUpdate(
            CONTEXT,
            undefined,
            dto({ targets: { skuIds: [skuId(1)] }, changes: BLOCK }),
        );
        expect(result.productId).toBeNull();
        expect(result.changed).toBe(1);
    });
});

describe('the audit trail', () => {
    it('records the batch once, with counts and the units touched', async () => {
        const { service, deps } = build([row(1), row(2)]);
        await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { skuIds: [skuId(1), skuId(2)] }, changes: BLOCK }),
        );

        expect(deps.audit.record).toHaveBeenCalledTimes(1);
        const [entry] = deps.audit.record.mock.calls[0] as [Record<string, unknown>];
        expect(entry.result).toBe('SUCCESS');
        expect(entry.correlationId).toBe('corr-1');
        expect(entry.metadata).toEqual(
            expect.objectContaining({ changed: 2, skuIds: [skuId(1), skuId(2)] }),
        );
    });

    it('is written before the caller is told it succeeded', async () => {
        const { service, deps } = build([row(1)]);
        await service.batchUpdate(
            CONTEXT,
            'product-1',
            dto({ targets: { skuIds: [skuId(1)] }, changes: BLOCK }),
        );
        const writeAt = deps.skus.applyUpdates.mock.invocationCallOrder[0] as number;
        const auditAt = deps.audit.record.mock.invocationCallOrder[0] as number;
        expect(writeAt).toBeLessThan(auditAt);
    });
});

describe('batch validation', () => {
    it('demands exactly one selector', () => {
        expect(
            batchUpdateSkusSchema.safeParse({
                targets: { skuIds: [skuId(1)], skuCodes: ['b'] },
                changes: BLOCK,
            }).success,
        ).toBe(false);
        expect(
            batchUpdateSkusSchema.safeParse({ targets: {}, changes: BLOCK }).success,
        ).toBe(false);
    });

    it('rejects a half-specified range', () => {
        expect(
            batchUpdateSkusSchema.safeParse({ targets: { serialFrom: 1 }, changes: BLOCK })
                .success,
        ).toBe(false);
    });

    it('rejects a range wider than one batch', () => {
        expect(
            batchUpdateSkusSchema.safeParse({
                targets: { serialFrom: 1, serialTo: 5000 },
                changes: BLOCK,
            }).success,
        ).toBe(false);
    });

    it('rejects an unknown field rather than ignoring it', () => {
        // A caller who believes they just transferred ownership should find
        // out immediately, not discover it did nothing a week later.
        expect(
            batchUpdateSkusSchema.safeParse({
                targets: { skuIds: [skuId(1)] },
                changes: { ownerId: 'u-1' },
            }).success,
        ).toBe(false);
    });
});

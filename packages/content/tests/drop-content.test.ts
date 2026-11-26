import pino from 'pino';
import { AppError } from '@hitbox/shared';
import {
    CONTENT_ERROR_CODES,
    DROP_CONTENT_ERROR_CODES,
    DROP_CONTENT_EVENTS,
    MAX_EXCLUSIVE_TIERS_PER_DROP,
} from '../src/constants/content.constant';
import type { IRewardMedia, RewardMediaAsset } from '../src/domain/reward-media.port';
import type { ContentRepository } from '../src/repository/content.repository';
import type { DropContentRepository, DropContentRow, OwnedUnit } from '../src/repository/drop-content.repository';
import { DropContentService } from '../src/service/drop-content.service';
import { DropContentAccessService } from '../src/service/drop-content-access.service';

/**
 * Drop content — docs/content/drop-content.md. An in-memory stand-in for the
 * repositories: one drop of 100 units, who owns (has claimed) which serial,
 * the drop's content bundles and their files.
 */

const DROP = 'd0000000-0000-4000-8000-000000000001';
const OTHER_DROP = 'd0000000-0000-4000-8000-000000000002';
const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const CAROL = 'c0000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-04T12:00:00Z');

interface World {
    drops: { id: string; name: string; totalSupply: number; released: boolean; archived: boolean }[];
    /** serial -> owner, for DROP. */
    owners: Map<number, string>;
    bundles: DropContentRow[];
    assets: RewardMediaAsset[];
    opens: Set<string>;
}

function world(): World {
    return {
        drops: [
            { id: DROP, name: 'Kaze Tee', totalSupply: 100, released: true, archived: false },
            { id: OTHER_DROP, name: 'Draft', totalSupply: 10, released: false, archived: false },
        ],
        owners: new Map([[1, ALICE], [2, BOB], [3, BOB]]),
        bundles: [],
        assets: [],
        opens: new Set(),
    };
}

const skuId = (serial: number) => `5${String(serial).padStart(7, '0')}-0000-4000-8000-000000000000`;
const unit = (serial: number): OwnedUnit => ({ skuId: skuId(serial), publicCode: `sku${serial}`, productId: DROP, serialNumber: serial });

let seq = 0;

function fakeDrops(w: World): DropContentRepository {
    const find = (id: string) => w.bundles.find((b) => b.id === id)!;
    const tierType = (tier: string) => (tier === 'EXCLUSIVE' ? 'SKU_EXCLUSIVE' : 'OWNER_ONLY');
    return {
        listForDrop: async (dropId: string) => structuredClone(
            w.bundles
                .filter((b) => b.productId === dropId)
                .sort((a, b) => Number(a.accessType === 'SKU_EXCLUSIVE') - Number(b.accessType === 'SKU_EXCLUSIVE')),
        ),
        findForDrop: async (dropId: string, bundleId: string) => {
            const row = w.bundles.find((b) => b.id === bundleId && b.productId === dropId);
            return row ? structuredClone(row) : null;
        },
        countExclusive: async (dropId: string) =>
            w.bundles.filter((b) => b.productId === dropId && b.accessType === 'SKU_EXCLUSIVE').length,
        create: async (input: { dropId: string; tier: string; name: string; description: string | null; isActive: boolean; serialNumbers: number[] }) => {
            const row = {
                id: `e0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
                publicCode: null, name: input.name, description: input.description, productId: input.dropId,
                accessType: tierType(input.tier), isActive: input.isActive, archivedAt: null,
                createdAt: NOW, updatedAt: NOW, moderationLockedAt: null, moderationReason: null, moderatedById: null,
                contentBundleItems: [],
                eligibleSerials: input.serialNumbers.map((serialNumber) => ({ serialNumber })),
            } as unknown as DropContentRow;
            w.bundles.push(row);
            return structuredClone(row);
        },
        update: async (id: string, data: Partial<DropContentRow>, serialNumbers: number[] | undefined) => {
            const row = find(id);
            Object.assign(row, data);
            if (serialNumbers) row.eligibleSerials = serialNumbers.map((serialNumber) => ({ serialNumber }));
            return structuredClone(row);
        },
        findDrop: async (dropId: string) => {
            const d = w.drops.find((x) => x.id === dropId);
            return d ? { id: d.id, publicCode: null, name: d.name, totalSupply: d.totalSupply, released: d.released, archived: d.archived } : null;
        },
        ownedUnits: async (userId: string, dropId: string) =>
            dropId !== DROP ? [] : [...w.owners.entries()].filter(([, u]) => u === userId).map(([s]) => unit(s)).sort((a, b) => a.serialNumber - b.serialNumber),
        ownedUnit: async (userId: string, id: string) => {
            const hit = [...w.owners.entries()].find(([s, u]) => u === userId && skuId(s) === id);
            return hit ? unit(hit[0]) : null;
        },
        holderCounts: async (bundles: { id: string; tier: string; serials: number[] }[]) => new Map(bundles.map((b) => [
            b.id,
            new Set([...w.owners.entries()].filter(([s]) => b.tier === 'REGULAR' || b.serials.includes(s)).map(([, u]) => u)).size,
        ])),
        recordOpen: async (userId: string, bundleId: string, sku: string) => {
            const key = `${userId}|${bundleId}|${sku}`;
            const first = !w.opens.has(key);
            w.opens.add(key);
            return first;
        },
        openedCounts: async (ids: string[]) => new Map(ids.map((id) => [
            id, new Set([...w.opens].filter((k) => k.split('|')[1] === id).map((k) => k.split('|')[0])).size,
        ])),
    } as unknown as DropContentRepository;
}

function fakeContent(w: World): ContentRepository {
    const find = (id: string) => w.bundles.find((b) => b.id === id)!;
    return {
        addItem: async (input: { bundleId: string; assetId: string; title: string | null }) => {
            const asset = w.assets.find((a) => a.id === input.assetId)!;
            const row = find(input.bundleId);
            row.contentBundleItems.push({
                id: `i-${input.assetId}`, publicCode: null, assetId: input.assetId, position: row.contentBundleItems.length,
                title: input.title, asset: { fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, archivedAt: null },
            });
        },
        updateItemTitle: async () => undefined,
        reorderItems: async () => undefined,
        removeItem: async () => undefined,
    } as unknown as ContentRepository;
}

function fakeMedia(w: World): IRewardMedia {
    return {
        createUpload: async (input) => ({
            assetId: `upload-${input.dropId ?? input.collectionId}`, uploadUrl: 'https://put', expiresIn: 300,
            requiredHeaders: { 'Content-Type': input.mimeType },
        }),
        inspect: async (ids) => w.assets.filter((a) => ids.includes(a.id)),
        links: async (ids) => ids.map((assetId) => ({ assetId, url: `https://signed/${assetId}`, expiresIn: 3600 })),
    };
}

function setup(w = world()) {
    const drops = fakeDrops(w);
    const media = fakeMedia(w);
    const published: { event: string; payload: unknown }[] = [];
    const eventBus = {
        publish: async (event: string, payload: unknown) => { published.push({ event, payload }); },
        subscribe: () => undefined,
    } as never;
    const manage = new DropContentService({ content: fakeContent(w), drops, media, now: () => NOW });
    const access = new DropContentAccessService({ drops, media, eventBus, logger: pino({ level: 'silent' }), now: () => NOW });
    const asset = (id: string, over: Partial<RewardMediaAsset> = {}) => {
        w.assets.push({
            id, collectionId: null, dropId: DROP, fileName: `${id}.mp4`, mimeType: 'video/mp4', sizeBytes: 10,
            uploadedById: ALICE, archived: false, infected: false, uploaded: true, ...over,
        });
        return id;
    };
    return { w, manage, access, published, asset };
}

async function expectCode(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await promise.catch((error: AppError) => expect(error.code).toBe(code));
}

/** A drop with regular content (one file) and an exclusive tier for #1 (one file). */
async function standard(s: ReturnType<typeof setup>) {
    const regular = await s.manage.create({ dropId: DROP, tier: 'REGULAR', name: 'Making-of' });
    const exclusive = await s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'Signed poster', serialNumbers: [1] });
    await s.manage.addItem({ dropId: DROP, bundleId: regular.id, assetId: s.asset('reg-video') });
    await s.manage.addItem({ dropId: DROP, bundleId: exclusive.id, assetId: s.asset('vip-image', { mimeType: 'image/png', fileName: 'poster.png' }) });
    return { regular, exclusive };
}

describe('drop content — managing tiers', () => {
    it('one regular tier per drop', async () => {
        const s = setup();
        const regular = await s.manage.create({ dropId: DROP, tier: 'REGULAR', name: 'Making-of' });
        expect(regular).toMatchObject({ tier: 'REGULAR', status: 'ON', serialNumbers: [], holders: 2 });
        await expectCode(s.manage.create({ dropId: DROP, tier: 'REGULAR', name: 'Again' }), DROP_CONTENT_ERROR_CODES.REGULAR_EXISTS);
    });

    it('an exclusive tier needs serial numbers within the edition; regular takes none', async () => {
        const s = setup();
        await expectCode(s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'VIP' }), DROP_CONTENT_ERROR_CODES.SERIALS_INVALID);
        await expectCode(
            s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'VIP', serialNumbers: [1, 101] }),
            DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
        );
        await expectCode(
            s.manage.create({ dropId: DROP, tier: 'REGULAR', name: 'All', serialNumbers: [1] }),
            DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
        );
        const vip = await s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'VIP', serialNumbers: [7, 1, 1] });
        // Sorted, de-duplicated; only #1 is owned so far.
        expect(vip).toMatchObject({ serialNumbers: [1, 7], holders: 1 });
    });

    it(`caps exclusive tiers at ${MAX_EXCLUSIVE_TIERS_PER_DROP} per drop`, async () => {
        const s = setup();
        for (let i = 1; i <= MAX_EXCLUSIVE_TIERS_PER_DROP; i += 1) {
            await s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: `T${i}`, serialNumbers: [i] });
        }
        await expectCode(
            s.manage.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'One more', serialNumbers: [50] }),
            DROP_CONTENT_ERROR_CODES.TOO_MANY_TIERS,
        );
    });

    it('only files uploaded for this drop can be added', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        s.asset('elsewhere', { dropId: OTHER_DROP });
        s.asset('collection-file', { dropId: null, collectionId: 'c1' });
        await expectCode(s.manage.addItem({ dropId: DROP, bundleId: exclusive.id, assetId: 'elsewhere' }), CONTENT_ERROR_CODES.FILE_INVALID);
        await expectCode(s.manage.addItem({ dropId: DROP, bundleId: exclusive.id, assetId: 'collection-file' }), CONTENT_ERROR_CODES.FILE_INVALID);
        await expectCode(
            s.manage.createItemUpload({ dropId: DROP, bundleId: exclusive.id, uploadedById: ALICE, fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 5 }),
            CONTENT_ERROR_CODES.FILE_TYPE,
        );
    });

    it('removed tiers are read-only until restored; a HitBox lock blocks restoring', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        const removed = await s.manage.remove({ dropId: DROP, bundleId: exclusive.id });
        expect(removed).toMatchObject({ changed: true, view: { status: 'REMOVED' } });
        await expectCode(s.manage.update({ dropId: DROP, bundleId: exclusive.id, name: 'x' }), DROP_CONTENT_ERROR_CODES.ARCHIVED);

        s.w.bundles.find((b) => b.id === exclusive.id)!.moderationLockedAt = NOW;
        await expectCode(s.manage.restore({ dropId: DROP, bundleId: exclusive.id }), CONTENT_ERROR_CODES.MODERATION_LOCKED);

        s.w.bundles.find((b) => b.id === exclusive.id)!.moderationLockedAt = null;
        expect(await s.manage.restore({ dropId: DROP, bundleId: exclusive.id })).toMatchObject({ status: 'ON' });
        await expectCode(s.manage.restore({ dropId: DROP, bundleId: exclusive.id }), DROP_CONTENT_ERROR_CODES.NOT_ARCHIVED);
    });

    it('a tier of another drop is not found', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        await expectCode(s.manage.get(OTHER_DROP, exclusive.id), DROP_CONTENT_ERROR_CODES.NOT_FOUND);
    });
});

describe('drop content — who opens what', () => {
    it('the owner of the eligible unit opens the exclusive content as well as the regular', async () => {
        const s = setup();
        const { regular, exclusive } = await standard(s);
        const mine = await s.access.forDrop(ALICE, DROP);
        expect(mine.myUnits.map((u) => u.serialNumber)).toEqual([1]);
        expect(mine.content.map((t) => [t.id, t.unlocked])).toEqual([[regular.id, true], [exclusive.id, true]]);
        expect(mine.content[1]!.items[0]).toMatchObject({ kind: 'IMAGE', url: 'https://signed/vip-image' });
        expect(mine.content[1]!.unlockedBy.map((u) => u.serialNumber)).toEqual([1]);
    });

    it('other owners get the regular content and only a teaser of the exclusive — no links', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        const bob = await s.access.forDrop(BOB, DROP);
        expect(bob.content[0]).toMatchObject({ tier: 'REGULAR', unlocked: true });
        const teaser = bob.content.find((t) => t.id === exclusive.id)!;
        expect(teaser).toMatchObject({ unlocked: false, eligibleSerials: [1], itemTotal: 1, items: [], unlockedBy: [] });
        expect(teaser.itemCounts.IMAGE).toBe(1);
    });

    it('per unit: #1 opens both, #2 opens the regular only; somebody else\'s unit is not found', async () => {
        const s = setup();
        await standard(s);
        expect((await s.access.forUnit(ALICE, skuId(1))).content.map((t) => t.unlocked)).toEqual([true, true]);
        expect((await s.access.forUnit(BOB, skuId(2))).content.map((t) => t.unlocked)).toEqual([true, false]);
        await expectCode(s.access.forUnit(BOB, skuId(1)), DROP_CONTENT_ERROR_CODES.UNIT_NOT_FOUND);
    });

    it('access follows the unit: resell #1 and the new owner opens it, the old owner no longer does', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        s.w.owners.set(1, CAROL);
        expect((await s.access.forDrop(CAROL, DROP)).content.find((t) => t.id === exclusive.id)!.unlocked).toBe(true);
        const alice = await s.access.forDrop(ALICE, DROP);
        expect(alice.myUnits).toEqual([]);
        expect(alice.content.every((t) => !t.unlocked && t.items.length === 0)).toBe(true);
    });

    it('changing the serial list moves access at once', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        const updated = await s.manage.update({ dropId: DROP, bundleId: exclusive.id, serialNumbers: [3] });
        expect(updated).toMatchObject({ serialNumbers: [3], holders: 1 });
        expect((await s.access.forUnit(ALICE, skuId(1))).content.find((t) => t.id === exclusive.id)!.unlocked).toBe(false);
        expect((await s.access.forUnit(BOB, skuId(3))).content.find((t) => t.id === exclusive.id)!.unlocked).toBe(true);
        await expectCode(
            s.manage.update({ dropId: DROP, bundleId: exclusive.id, serialNumbers: [] }),
            DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
        );
    });

    it('switched-off and removed tiers are hidden from buyers', async () => {
        const s = setup();
        const { regular, exclusive } = await standard(s);
        await s.manage.update({ dropId: DROP, bundleId: exclusive.id, isActive: false });
        await s.manage.remove({ dropId: DROP, bundleId: regular.id });
        expect((await s.access.forDrop(ALICE, DROP)).content).toEqual([]);
    });

    it('a non-owner can preview a released drop, not an unreleased one', async () => {
        const s = setup();
        await standard(s);
        const preview = await s.access.forDrop(CAROL, DROP);
        expect(preview.content.every((t) => !t.unlocked)).toBe(true);
        await expectCode(s.access.forDrop(CAROL, OTHER_DROP), DROP_CONTENT_ERROR_CODES.DROP_NOT_FOUND);
    });

    it('records the first open per unit once, and the artist sees it', async () => {
        const s = setup();
        const { exclusive } = await standard(s);
        await s.access.forDrop(ALICE, DROP);
        await s.access.forDrop(ALICE, DROP);
        const opened = s.published.filter((p) => p.event === DROP_CONTENT_EVENTS.OPENED);
        expect(opened).toHaveLength(2); // regular + exclusive, once each
        expect(opened.find((p) => (p.payload as { tier: string }).tier === 'EXCLUSIVE')!.payload)
            .toMatchObject({ bundleId: exclusive.id, userId: ALICE, serialNumber: 1 });
        expect((await s.manage.get(DROP, exclusive.id)).openedBy).toBe(1);
    });
});

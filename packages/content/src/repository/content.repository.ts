import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { RELEASED_DROP_STATUSES } from '../constants/content.constant';

/**
 * The only place in this module that touches Prisma.
 *
 * Owns ContentBundle / ContentBundleItem / ContentUnlock. Two reads reach
 * outside them, read-only, the same documented shortcut the artist module
 * takes for drops and orders takes for units:
 *
 *   - `Drop` — which drops of a collection are released (products owns it);
 *   - `Sku`  — which of them a buyer owns, by claim (`ownerId`,
 *     `claimedStatus = CLAIMED`).
 *
 * "Has this buyer collected the set" is a question about those two tables, and
 * routing it through two ports whose only implementation is this query would
 * be ceremony. Nothing here writes to either.
 */

const itemSelect = {
    id: true,
    publicCode: true,
    assetId: true,
    position: true,
    title: true,
    asset: { select: { fileName: true, mimeType: true, sizeBytes: true, archivedAt: true } },
} satisfies Prisma.ContentBundleItemSelect;

const bundleSelect = {
    id: true,
    publicCode: true,
    name: true,
    description: true,
    collectionId: true,
    isActive: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    moderationLockedAt: true,
    moderationReason: true,
    moderatedById: true,
    collection: {
        select: {
            id: true,
            name: true,
            slug: true,
            heroImageUrl: true,
            archivedAt: true,
            organizationId: true,
            artist: { select: { id: true, name: true, slug: true } },
        },
    },
    contentBundleItems: { select: itemSelect, orderBy: { position: 'asc' } },
} satisfies Prisma.ContentBundleSelect;

export type RewardRow = Prisma.ContentBundleGetPayload<{ select: typeof bundleSelect }>;
export type RewardItemRow = RewardRow['contentBundleItems'][number];

const RELEASED = { in: [...RELEASED_DROP_STATUSES] } as Prisma.EnumDropStatusFilter;

/** How staff filter rewards. LOCKED: switched off or removed by HitBox. */
export type AdminRewardStatus = 'ON' | 'OFF' | 'REMOVED' | 'LOCKED';

const STATUS_WHERE: Record<AdminRewardStatus, Prisma.ContentBundleWhereInput> = {
    ON: { isActive: true, archivedAt: null },
    OFF: { isActive: false, archivedAt: null },
    REMOVED: { archivedAt: { not: null } },
    LOCKED: { moderationLockedAt: { not: null } },
};

/** A grant that is in force: never ended, or ending in the future. */
const liveGrant = (now: Date): Prisma.ContentUnlockWhereInput => ({
    skuId: null,
    OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }],
});

export class ContentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    // ── Rewards ─────────────────────────────────────────────────────────────

    /** The collection's reward, archived or not — there is at most one. */
    findRewardOfCollection(collectionId: string): Promise<RewardRow | null> {
        return this.prisma.contentBundle.findFirst({
            where: { collectionId, accessType: 'COLLECTION_COMPLETE' },
            select: bundleSelect,
        });
    }

    findReward(id: string): Promise<RewardRow | null> {
        return this.prisma.contentBundle.findFirst({
            where: { id, accessType: 'COLLECTION_COMPLETE' },
            select: bundleSelect,
        });
    }

    /**
     * Creates the reward. The partial unique index (one COLLECTION_COMPLETE
     * bundle per collection) is the authority when two saves race; the
     * service retries as an update on P2002.
     */
    createReward(input: {
        collectionId: string;
        name: string;
        description: string | null;
        isActive: boolean;
        now: Date;
    }): Promise<RewardRow> {
        return this.prisma.contentBundle.create({
            data: {
                id: randomUUID(),
                name: input.name,
                description: input.description,
                collectionId: input.collectionId,
                accessType: 'COLLECTION_COMPLETE',
                isActive: input.isActive,
                createdAt: input.now,
                updatedAt: input.now,
            },
            select: bundleSelect,
        });
    }

    updateReward(
        id: string,
        data: {
            name?: string;
            description?: string | null;
            isActive?: boolean;
            archivedAt?: Date | null;
            moderationLockedAt?: Date | null;
            moderationReason?: string | null;
            moderatedById?: string | null;
        },
        now: Date,
    ): Promise<RewardRow> {
        return this.prisma.contentBundle.update({
            where: { id },
            data: { ...data, updatedAt: now },
            select: bundleSelect,
        });
    }

    // ── Items ───────────────────────────────────────────────────────────────

    async addItem(input: { bundleId: string; assetId: string; title: string | null; now: Date }): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const last = await tx.contentBundleItem.aggregate({
                where: { bundleId: input.bundleId },
                _max: { position: true },
            });
            await tx.contentBundleItem.create({
                data: {
                    id: randomUUID(),
                    bundleId: input.bundleId,
                    assetId: input.assetId,
                    position: (last._max.position ?? -1) + 1,
                    title: input.title,
                },
            });
            await tx.contentBundle.update({ where: { id: input.bundleId }, data: { updatedAt: input.now } });
        });
    }

    async updateItemTitle(itemId: string, title: string | null, bundleId: string, now: Date): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.contentBundleItem.update({ where: { id: itemId }, data: { title } }),
            this.prisma.contentBundle.update({ where: { id: bundleId }, data: { updatedAt: now } }),
        ]);
    }

    /** Positions 0..n-1 in the order given. */
    async reorderItems(bundleId: string, itemIds: string[], now: Date): Promise<void> {
        await this.prisma.$transaction([
            ...itemIds.map((id, position) =>
                this.prisma.contentBundleItem.update({ where: { id }, data: { position } }),
            ),
            this.prisma.contentBundle.update({ where: { id: bundleId }, data: { updatedAt: now } }),
        ]);
    }

    /** Removes the placement and closes the gap. The file itself is kept (history, audits). */
    async removeItem(bundleId: string, itemId: string, now: Date): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            await tx.contentBundleItem.delete({ where: { id: itemId } });
            const rest = await tx.contentBundleItem.findMany({
                where: { bundleId },
                orderBy: { position: 'asc' },
                select: { id: true },
            });
            for (const [position, row] of rest.entries()) {
                await tx.contentBundleItem.update({ where: { id: row.id }, data: { position } });
            }
            await tx.contentBundle.update({ where: { id: bundleId }, data: { updatedAt: now } });
        });
    }

    // ── The rule: has this buyer collected the set? ─────────────────────────

    /** The released drops of a collection — what a buyer has to collect. */
    async releasedDrops(collectionId: string): Promise<{ id: string; name: string; publicCode: string | null }[]> {
        return this.prisma.drop.findMany({
            where: { collectionId, archivedAt: null, status: RELEASED },
            select: { id: true, name: true, publicCode: true },
            orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        });
    }

    /** Which of `dropIds` the buyer owns a claimed unit of. */
    async ownedDropIds(userId: string, dropIds: string[]): Promise<Set<string>> {
        if (dropIds.length === 0) return new Set();
        const rows = await this.prisma.sku.findMany({
            where: { ownerId: userId, claimedStatus: 'CLAIMED', productId: { in: dropIds } },
            select: { productId: true },
            distinct: ['productId'],
        });
        return new Set(rows.map((row) => row.productId));
    }

    /** Does the buyer still own a claimed unit of this drop? */
    async ownsDrop(userId: string, dropId: string): Promise<boolean> {
        const row = await this.prisma.sku.findFirst({
            where: { ownerId: userId, claimedStatus: 'CLAIMED', productId: dropId },
            select: { id: true },
        });
        return row !== null;
    }

    /** The collection a drop is in, if any. */
    async collectionOfDrop(dropId: string): Promise<string | null> {
        const row = await this.prisma.drop.findUnique({ where: { id: dropId }, select: { collectionId: true } });
        return row?.collectionId ?? null;
    }

    /**
     * Every buyer who owns a claimed unit of every released drop of the
     * collection — for granting a reward the moment it is switched on. In SQL:
     * a collection can have thousands of owners, and this is one GROUP BY.
     */
    async completers(collectionId: string): Promise<string[]> {
        const rows = await this.prisma.$queryRaw<{ userId: string }[]>(Prisma.sql`
            WITH released AS (
                SELECT d.id FROM "Drop" d
                WHERE d."collectionId" = ${collectionId}::uuid
                  AND d."archivedAt" IS NULL
                  AND d.status::text IN (${Prisma.join([...RELEASED_DROP_STATUSES])})
            )
            SELECT s."ownerId" AS "userId"
            FROM "Sku" s
            JOIN released r ON r.id = s."productId"
            WHERE s."claimedStatus" = 'CLAIMED' AND s."ownerId" IS NOT NULL
            GROUP BY s."ownerId"
            HAVING count(DISTINCT s."productId") = (SELECT count(*) FROM released)
               AND (SELECT count(*) FROM released) > 0
        `);
        return rows.map((row) => row.userId);
    }

    // ── Grants ──────────────────────────────────────────────────────────────

    findGrant(userId: string, bundleId: string) {
        return this.prisma.contentUnlock.findFirst({
            where: { userId, bundleId, skuId: null },
            select: { id: true, grantedAt: true, accessExpiresAt: true, acknowledgedAt: true },
        });
    }

    hasLiveGrant(userId: string, bundleId: string, now: Date): Promise<boolean> {
        return this.prisma.contentUnlock
            .count({ where: { userId, bundleId, ...liveGrant(now) } })
            .then((count) => count > 0);
    }

    /**
     * Grants (or re-grants) the reward. Returns true when this call opened
     * access — a new grant, or one that had ended — so the caller announces it
     * once. Safe under concurrency: the partial unique index on
     * (userId, bundleId) WHERE skuId IS NULL stops a second row.
     */
    async grant(userId: string, bundleId: string, now: Date): Promise<boolean> {
        const existing = await this.findGrant(userId, bundleId);
        if (existing) {
            if (existing.accessExpiresAt === null || existing.accessExpiresAt > now) return false;
            const reopened = await this.prisma.contentUnlock.updateMany({
                where: { id: existing.id, accessExpiresAt: { not: null, lte: now } },
                data: { accessExpiresAt: null, grantedAt: now, notifiedAt: null },
            });
            return reopened.count === 1;
        }
        try {
            await this.prisma.contentUnlock.create({
                data: {
                    id: randomUUID(),
                    userId,
                    bundleId,
                    skuId: null,
                    grantedAt: now,
                    accessCount: 0,
                },
            });
            return true;
        } catch (error) {
            // Another evaluation granted it first — same outcome, not ours to announce.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
            throw error;
        }
    }

    /**
     * Grants to many buyers at once (switching a reward on). Returns who got
     * access from this call: new grants plus re-opened ended ones.
     */
    async grantMany(userIds: string[], bundleId: string, now: Date): Promise<string[]> {
        if (userIds.length === 0) return [];
        const existing = await this.prisma.contentUnlock.findMany({
            where: { bundleId, skuId: null, userId: { in: userIds } },
            select: { userId: true, accessExpiresAt: true },
        });
        const have = new Map(existing.map((row) => [row.userId, row.accessExpiresAt]));
        const fresh = userIds.filter((id) => !have.has(id));
        const ended = userIds.filter((id) => {
            const until = have.get(id);
            return until !== undefined && until !== null && until <= now;
        });
        await this.prisma.$transaction([
            this.prisma.contentUnlock.createMany({
                data: fresh.map((userId) => ({
                    id: randomUUID(), userId, bundleId, skuId: null, grantedAt: now, accessCount: 0,
                })),
                // A racing single grant already wrote the row — fine.
                skipDuplicates: true,
            }),
            this.prisma.contentUnlock.updateMany({
                where: { bundleId, skuId: null, userId: { in: ended } },
                data: { accessExpiresAt: null, grantedAt: now, notifiedAt: null },
            }),
        ]);
        return [...fresh, ...ended];
    }

    /** Ends a buyer's access now. True when there was live access to end. */
    async endGrant(userId: string, bundleId: string, now: Date): Promise<boolean> {
        const ended = await this.prisma.contentUnlock.updateMany({
            where: { userId, bundleId, ...liveGrant(now) },
            data: { accessExpiresAt: now },
        });
        return ended.count > 0;
    }

    countLiveGrants(bundleId: string, now: Date): Promise<number> {
        return this.prisma.contentUnlock.count({ where: { bundleId, ...liveGrant(now) } });
    }

    /** Engagement telemetry on a buyer opening their reward. Not access control. */
    async recordView(userId: string, bundleId: string, now: Date): Promise<void> {
        await this.prisma.contentUnlock.updateMany({
            where: { userId, bundleId, skuId: null },
            data: { lastAccessedAt: now, accessCount: { increment: 1 } },
        });
        await this.prisma.contentUnlock.updateMany({
            where: { userId, bundleId, skuId: null, acknowledgedAt: null },
            data: { acknowledgedAt: now },
        });
    }

    // ── Staff monitoring ────────────────────────────────────────────────────

    /** Every collection reward, newest change first. */
    async adminList(filter: {
        artistId?: string | undefined;
        collectionId?: string | undefined;
        status?: AdminRewardStatus | undefined;
        q?: string | undefined;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: RewardRow[] }> {
        const where: Prisma.ContentBundleWhereInput = {
            accessType: 'COLLECTION_COMPLETE',
            ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
            ...(filter.artistId ? { collection: { artistId: filter.artistId } } : {}),
            ...(filter.status ? STATUS_WHERE[filter.status] : {}),
            ...(filter.q
                ? {
                    OR: [
                        { name: { contains: filter.q, mode: Prisma.QueryMode.insensitive } },
                        { collection: { name: { contains: filter.q, mode: Prisma.QueryMode.insensitive } } },
                        { collection: { artist: { name: { contains: filter.q, mode: Prisma.QueryMode.insensitive } } } },
                    ],
                }
                : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.contentBundle.count({ where }),
            this.prisma.contentBundle.findMany({
                where,
                select: bundleSelect,
                orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                skip: filter.skip,
                take: filter.take,
            }),
        ]);
        return { total, items };
    }

    /** Live unlocks per reward, for a page of rewards. */
    async liveGrantCounts(bundleIds: string[], now: Date): Promise<Map<string, number>> {
        if (bundleIds.length === 0) return new Map();
        const rows = await this.prisma.contentUnlock.groupBy({
            by: ['bundleId'],
            where: { bundleId: { in: bundleIds }, ...liveGrant(now) },
            _count: { _all: true },
        });
        return new Map(rows.map((row) => [row.bundleId, row._count._all]));
    }

    /** Every summary tile in a handful of counts. */
    async adminCounts(now: Date, monthStart: Date) {
        const rewards = { accessType: 'COLLECTION_COMPLETE' } as const;
        const [total, on, off, removed, locked, liveUnlocks, unlocksThisMonth, buyers] = await Promise.all([
            this.prisma.contentBundle.count({ where: rewards }),
            this.prisma.contentBundle.count({ where: { ...rewards, ...STATUS_WHERE.ON } }),
            this.prisma.contentBundle.count({ where: { ...rewards, ...STATUS_WHERE.OFF } }),
            this.prisma.contentBundle.count({ where: { ...rewards, ...STATUS_WHERE.REMOVED } }),
            this.prisma.contentBundle.count({ where: { ...rewards, ...STATUS_WHERE.LOCKED } }),
            this.prisma.contentUnlock.count({ where: { bundle: rewards, ...liveGrant(now) } }),
            this.prisma.contentUnlock.count({ where: { bundle: rewards, skuId: null, grantedAt: { gte: monthStart } } }),
            this.prisma.contentUnlock.groupBy({ by: ['userId'], where: { bundle: rewards, ...liveGrant(now) } }),
        ]);
        return { total, on, off, removed, locked, liveUnlocks, unlocksThisMonth, buyersWithRewards: buyers.length };
    }

    /** Rewards with the most live unlocks. */
    async topByUnlocks(limit: number, now: Date): Promise<{ bundleId: string; unlocks: number }[]> {
        const rows = await this.prisma.contentUnlock.groupBy({
            by: ['bundleId'],
            where: { bundle: { accessType: 'COLLECTION_COMPLETE' }, ...liveGrant(now) },
            _count: { _all: true },
            orderBy: { _count: { bundleId: 'desc' } },
            take: limit,
        });
        return rows.map((row) => ({ bundleId: row.bundleId, unlocks: row._count._all }));
    }

    findRewards(ids: string[]): Promise<RewardRow[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.prisma.contentBundle.findMany({ where: { id: { in: ids } }, select: bundleSelect });
    }

    /** Who unlocked a reward. `LIVE`: can open it now; `ENDED`: lost it (a piece taken back). */
    async listUnlocks(input: {
        bundleId: string;
        status?: 'LIVE' | 'ENDED' | undefined;
        skip: number;
        take: number;
        now: Date;
    }) {
        const where: Prisma.ContentUnlockWhereInput = {
            bundleId: input.bundleId,
            skuId: null,
            ...(input.status === 'LIVE' ? liveGrant(input.now) : {}),
            ...(input.status === 'ENDED' ? { accessExpiresAt: { lte: input.now } } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.contentUnlock.count({ where }),
            this.prisma.contentUnlock.findMany({
                where,
                orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }],
                skip: input.skip,
                take: input.take,
                select: {
                    id: true,
                    publicCode: true,
                    grantedAt: true,
                    accessExpiresAt: true,
                    acknowledgedAt: true,
                    lastAccessedAt: true,
                    accessCount: true,
                    user: { select: { id: true, handle: true, fullName: true } },
                },
            }),
        ]);
        return { total, items };
    }

    /** The buyer's rewards that are open to them now. */
    myLiveRewards(userId: string, now: Date) {
        return this.prisma.contentUnlock.findMany({
            where: {
                userId,
                ...liveGrant(now),
                bundle: { accessType: 'COLLECTION_COMPLETE', isActive: true, archivedAt: null },
            },
            orderBy: { grantedAt: 'desc' },
            select: { grantedAt: true, bundle: { select: bundleSelect } },
        });
    }
}

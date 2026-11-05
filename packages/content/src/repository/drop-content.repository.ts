import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { DROP_CONTENT_ACCESS, RELEASED_DROP_STATUSES } from '../constants/content.constant';
import type { DropContentTier } from '../constants/content.constant';

/**
 * Drop content — a drop's regular and SKU-exclusive bundles. Same tables as
 * ContentRepository (ContentBundle / ContentBundleItem / ContentUnlock) plus
 * ContentBundleSerial; files are placed with ContentRepository's item
 * methods, which don't care what a bundle is for.
 *
 * Two reads reach outside, read-only, the same shortcut ContentRepository
 * takes: `Drop` (does it exist, is it released, how many units) and `Sku`
 * (who owns which unit, by claim). Nothing here writes to either.
 */

const itemSelect = {
    id: true,
    publicCode: true,
    assetId: true,
    position: true,
    title: true,
    asset: { select: { fileName: true, mimeType: true, sizeBytes: true, archivedAt: true } },
} satisfies Prisma.ContentBundleItemSelect;

const dropContentSelect = {
    id: true,
    publicCode: true,
    name: true,
    description: true,
    productId: true,
    accessType: true,
    isActive: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    moderationLockedAt: true,
    moderationReason: true,
    moderatedById: true,
    contentBundleItems: { select: itemSelect, orderBy: { position: 'asc' } },
    eligibleSerials: { select: { serialNumber: true }, orderBy: { serialNumber: 'asc' } },
} satisfies Prisma.ContentBundleSelect;

export type DropContentRow = Prisma.ContentBundleGetPayload<{ select: typeof dropContentSelect }>;

const DROP_CONTENT_TYPES = [DROP_CONTENT_ACCESS.REGULAR, DROP_CONTENT_ACCESS.EXCLUSIVE];

export function tierOf(row: Pick<DropContentRow, 'accessType'>): DropContentTier {
    return row.accessType === DROP_CONTENT_ACCESS.EXCLUSIVE ? 'EXCLUSIVE' : 'REGULAR';
}

export function serialsOf(row: Pick<DropContentRow, 'eligibleSerials'>): number[] {
    return row.eligibleSerials.map((s) => s.serialNumber);
}

export interface DropRef {
    id: string;
    publicCode: string | null;
    name: string;
    totalSupply: number;
    released: boolean;
    archived: boolean;
}

export interface OwnedUnit {
    skuId: string;
    publicCode: string | null;
    productId: string;
    serialNumber: number;
}

const unitSelect = { id: true, publicCode: true, productId: true, serialNumber: true } satisfies Prisma.SkuSelect;

function toUnit(row: Prisma.SkuGetPayload<{ select: typeof unitSelect }>): OwnedUnit {
    return { skuId: row.id, publicCode: row.publicCode, productId: row.productId, serialNumber: row.serialNumber };
}

export class DropContentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    // ── Bundles ─────────────────────────────────────────────────────────────

    /** Every content bundle of the drop: regular first, then exclusive tiers oldest first. */
    async listForDrop(dropId: string): Promise<DropContentRow[]> {
        const rows = await this.prisma.contentBundle.findMany({
            where: { productId: dropId, accessType: { in: DROP_CONTENT_TYPES } },
            select: dropContentSelect,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return rows.sort((a, b) => Number(tierOf(a) === 'EXCLUSIVE') - Number(tierOf(b) === 'EXCLUSIVE'));
    }

    findForDrop(dropId: string, bundleId: string): Promise<DropContentRow | null> {
        return this.prisma.contentBundle.findFirst({
            where: { id: bundleId, productId: dropId, accessType: { in: DROP_CONTENT_TYPES } },
            select: dropContentSelect,
        });
    }

    countExclusive(dropId: string): Promise<number> {
        return this.prisma.contentBundle.count({
            where: { productId: dropId, accessType: DROP_CONTENT_ACCESS.EXCLUSIVE },
        });
    }

    /**
     * Creates a bundle. For REGULAR the partial unique index (one per drop)
     * is the authority when two creates race — the caller maps P2002.
     */
    async create(input: {
        dropId: string;
        tier: DropContentTier;
        name: string;
        description: string | null;
        isActive: boolean;
        serialNumbers: number[];
        now: Date;
    }): Promise<DropContentRow> {
        return this.prisma.$transaction(async (tx) => {
            const id = randomUUID();
            await tx.contentBundle.create({
                data: {
                    id,
                    name: input.name,
                    description: input.description,
                    productId: input.dropId,
                    accessType: DROP_CONTENT_ACCESS[input.tier],
                    isActive: input.isActive,
                    createdAt: input.now,
                    updatedAt: input.now,
                },
            });
            if (input.serialNumbers.length > 0) {
                await tx.contentBundleSerial.createMany({
                    data: input.serialNumbers.map((serialNumber) => ({ bundleId: id, serialNumber, createdAt: input.now })),
                });
            }
            return tx.contentBundle.findUniqueOrThrow({ where: { id }, select: dropContentSelect });
        }, { timeout: 60_000 });
    }

    /** Edits a bundle. `serialNumbers`, when given, replaces the whole list. */
    async update(
        id: string,
        data: {
            name?: string;
            description?: string | null;
            isActive?: boolean;
            archivedAt?: Date | null;
        },
        serialNumbers: number[] | undefined,
        now: Date,
    ): Promise<DropContentRow> {
        return this.prisma.$transaction(async (tx) => {
            await tx.contentBundle.update({ where: { id }, data: { ...data, updatedAt: now } });
            if (serialNumbers) {
                await tx.contentBundleSerial.deleteMany({
                    where: { bundleId: id, serialNumber: { notIn: serialNumbers } },
                });
                await tx.contentBundleSerial.createMany({
                    data: serialNumbers.map((serialNumber) => ({ bundleId: id, serialNumber, createdAt: now })),
                    skipDuplicates: true,
                });
            }
            return tx.contentBundle.findUniqueOrThrow({ where: { id }, select: dropContentSelect });
        }, { timeout: 60_000 });
    }

    // ── Drops and units ─────────────────────────────────────────────────────

    async findDrop(dropId: string): Promise<DropRef | null> {
        const row = await this.prisma.drop.findUnique({
            where: { id: dropId },
            select: { id: true, publicCode: true, name: true, totalSupply: true, status: true, archivedAt: true },
        });
        if (!row) return null;
        return {
            id: row.id,
            publicCode: row.publicCode,
            name: row.name,
            totalSupply: row.totalSupply,
            released: (RELEASED_DROP_STATUSES as readonly string[]).includes(row.status),
            archived: row.archivedAt !== null,
        };
    }

    /** The units of this drop the buyer owns now (claimed), lowest serial first. */
    async ownedUnits(userId: string, dropId: string): Promise<OwnedUnit[]> {
        const rows = await this.prisma.sku.findMany({
            where: { ownerId: userId, claimedStatus: 'CLAIMED', productId: dropId },
            select: unitSelect,
            orderBy: { serialNumber: 'asc' },
        });
        return rows.map(toUnit);
    }

    /** One unit, if the buyer owns it now (claimed). */
    async ownedUnit(userId: string, skuId: string): Promise<OwnedUnit | null> {
        const row = await this.prisma.sku.findFirst({
            where: { id: skuId, ownerId: userId, claimedStatus: 'CLAIMED' },
            select: unitSelect,
        });
        return row ? toUnit(row) : null;
    }

    /**
     * How many buyers own, right now, a unit that opens each bundle — any unit
     * of the drop for REGULAR, a listed one for EXCLUSIVE. Units not minted or
     * not claimed yet don't count. One query per bundle, bounded by the tier cap.
     */
    async holderCounts(
        bundles: { id: string; dropId: string; tier: DropContentTier; serials: number[] }[],
    ): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        await Promise.all(bundles.map(async (bundle) => {
            const owners = await this.prisma.sku.findMany({
                where: {
                    productId: bundle.dropId,
                    claimedStatus: 'CLAIMED',
                    ownerId: { not: null },
                    ...(bundle.tier === 'EXCLUSIVE' ? { serialNumber: { in: bundle.serials } } : {}),
                },
                select: { ownerId: true },
                distinct: ['ownerId'],
            });
            counts.set(bundle.id, owners.length);
        }));
        return counts;
    }

    // ── Telemetry ───────────────────────────────────────────────────────────

    /**
     * Records a buyer opening drop content with one of their units. Not access
     * control — access is decided live from who owns the unit — but it is what
     * the artist's "opened by" figure reads. True the first time this buyer
     * opens it with this unit.
     */
    async recordOpen(userId: string, bundleId: string, skuId: string, now: Date): Promise<boolean> {
        // Update first: a repeat open is the common case, and a failed insert
        // would be logged as a Prisma error on every one of them.
        const seen = await this.prisma.contentUnlock.updateMany({
            where: { userId, bundleId, skuId },
            data: { lastAccessedAt: now, accessCount: { increment: 1 } },
        });
        if (seen.count > 0) return false;
        try {
            await this.prisma.contentUnlock.create({
                data: {
                    id: randomUUID(),
                    userId,
                    bundleId,
                    skuId,
                    grantedAt: now,
                    acknowledgedAt: now,
                    lastAccessedAt: now,
                    accessCount: 1,
                },
            });
            return true;
        } catch (error) {
            // A concurrent first open wrote the row — same outcome, not ours to announce.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
            throw error;
        }
    }

    /** Distinct buyers who have ever opened each bundle. */
    async openedCounts(bundleIds: string[]): Promise<Map<string, number>> {
        if (bundleIds.length === 0) return new Map();
        const rows = await this.prisma.contentUnlock.groupBy({
            by: ['bundleId', 'userId'],
            where: { bundleId: { in: bundleIds }, skuId: { not: null } },
        });
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(row.bundleId, (counts.get(row.bundleId) ?? 0) + 1);
        return counts;
    }
}

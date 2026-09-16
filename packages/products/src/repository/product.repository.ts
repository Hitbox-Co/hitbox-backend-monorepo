import { randomUUID } from 'node:crypto';
import { DropStatus, Prisma, ProductPriceStatus } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ProductCache } from '../cache/product-cache';
import type { ListProductsQuery } from '../dto/product.dto';

/**
 * The only place in this module that touches Prisma.
 *
 * Two things changed shape in the catalog restructure and drive most of what
 * is below:
 *
 *   - **Images** are no longer a URL on the row. `ProductImage` joins to
 *     `MediaAsset`, so every projection selects `asset.storageRef` and the
 *     service turns it into a URL through `IMediaUrlResolver`.
 *   - **Price** is no longer a column. `ProductPrice` is scoped per
 *     (product, variant, market), so a feed with no market context reads the
 *     base price — `variantId: null` — of the default market. The
 *     `@@unique([productId, variantId, marketId])` constraint makes that at
 *     most one row, which is why `take: 1` is exact rather than arbitrary.
 */

/** Primary image first, then by position. Archived placements are excluded. */
const imageArgs = {
    where: { archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
    select: { asset: { select: { storageRef: true } } },
} satisfies Prisma.Product$productImagesArgs;

/** The one base price a market-less feed can legitimately show. */
const basePriceArgs = {
    where: {
        status: ProductPriceStatus.ACTIVE,
        variantId: null,
        market: { isDefault: true, isActive: true },
    },
    take: 1,
    select: {
        amount: true,
        isFree: true,
        market: { select: { currency: true, code: true } },
    },
} satisfies Prisma.Product$productPricesArgs;

const listInclude = {
    productImages: imageArgs,
    productPrices: basePriceArgs,
    productVariants: { where: { archivedAt: null }, orderBy: { position: 'asc' } },
    collection: { include: { artist: true } },
    artist: true,
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof listInclude }>;

const discoverSelect = {
    id: true,
    name: true,
    productImages: { ...imageArgs, take: 1 },
} satisfies Prisma.ProductSelect;

export type ProductDiscoverRow = Prisma.ProductGetPayload<{ select: typeof discoverSelect }>;

const marketplaceSelect = {
    id: true,
    name: true,
    productImages: { ...imageArgs, take: 1 },
    productPrices: basePriceArgs,
    collection: { select: { artist: { select: { name: true } } } },
    artist: { select: { name: true } },
} satisfies Prisma.ProductSelect;

export type ProductListingRow = Prisma.ProductGetPayload<{ select: typeof marketplaceSelect }>;

/** One gallery placement, with the asset it points at. */
const productImageSelect = {
    id: true,
    assetId: true,
    position: true,
    isPrimary: true,
    altText: true,
    createdAt: true,
    asset: { select: { storageRef: true } },
} satisfies Prisma.ProductImageSelect;

export type ProductImageRow = Prisma.ProductImageGetPayload<{
    select: typeof productImageSelect;
}>;

/** A gallery entry after the service has resolved order and the primary flag. */
export interface NormalisedImage {
    assetId: string;
    position: number;
    isPrimary: boolean;
    altText: string | null;
}

/** One serialized unit of a drop, for the product detail screen. */
const skuUnitSelect = {
    id: true,
    skuCode: true,
    serialNumber: true,
    claimedStatus: true,
    ownerId: true,
    tagId: true,
    tagLifecycleState: true,
    vendorId: true,
    resaleBlocked: true,
    resaleBlockedReason: true,
    tamperStatus: true,
    lastTapCounter: true,
    isActive: true,
    createdAt: true,
    variantId: true,
    owner: { select: { email: true, handle: true } },
} satisfies Prisma.SkuSelect;

export type SkuUnitRow = Prisma.SkuGetPayload<{ select: typeof skuUnitSelect }>;

/** Sales, claim and inventory aggregates for one drop. */
export interface ProductPerformance {
    skuTotal: number;
    claimed: number;
    unclaimed: number;
    reservedHeld: number;
    reservedCommitted: number;
    orders: number;
    ordersByStatus: Record<string, number>;
    /** Decimal strings keyed by currency — never summed across them. */
    revenue: Record<string, string>;
    resaleActive: number;
    wishlists: number;
}

/**
 * Sort options the schema can actually express.
 *
 * `price_asc`/`price_desc` were removed: price moved to the market-scoped
 * `ProductPrice` table, and Prisma cannot order a query by a field on a
 * to-many relation. Restoring them needs either a denormalized base-price
 * column on `Product` or a raw-SQL join — see the module README note rather
 * than a silent fallback that orders by something else.
 *
 * `popular` was `Product.unitsSold`, which no longer exists. Total minted SKU
 * count is the nearest thing the schema records; it is a proxy for edition
 * size, not for sales, because Prisma cannot order by a *filtered* relation
 * count (claimed SKUs only).
 */
export const PRODUCT_SORTS = {
    newest: { createdAt: 'desc' },
    popular: { skus: { _count: 'desc' } },
} satisfies Record<string, Prisma.ProductOrderByWithRelationInput>;

export type ProductSort = keyof typeof PRODUCT_SORTS;

/**
 * What the public catalog may show: inside its release window, not
 * deactivated, not archived.
 *
 * Replaces `state: ProductState.ACTIVE`. `DropStatus.ACTIVE` alone is not
 * enough — `isActive` is a separate kill switch and `archivedAt` is the soft
 * delete, and a row can carry any combination.
 */
export const PUBLIC_PRODUCT_WHERE: Prisma.ProductWhereInput = {
    status: DropStatus.ACTIVE,
    isActive: true,
    archivedAt: null,
};

export class ProductRepository {
    constructor(
        private readonly prisma: PrismaClient,
        private readonly cache: ProductCache,
    ) { }

    async findMany(
        query: ListProductsQuery,
    ): Promise<{ items: ProductWithRelations[]; total: number }> {
        type Result = { items: ProductWithRelations[]; total: number };
        const cached = await this.cache.getList<Result>('catalog', query);
        if (cached) return cached;

        const where: Prisma.ProductWhereInput = {
            // An explicit status filter overrides the public default, so admin
            // tooling can list DRAFT/IN_REVIEW drops through the same method.
            ...(query.status ? { isActive: true, archivedAt: null, status: query.status } : PUBLIC_PRODUCT_WHERE),
            ...(query.category && { category: query.category }),
            ...(query.vertical && { vertical: query.vertical }),
            ...(query.rarity && { rarity: query.rarity }),
            ...(query.collectionId && { collectionId: query.collectionId }),
            ...(query.artistId && { artistId: query.artistId }),
            ...(query.search && {
                name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
            }),
        };

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where,
                include: listInclude,
                orderBy: PRODUCT_SORTS[query.sort],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.product.count({ where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('catalog', query, result);
        return result;
    }

    /** Minimal card projection for the discover feed — no joins beyond one image. */
    async findForDiscover(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductDiscoverRow[]; total: number }> {
        type Result = { items: ProductDiscoverRow[]; total: number };
        const cached = await this.cache.getList<Result>('discover', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where: params.where,
                select: discoverSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.product.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('discover', params, result);
        return result;
    }

    /** Listing card projection for the marketplace feed — price + artist name. */
    async findForMarketplace(params: {
        where: Prisma.ProductWhereInput;
        orderBy: Prisma.ProductOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductListingRow[]; total: number }> {
        type Result = { items: ProductListingRow[]; total: number };
        const cached = await this.cache.getList<Result>('marketplace', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.product.findMany({
                where: params.where,
                select: marketplaceSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.product.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('marketplace', params, result);
        return result;
    }

    async findById(id: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('id', id);
        if (cached) return cached;

        const product = await this.prisma.product.findUnique({
            where: { id },
            include: listInclude,
        });
        if (product) await this.cache.setEntity('id', id, product);
        return product;
    }

    /**
     * Lookup by the product's public code.
     *
     * `Product.productCode` became `Product.groupCode` in the restructure —
     * same role (the unique, client-facing identifier), different column.
     */
    async findByGroupCode(groupCode: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('code', groupCode);
        if (cached) return cached;

        const product = await this.prisma.product.findUnique({
            where: { groupCode },
            include: listInclude,
        });
        if (product) await this.cache.setEntity('code', groupCode, product);
        return product;
    }

    /**
     * The serialized units of one drop, for the product detail screen.
     *
     * Paginated because a 10,000-unit edition is a legitimate drop and the
     * detail payload must not grow with it.
     */
    async listSkuUnits(input: {
        productId: string;
        claimedStatus?: string | undefined;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: SkuUnitRow[] }> {
        const where: Prisma.SkuWhereInput = {
            productId: input.productId,
            ...(input.claimedStatus
                ? { claimedStatus: input.claimedStatus as Prisma.EnumClaimedStatusFilter['equals'] }
                : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.sku.count({ where }),
            this.prisma.sku.findMany({
                where,
                select: skuUnitSelect,
                orderBy: { serialNumber: 'asc' },
                skip: input.skip,
                take: input.take,
            }),
        ]);
        return { total, items };
    }

    /**
     * Sales, claim and inventory aggregates for one drop.
     *
     * Six counts in one round trip rather than six sequential queries — this
     * backs a single screen and the numbers must agree with each other, so
     * they are read together.
     */
    async performance(productId: string): Promise<ProductPerformance> {
        const [
            skuTotal,
            claimed,
            reservedHeld,
            reservedCommitted,
            orderAgg,
            ordersByStatus,
            resaleActive,
            wishlists,
        ] = await Promise.all([
            this.prisma.sku.count({ where: { productId } }),
            this.prisma.sku.count({ where: { productId, claimedStatus: 'CLAIMED' } }),
            this.prisma.inventoryReservation.count({
                where: { sku: { productId }, status: 'HELD' },
            }),
            this.prisma.inventoryReservation.count({
                where: { sku: { productId }, status: 'COMMITTED' },
            }),
            this.prisma.order.groupBy({
                by: ['currency'],
                where: { productId, archivedAt: null, status: { notIn: ['CANCELLED'] } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            this.prisma.order.groupBy({
                by: ['status'],
                where: { productId, archivedAt: null },
                _count: { _all: true },
            }),
            this.prisma.resaleListing.count({
                where: { sku: { productId }, status: 'ACTIVE' },
            }),
            this.prisma.wishlistItem.count({ where: { productId } }),
        ]);

        const revenue: Record<string, string> = {};
        let orders = 0;
        for (const row of orderAgg) {
            revenue[row.currency] = (row._sum.amount ?? new Prisma.Decimal(0)).toString();
            orders += row._count._all;
        }
        const byStatus: Record<string, number> = {};
        for (const row of ordersByStatus) byStatus[row.status] = row._count._all;

        return {
            skuTotal,
            claimed,
            unclaimed: skuTotal - claimed,
            reservedHeld,
            reservedCommitted,
            orders,
            ordersByStatus: byStatus,
            revenue,
            resaleActive,
            wishlists,
        };
    }

    /**
     * Creates a drop, optionally doing more work in the same transaction.
     *
     * `onCreated` exists for one caller: minting the edition alongside the
     * product. It runs after the insert and before the commit, so a failure in
     * it takes the product with it — there is no window where a drop exists
     * with an edition that was supposed to be minted and was not.
     */
    async create(
        data: Prisma.ProductCreateInput,
        onCreated?: (
            tx: Prisma.TransactionClient,
            product: { id: string; groupCode: string; totalSupply: number },
        ) => Promise<void>,
    ): Promise<ProductWithRelations> {
        if (!onCreated) {
            return this.prisma.product.create({ data, include: listInclude });
        }
        return this.prisma.$transaction(
            async (tx) => {
                const created = await tx.product.create({ data, include: listInclude });
                await onCreated(tx, created);
                // Re-read inside the transaction: `created` was projected before
                // the callback ran, so a gallery written by it is absent from that
                // snapshot and the response would claim the drop has no images.
                return (await tx.product.findUniqueOrThrow({
                    where: { id: created.id },
                    include: listInclude,
                })) as ProductWithRelations;
            },
            {
                // Remote (Neon) round-trips add up; the default 5s is too tight.
                //
                // This is four sequential statements at minimum — create the
                // Product, read the highest serial, insert the whole edition,
                // re-read with relations — because `onCreated` mints every unit
                // of the drop in the middle of it. A large edition is a big
                // insert on top of several round trips to us-east-2, which is
                // how a perfectly valid drop still died at 5323ms with
                // "Transaction already closed".
                //
                // Raising the ceiling rather than splitting the work is
                // deliberate: the atomicity is the whole point of this method.
                // A Product that exists with a half-minted edition, and no
                // record of which half, is a far worse outcome than a slow
                // request. Same figures as the claim path in @hitbox/claims.
                maxWait: 10_000,
                timeout: 20_000,
            },
        );
    }

    async update(id: string, data: Prisma.ProductUpdateInput): Promise<ProductWithRelations> {
        const product = await this.prisma.product.update({
            where: { id },
            data: { ...data, updatedAt: new Date() },
            include: listInclude,
        });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.groupCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }

    // ── Gallery ─────────────────────────────────────────────────────────

    /** Live placements for one product, ordered as they render. */
    listImages(productId: string): Promise<ProductImageRow[]> {
        return this.prisma.productImage.findMany({
            where: { productId, archivedAt: null },
            select: productImageSelect,
            orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
        });
    }

    findImage(productId: string, imageId: string): Promise<ProductImageRow | null> {
        return this.prisma.productImage.findFirst({
            where: { id: imageId, productId, archivedAt: null },
            select: productImageSelect,
        });
    }

    /**
     * Writes the gallery for one product.
     *
     * `mode: 'replace'` archives every placement not in `entries` first, so the
     * result is exactly what was sent. `mode: 'append'` leaves existing rows
     * alone.
     *
     * Runs as one transaction because the primary flag is a cross-row
     * invariant: demoting the old primary and promoting the new one in two
     * statements leaves a window with zero primaries, and a listing rendered
     * in that window shows no image.
     *
     * Re-attaching an asset that was previously removed **revives the archived
     * row** rather than inserting a second one — `@@unique([productId,
     * assetId])` spans archived rows too, so a plain insert would fail with a
     * constraint error that means nothing to the operator who just dragged an
     * image back in.
     */
    async writeImages(
        productId: string,
        entries: NormalisedImage[],
        mode: 'append' | 'replace',
        tx?: Prisma.TransactionClient,
    ): Promise<ProductImageRow[]> {
        const run = async (client: Prisma.TransactionClient) => {
            const now = new Date();
            const keepAssetIds = entries.map((entry) => entry.assetId);

            if (mode === 'replace') {
                await client.productImage.updateMany({
                    where: { productId, archivedAt: null, assetId: { notIn: keepAssetIds } },
                    data: { archivedAt: now },
                });
            }

            for (const entry of entries) {
                await client.productImage.upsert({
                    where: { productId_assetId: { productId, assetId: entry.assetId } },
                    create: {
                        id: randomUUID(),
                        productId,
                        assetId: entry.assetId,
                        position: entry.position,
                        isPrimary: entry.isPrimary,
                        altText: entry.altText,
                        createdAt: now,
                    },
                    update: {
                        position: entry.position,
                        isPrimary: entry.isPrimary,
                        altText: entry.altText,
                        // Revives a previously removed placement.
                        archivedAt: null,
                    },
                });
            }

            // Exactly one primary, always. Any row not in `entries` that still
            // claims it is demoted here rather than left as a second primary.
            const primary = entries.find((entry) => entry.isPrimary);
            if (primary) {
                await client.productImage.updateMany({
                    where: {
                        productId,
                        archivedAt: null,
                        isPrimary: true,
                        assetId: { not: primary.assetId },
                    },
                    data: { isPrimary: false },
                });
            }
        };

        // Read back through the SAME client. A caller-supplied `tx` has not
        // committed yet, so reading through `this.prisma` here would open a
        // second connection that cannot see any of the rows just written and
        // would report an empty gallery.
        if (tx) {
            await run(tx);
            return tx.productImage.findMany({
                where: { productId, archivedAt: null },
                select: productImageSelect,
                orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
            });
        }

        await this.prisma.$transaction(run);
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listImages(productId);
    }

    /** Soft-removes one placement. The `MediaAsset` itself is untouched. */
    async archiveImage(productId: string, imageId: string): Promise<ProductImageRow[]> {
        await this.prisma.$transaction(async (tx) => {
            const removed = await tx.productImage.update({
                where: { id: imageId },
                data: { archivedAt: new Date(), isPrimary: false },
                select: { isPrimary: true },
            });
            // Removing the primary promotes the next image rather than leaving
            // the drop with a gallery and no card image.
            if (removed.isPrimary) {
                const next = await tx.productImage.findFirst({
                    where: { productId, archivedAt: null },
                    orderBy: { position: 'asc' },
                    select: { id: true },
                });
                if (next) {
                    await tx.productImage.update({
                        where: { id: next.id },
                        data: { isPrimary: true },
                    });
                }
            }
        });
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listImages(productId);
    }

    /**
     * Soft archive — products are never hard-deleted (provenance!).
     *
     * Sets both `archivedAt` and `isActive: false`. The old single `state`
     * column expressed this in one value; the current schema splits the soft
     * delete from the kill switch, and leaving `isActive` true on an archived
     * row would make it visible to any query that checks only one of them.
     */
    async archive(id: string): Promise<ProductWithRelations> {
        const now = new Date();
        const product = await this.prisma.product.update({
            where: { id },
            data: { isActive: false, archivedAt: now, status: DropStatus.ARCHIVED, updatedAt: now },
            include: listInclude,
        });
        await Promise.all([
            this.cache.invalidateEntity(product.id, product.groupCode),
            this.cache.invalidateLists(),
        ]);
        return product;
    }
}

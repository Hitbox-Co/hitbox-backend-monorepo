import { randomUUID } from 'node:crypto';
import { DropStatus, Prisma, DropPriceStatus } from '@hitbox/database';
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
} satisfies Prisma.Drop$dropImagesArgs;

/** The one base price a market-less feed can legitimately show. */
const basePriceArgs = {
    where: {
        status: DropPriceStatus.ACTIVE,
        variantId: null,
        market: { isDefault: true, isActive: true },
    },
    take: 1,
    select: {
        amount: true,
        isFree: true,
        market: { select: { currency: true, code: true } },
    },
} satisfies Prisma.Drop$dropPricesArgs;

const listInclude = {
    dropImages: imageArgs,
    dropPrices: basePriceArgs,
    dropVariants: { where: { archivedAt: null }, orderBy: { position: 'asc' } },
    collection: { include: { artist: true } },
    artist: true,
} satisfies Prisma.DropInclude;

export type ProductWithRelations = Prisma.DropGetPayload<{ include: typeof listInclude }>;

const discoverSelect = {
    id: true,
    name: true,
    dropImages: { ...imageArgs, take: 1 },
} satisfies Prisma.DropSelect;

export type ProductDiscoverRow = Prisma.DropGetPayload<{ select: typeof discoverSelect }>;

const marketplaceSelect = {
    id: true,
    name: true,
    dropImages: { ...imageArgs, take: 1 },
    dropPrices: basePriceArgs,
    collection: { select: { artist: { select: { name: true } } } },
    artist: { select: { name: true } },
} satisfies Prisma.DropSelect;

export type ProductListingRow = Prisma.DropGetPayload<{ select: typeof marketplaceSelect }>;

/** One gallery placement, with the asset it points at. */
const productImageSelect = {
    id: true,
    assetId: true,
    position: true,
    isPrimary: true,
    altText: true,
    createdAt: true,
    asset: { select: { storageRef: true } },
} satisfies Prisma.DropImageSelect;

export type ProductImageRow = Prisma.DropImageGetPayload<{
    select: typeof productImageSelect;
}>;

/** One price point, with the market it settles in. */
const productPriceSelect = {
    id: true,
    marketId: true,
    variantId: true,
    amount: true,
    isFree: true,
    costOfGoods: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    market: { select: { code: true, name: true, currency: true } },
} satisfies Prisma.DropPriceSelect;

export type ProductPriceRow = Prisma.DropPriceGetPayload<{
    select: typeof productPriceSelect;
}>;

/** A price after the service has resolved its market and validated it. */
export interface NormalisedPrice {
    marketId: string;
    variantId: string | null;
    amount: string | null;
    isFree: boolean;
    costOfGoods: string | null;
    status: DropPriceStatus;
}

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
} satisfies Record<string, Prisma.DropOrderByWithRelationInput>;

export type ProductSort = keyof typeof PRODUCT_SORTS;

/**
 * What the public catalog may show: inside its release window, not
 * deactivated, not archived.
 *
 * Replaces `state: ProductState.ACTIVE`. `DropStatus.ACTIVE` alone is not
 * enough — `isActive` is a separate kill switch and `archivedAt` is the soft
 * delete, and a row can carry any combination.
 */
export const PUBLIC_PRODUCT_WHERE: Prisma.DropWhereInput = {
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

        const where: Prisma.DropWhereInput = {
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
            this.prisma.drop.findMany({
                where,
                include: listInclude,
                orderBy: PRODUCT_SORTS[query.sort],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
            this.prisma.drop.count({ where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('catalog', query, result);
        return result;
    }

    /** Minimal card projection for the discover feed — no joins beyond one image. */
    async findForDiscover(params: {
        where: Prisma.DropWhereInput;
        orderBy: Prisma.DropOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductDiscoverRow[]; total: number }> {
        type Result = { items: ProductDiscoverRow[]; total: number };
        const cached = await this.cache.getList<Result>('discover', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.drop.findMany({
                where: params.where,
                select: discoverSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.drop.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('discover', params, result);
        return result;
    }

    /** Listing card projection for the marketplace feed — price + artist name. */
    async findForMarketplace(params: {
        where: Prisma.DropWhereInput;
        orderBy: Prisma.DropOrderByWithRelationInput;
        skip: number;
        take: number;
    }): Promise<{ items: ProductListingRow[]; total: number }> {
        type Result = { items: ProductListingRow[]; total: number };
        const cached = await this.cache.getList<Result>('marketplace', params);
        if (cached) return cached;

        const [items, total] = await this.prisma.$transaction([
            this.prisma.drop.findMany({
                where: params.where,
                select: marketplaceSelect,
                orderBy: params.orderBy,
                skip: params.skip,
                take: params.take,
            }),
            this.prisma.drop.count({ where: params.where }),
        ]);

        const result: Result = { items, total };
        await this.cache.setList('marketplace', params, result);
        return result;
    }

    async findById(id: string): Promise<ProductWithRelations | null> {
        const cached = await this.cache.getEntity<ProductWithRelations>('id', id);
        if (cached) return cached;

        const product = await this.prisma.drop.findUnique({
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

        const product = await this.prisma.drop.findUnique({
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
        data: Prisma.DropCreateInput,
        onCreated?: (
            tx: Prisma.TransactionClient,
            product: { id: string; groupCode: string; totalSupply: number },
        ) => Promise<void>,
    ): Promise<ProductWithRelations> {
        if (!onCreated) {
            return this.prisma.drop.create({ data, include: listInclude });
        }
        return this.prisma.$transaction(
            async (tx) => {
                const created = await tx.drop.create({ data, include: listInclude });
                await onCreated(tx, created);
                // Re-read inside the transaction: `created` was projected before
                // the callback ran, so a gallery written by it is absent from that
                // snapshot and the response would claim the drop has no images.
                return (await tx.drop.findUniqueOrThrow({
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

    async update(id: string, data: Prisma.DropUpdateInput): Promise<ProductWithRelations> {
        const product = await this.prisma.drop.update({
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
        return this.prisma.dropImage.findMany({
            where: { productId, archivedAt: null },
            select: productImageSelect,
            orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
        });
    }

    findImage(productId: string, imageId: string): Promise<ProductImageRow | null> {
        return this.prisma.dropImage.findFirst({
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
                await client.dropImage.updateMany({
                    where: { productId, archivedAt: null, assetId: { notIn: keepAssetIds } },
                    data: { archivedAt: now },
                });
            }

            for (const entry of entries) {
                await client.dropImage.upsert({
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
                await client.dropImage.updateMany({
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
            return tx.dropImage.findMany({
                where: { productId, archivedAt: null },
                select: productImageSelect,
                orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
            });
        }

        await this.prisma.$transaction(run);
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listImages(productId);
    }

    // ── Prices ──────────────────────────────────────────────────────────

    /**
     * "The price that is in force right now", as a where-clause.
     *
     * `DropPrice` is versioned as of v3.1: `@@unique([dropId, variantId,
     * marketId, effectiveFrom])` lets one drop/variant/market triple hold its
     * whole price history, which means a unique index can no longer express
     * "at most one active price" — a superseded row is still a row. Every read
     * below that used to mean "the price" now says so explicitly.
     *
     * Existing rows all have `effectiveTo` null and an `effectiveFrom` of the
     * migration time, so they all satisfy this and behaviour is unchanged.
     */
    private static currentPrice(now = new Date()): Prisma.DropPriceWhereInput {
        return {
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        };
    }

    listPrices(productId: string): Promise<ProductPriceRow[]> {
        return this.prisma.dropPrice.findMany({
            where: { dropId: productId, ...ProductRepository.currentPrice() },
            select: productPriceSelect,
            // Base prices (variantId null) before variant overrides, then by
            // market code — the order a pricing table reads in.
            orderBy: [{ variantId: 'asc' }, { market: { code: 'asc' } }],
        });
    }

    findPrice(productId: string, priceId: string): Promise<ProductPriceRow | null> {
        return this.prisma.dropPrice.findFirst({
            where: { id: priceId, dropId: productId },
            select: productPriceSelect,
        });
    }

    /**
     * Writes the price list for one product.
     *
     * `mode: 'replace'` deletes price points not in `entries`, and only ones
     * currently in force. Deletion rather than soft-archive because an *order*
     * snapshots what it charged at purchase time, so nothing downstream reads
     * back through this row.
     */
    async writePrices(
        productId: string,
        entries: NormalisedPrice[],
        mode: 'upsert' | 'replace',
        tx?: Prisma.TransactionClient,
    ): Promise<ProductPriceRow[]> {
        const run = async (client: Prisma.TransactionClient) => {
            const now = new Date();

            if (mode === 'replace') {
                const keep = entries.map((entry) => ({
                    marketId: entry.marketId,
                    variantId: entry.variantId,
                }));
                await client.dropPrice.deleteMany({
                    where: {
                        dropId: productId,
                        ...ProductRepository.currentPrice(now),
                        ...(keep.length > 0 ? { NOT: { OR: keep } } : {}),
                    },
                });
            }

            // Matched by hand rather than through `upsert`, because the
            // compound unique cannot be used as a lookup key here:
            // `variantId` is nullable, and in Postgres NULLs
            // never collide in a unique index. So the constraint does NOT
            // actually prevent two *base* prices (variantId NULL) for the same
            // market, and Prisma will not accept null in the compound key
            // either. Reading the current rows and keying on
            // `marketId::variantId` handles both cases and is the only place
            // that uniqueness is genuinely enforced — which is why the service
            // rejects duplicates in the payload before we get here.
            const current = await client.dropPrice.findMany({
                where: { dropId: productId, ...ProductRepository.currentPrice(now) },
                select: { id: true, marketId: true, variantId: true },
            });
            const existing = new Map(
                current.map((row) => [`${row.marketId}::${row.variantId ?? ''}`, row.id]),
            );

            for (const entry of entries) {
                const key = `${entry.marketId}::${entry.variantId ?? ''}`;
                const id = existing.get(key);
                const values = {
                    amount: entry.amount,
                    isFree: entry.isFree,
                    costOfGoods: entry.costOfGoods,
                    status: entry.status,
                    updatedAt: now,
                };

                if (id) {
                    await client.dropPrice.update({ where: { id }, data: values });
                } else {
                    await client.dropPrice.create({
                        data: {
                            id: randomUUID(),
                            dropId: productId,
                            variantId: entry.variantId,
                            marketId: entry.marketId,
                            createdAt: now,
                            ...values,
                        },
                    });
                }
            }
        };

        // Read back through the same client — a caller-supplied `tx` has not
        // committed, so `this.prisma` would see none of these rows.
        if (tx) {
            await run(tx);
            return tx.dropPrice.findMany({
                where: { dropId: productId, ...ProductRepository.currentPrice() },
                select: productPriceSelect,
                orderBy: [{ variantId: 'asc' }, { market: { code: 'asc' } }],
            });
        }

        await this.prisma.$transaction(run);
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listPrices(productId);
    }

    async updatePrice(
        productId: string,
        priceId: string,
        data: Prisma.DropPriceUpdateInput,
    ): Promise<ProductPriceRow[]> {
        await this.prisma.dropPrice.update({
            where: { id: priceId },
            data: { ...data, updatedAt: new Date() },
        });
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listPrices(productId);
    }

    async deletePrice(productId: string, priceId: string): Promise<ProductPriceRow[]> {
        await this.prisma.dropPrice.delete({ where: { id: priceId } });
        await Promise.all([this.cache.invalidateEntity(productId), this.cache.invalidateLists()]);
        return this.listPrices(productId);
    }

    countPrices(productId: string): Promise<number> {
        return this.prisma.dropPrice.count({
            where: { dropId: productId, ...ProductRepository.currentPrice() },
        });
    }

    /** Which variant ids actually belong to this product. */
    async variantIdsOf(productId: string): Promise<string[]> {
        const rows = await this.prisma.dropVariant.findMany({
            where: { productId },
            select: { id: true },
        });
        return rows.map((row) => row.id);
    }

    /** Soft-removes one placement. The `MediaAsset` itself is untouched. */
    async archiveImage(productId: string, imageId: string): Promise<ProductImageRow[]> {
        await this.prisma.$transaction(async (tx) => {
            const removed = await tx.dropImage.update({
                where: { id: imageId },
                data: { archivedAt: new Date(), isPrimary: false },
                select: { isPrimary: true },
            });
            // Removing the primary promotes the next image rather than leaving
            // the drop with a gallery and no card image.
            if (removed.isPrimary) {
                const next = await tx.dropImage.findFirst({
                    where: { productId, archivedAt: null },
                    orderBy: { position: 'asc' },
                    select: { id: true },
                });
                if (next) {
                    await tx.dropImage.update({
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
        const product = await this.prisma.drop.update({
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

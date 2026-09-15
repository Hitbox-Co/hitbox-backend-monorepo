import { randomInt, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { ComplianceStatus, Prisma } from '@hitbox/database';
import {
    PRODUCT_CODE_MAX_ATTEMPTS,
    PRODUCT_CODE_UNIQUE_LENGTH,
    PRODUCT_EVENTS,
    PRODUCT_IMAGE_ASSET_TYPES,
    PRODUCTS_ERROR_CODES,
} from '../constants/products.constant';
import type { IMediaUrlResolver } from '../domain/interfaces/media-url-resolver.interface';
import type {
    ISkuMinting,
    SkuMintOutcome,
} from '../domain/interfaces/sku-minting.interface';
import type { IMediaAssets } from '../domain/interfaces/media-assets.interface';
import type {
    AttachProductImagesDto,
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    ProductImageResponse,
    ReplaceProductImagesDto,
    UpdateProductDto,
    UpdateProductImageDto,
} from '../dto/product.dto';
import type {
    NormalisedImage,
    ProductImageRow,
    ProductListingRow,
    ProductPerformance,
    ProductRepository,
    ProductWithRelations,
    SkuUnitRow,
} from '../repository/product.repository';

interface ProductServiceDeps {
    products: ProductRepository;
    eventBus: IEventBus;
    logger: Logger;
    /** Optional: without it, image URLs come back null rather than failing. */
    mediaUrls?: IMediaUrlResolver | undefined;
    /**
     * Optional: without it, a create carrying a `skus` block is refused rather
     * than silently creating a drop with no units.
     */
    skuMinting?: ISkuMinting | undefined;
    /**
     * Optional: without it, attaching images is refused rather than writing
     * gallery rows pointing at assets nobody validated.
     */
    mediaAssets?: IMediaAssets | undefined;
}

/**
 * A product as the API returns it.
 *
 * The row no longer carries an image URL or a price, so this is where the
 * two joined shapes are flattened back into the fields a client expects:
 * `images` from `ProductImage → MediaAsset`, `price` from the default
 * market's base `ProductPrice`.
 */
export interface ProductResponse {
    id: string;
    groupCode: string;
    name: string;
    description: string | null;
    vertical: string | null;
    category: string | null;
    rarity: string | null;
    status: string;
    complianceStatus: string;
    totalSupply: number;
    purchaseLimit: number | null;
    releaseStart: string | null;
    releaseEnd: string | null;
    publishedAt: string | null;
    isAgeSpecific: boolean;
    minimumAge: number | null;
    oddsDisclosureRef: string | null;
    isActive: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
    collectionId: string | null;
    artistId: string | null;
    artistName: string | null;
    organizationId: string | null;
    /** Ordered primary-first. Empty when the drop has no artwork yet. */
    images: string[];
    /** Base price in the default market, or null when none is configured. */
    price: { amount: string | null; currency: string; isFree: boolean } | null;
    variants: { id: string; label: string; optionName: string; optionValue: string }[];
}

function generateUniqueSegment(): string {
    let digits = '';
    for (let i = 0; i < PRODUCT_CODE_UNIQUE_LENGTH; i += 1) {
        digits += String(randomInt(0, 10));
    }
    return digits;
}

export class ProductService {
    constructor(private readonly deps: ProductServiceDeps) { }

    async list(query: ListProductsQuery): Promise<PaginatedResult<ProductResponse>> {
        const { items, total } = await this.deps.products.findMany(query);
        return {
            items: items.map((item) => this.toResponse(item)),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        };
    }

    async getById(id: string): Promise<ProductResponse> {
        return this.toResponse(await this.requireById(id));
    }

    /**
     * The product detail screen: the catalog record, how the drop is actually
     * performing, and its serialized units.
     *
     * One call rather than three, because the three numbers must agree — a
     * page that fetches inventory and sales separately can render "500 minted,
     * 620 sold" while both halves are individually correct.
     */
    async getDetail(input: {
        id: string;
        skuPage: number;
        skuLimit: number;
        claimedStatus?: string | undefined;
    }): Promise<
        ProductResponse & {
            performance: ProductPerformance;
            skuUnits: {
                page: number;
                limit: number;
                total: number;
                items: ReturnType<typeof toSkuUnit>[];
            };
        }
    > {
        const product = await this.requireById(input.id);
        const [performance, units] = await Promise.all([
            this.deps.products.performance(input.id),
            this.deps.products.listSkuUnits({
                productId: input.id,
                claimedStatus: input.claimedStatus,
                skip: (input.skuPage - 1) * input.skuLimit,
                take: input.skuLimit,
            }),
        ]);

        return {
            ...this.toResponse(product),
            performance,
            skuUnits: {
                page: input.skuPage,
                limit: input.skuLimit,
                total: units.total,
                items: units.items.map(toSkuUnit),
            },
        };
    }

    /**
     * Lookup by the public product code.
     *
     * Backed by `Product.groupCode` — the restructure renamed the old
     * `productCode` column; the route and its meaning are unchanged.
     */
    async getByGroupCode(groupCode: string): Promise<ProductResponse> {
        const product = await this.deps.products.findByGroupCode(groupCode);
        if (!product) {
            throw AppError.notFound('Product not found', PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return this.toResponse(product);
    }

    /**
     * Creates a drop, and — when the payload carries a `skus` block — mints
     * its edition in the same transaction.
     *
     * This is the "product upload" the admin wizard submits: one request that
     * either produces a drop with N serialized units or produces nothing.
     */
    async create(dto: CreateProductDto): Promise<ProductResponse & { skus?: SkuMintOutcome }> {
        const {
            groupCode: groupSuffix,
            collectionId,
            artistId,
            organizationId,
            skus,
            images,
            ...fields
        } = dto;

        if (skus && !this.deps.skuMinting) {
            throw AppError.badRequest(
                'This deployment cannot mint units; create the drop without `skus`.',
                PRODUCTS_ERROR_CODES.MINTING_UNAVAILABLE,
            );
        }
        // Checked before the insert as well as inside the mint, because the
        // message differs: here it is "your request contradicts itself", there
        // it is "someone else minted while you were deciding".
        if (skus && fields.totalSupply > 0 && skus.count > fields.totalSupply) {
            throw AppError.badRequest(
                `Cannot mint ${skus.count} units for a drop declared as ${fields.totalSupply}.`,
                PRODUCTS_ERROR_CODES.SUPPLY_EXCEEDED,
            );
        }

        // Assets are validated BEFORE the product is written. Inside the
        // transaction a bad asset id would roll back a drop the operator
        // otherwise created correctly, and the whole payload would have to be
        // resubmitted to fix one typo'd uuid.
        if (images?.length) {
            await this.assertUsableAssets(null, images.map((image) => image.assetId));
        }

        // Random 8-digit prefix + 4-digit group suffix; retry on the (rare)
        // unique-constraint collision instead of pre-checking.
        for (let attempt = 1; attempt <= PRODUCT_CODE_MAX_ATTEMPTS; attempt += 1) {
            const groupCode = `${generateUniqueSegment()}${groupSuffix}`;
            // Declared per attempt, so a rolled-back transaction cannot leave a
            // mint result behind for the next one to report.
            let minted: SkuMintOutcome | undefined;
            try {
                const now = new Date();
                const product = await this.deps.products.create({
                    ...fields,
                    // The schema supplies no defaults for these, so the
                    // service does. `id` is a bare @db.Uuid with no
                    // @default(uuid()) — Prisma will not generate it.
                    id: randomUUID(),
                    groupCode,
                    complianceStatus: ComplianceStatus.PENDING,
                    isActive: true,
                    createdAt: now,
                    updatedAt: now,
                    ...(collectionId && { collection: { connect: { id: collectionId } } }),
                    ...(artistId && { artist: { connect: { id: artistId } } }),
                    ...(organizationId && {
                        organization: { connect: { id: organizationId } },
                    }),
                },
                    // Runs inside the product's own transaction; a failure in
                    // either the mint or the gallery rolls the drop back too.
                    skus || images?.length
                        ? async (tx, created) => {
                            if (skus) {
                                minted = await this.deps.skuMinting!.mintWithin(tx, {
                                    productId: created.id,
                                    groupCode: created.groupCode,
                                    totalSupply: created.totalSupply,
                                    count: skus.count,
                                });
                            }
                            if (images?.length) {
                                await this.deps.products.writeImages(
                                    created.id,
                                    normaliseGallery(
                                        images.map((image) => ({
                                            assetId: image.assetId,
                                            ...(image.position !== undefined
                                                ? { position: image.position }
                                                : {}),
                                            ...(image.isPrimary !== undefined
                                                ? { isPrimary: image.isPrimary }
                                                : {}),
                                            altText: image.altText ?? null,
                                        })),
                                        {},
                                    ),
                                    'append',
                                    tx,
                                );
                            }
                        }
                        : undefined,
                );
                await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_CREATED, {
                    productId: product.id,
                    groupCode: product.groupCode,
                    mintedUnits: minted?.minted ?? 0,
                });
                return minted
                    ? { ...this.toResponse(product), skus: minted }
                    : this.toResponse(product);
            } catch (error) {
                if (this.isUniqueViolation(error, 'groupCode') && attempt < PRODUCT_CODE_MAX_ATTEMPTS) {
                    this.deps.logger.warn({ attempt }, 'groupCode collision — retrying');
                    continue;
                }
                throw error;
            }
        }
        throw AppError.conflict(
            'Could not allocate a unique product code',
            PRODUCTS_ERROR_CODES.PRODUCT_CODE_TAKEN,
        );
    }

    async update(id: string, dto: UpdateProductDto): Promise<ProductResponse> {
        await this.requireById(id); // 404 before update
        const { collectionId, artistId, organizationId, ...fields } = dto;
        const product = await this.deps.products.update(id, {
            ...fields,
            ...relationUpdate('collection', collectionId),
            ...relationUpdate('artist', artistId),
            ...relationUpdate('organization', organizationId),
        });
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId: id });
        return this.toResponse(product);
    }

    async archive(id: string): Promise<void> {
        await this.requireById(id);
        await this.deps.products.archive(id);
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_ARCHIVED, { productId: id });
    }

    // ── Gallery ─────────────────────────────────────────────────────────

    async listImages(productId: string): Promise<ProductImageResponse[]> {
        await this.requireById(productId);
        return (await this.deps.products.listImages(productId)).map((row) =>
            this.toImageResponse(row),
        );
    }

    /** `POST /admin/products/:id/images` — append to the gallery. */
    async attachImages(
        productId: string,
        dto: AttachProductImagesDto,
    ): Promise<ProductImageResponse[]> {
        await this.requireById(productId);
        const existing = await this.deps.products.listImages(productId);

        // Re-attaching an asset already in the live gallery is a client bug
        // (usually a double-submit), and silently moving it would hide that.
        const present = new Set(existing.map((row) => row.assetId));
        const duplicate = dto.images.find((image) => present.has(image.assetId));
        if (duplicate) {
            throw AppError.conflict(
                `Asset ${duplicate.assetId} is already in this product's gallery.`,
                PRODUCTS_ERROR_CODES.IMAGE_DUPLICATE,
            );
        }

        await this.assertUsableAssets(
            productId,
            dto.images.map((image) => image.assetId),
        );

        const entries = normaliseGallery(
            [
                ...existing.map((row) => ({
                    assetId: row.assetId,
                    position: row.position,
                    isPrimary: row.isPrimary,
                    altText: row.altText,
                })),
                ...dto.images.map((image) => ({
                    assetId: image.assetId,
                    ...(image.position !== undefined ? { position: image.position } : {}),
                    ...(image.isPrimary !== undefined ? { isPrimary: image.isPrimary } : {}),
                    altText: image.altText ?? null,
                })),
            ],
            { totalWas: existing.length },
        );

        const rows = await this.deps.products.writeImages(productId, entries, 'append');
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map((row) => this.toImageResponse(row));
    }

    /** `PUT /admin/products/:id/images` — replace the gallery wholesale. */
    async replaceImages(
        productId: string,
        dto: ReplaceProductImagesDto,
    ): Promise<ProductImageResponse[]> {
        await this.requireById(productId);

        const seen = new Set<string>();
        for (const image of dto.images) {
            if (seen.has(image.assetId)) {
                throw AppError.badRequest(
                    `Asset ${image.assetId} appears twice in the gallery.`,
                    PRODUCTS_ERROR_CODES.IMAGE_DUPLICATE,
                );
            }
            seen.add(image.assetId);
        }

        await this.assertUsableAssets(
            productId,
            dto.images.map((image) => image.assetId),
        );

        const entries = normaliseGallery(
            dto.images.map((image) => ({
                assetId: image.assetId,
                ...(image.position !== undefined ? { position: image.position } : {}),
                ...(image.isPrimary !== undefined ? { isPrimary: image.isPrimary } : {}),
                altText: image.altText ?? null,
            })),
            {},
        );

        const rows = await this.deps.products.writeImages(productId, entries, 'replace');
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map((row) => this.toImageResponse(row));
    }

    /** `PATCH /admin/products/:id/images/:imageId` — move or relabel one. */
    async updateImage(
        productId: string,
        imageId: string,
        dto: UpdateProductImageDto,
    ): Promise<ProductImageResponse[]> {
        await this.requireById(productId);
        const target = await this.deps.products.findImage(productId, imageId);
        if (!target) {
            throw AppError.notFound(
                'Image placement not found on this product',
                PRODUCTS_ERROR_CODES.IMAGE_NOT_FOUND,
            );
        }

        const existing = await this.deps.products.listImages(productId);
        const entries = normaliseGallery(
            existing.map((row) =>
                row.id === imageId
                    ? {
                        assetId: row.assetId,
                        position: dto.position ?? row.position,
                        isPrimary: dto.isPrimary ?? row.isPrimary,
                        altText: dto.altText !== undefined ? dto.altText : row.altText,
                    }
                    : {
                        assetId: row.assetId,
                        position: row.position,
                        // A second row claiming primary is demoted below.
                        isPrimary: dto.isPrimary === true ? false : row.isPrimary,
                        altText: row.altText,
                    },
            ),
            {},
        );

        const rows = await this.deps.products.writeImages(productId, entries, 'replace');
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map((row) => this.toImageResponse(row));
    }

    /** `DELETE /admin/products/:id/images/:imageId` */
    async removeImage(productId: string, imageId: string): Promise<ProductImageResponse[]> {
        await this.requireById(productId);
        const target = await this.deps.products.findImage(productId, imageId);
        if (!target) {
            throw AppError.notFound(
                'Image placement not found on this product',
                PRODUCTS_ERROR_CODES.IMAGE_NOT_FOUND,
            );
        }
        const rows = await this.deps.products.archiveImage(productId, imageId);
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map((row) => this.toImageResponse(row));
    }

    /**
     * Refuses assets that would render as a broken image.
     *
     * Every failure is reported at once rather than on the first bad id — a
     * client uploading a twelve-image gallery should not have to submit twelve
     * times to learn about twelve problems.
     */
    private async assertUsableAssets(
        productId: string | null,
        assetIds: string[],
    ): Promise<void> {
        if (assetIds.length === 0) return;
        if (!this.deps.mediaAssets) {
            throw AppError.badRequest(
                'This deployment cannot attach media; create the drop without `images`.',
                PRODUCTS_ERROR_CODES.MEDIA_UNAVAILABLE,
            );
        }

        const found = await this.deps.mediaAssets.findByIds(assetIds);
        const byId = new Map(found.map((asset) => [asset.id, asset]));
        const problems: string[] = [];

        for (const assetId of assetIds) {
            const asset = byId.get(assetId);
            if (!asset) {
                problems.push(`${assetId}: no such media asset`);
                continue;
            }
            if (asset.archivedAt) {
                problems.push(`${assetId}: asset is archived`);
                continue;
            }
            if (!PRODUCT_IMAGE_ASSET_TYPES.includes(asset.assetType as 'DROP_IMAGE')) {
                // A private-prefix asset in a public gallery is a URL that
                // 403s for every shopper, forever.
                problems.push(
                    `${assetId}: assetType is ${asset.assetType}, expected one of ` +
                    `${PRODUCT_IMAGE_ASSET_TYPES.join(', ')}`,
                );
                continue;
            }
            if (asset.productId && asset.productId !== productId) {
                problems.push(`${assetId}: uploaded against a different product`);
            }
        }

        if (problems.length > 0) {
            throw AppError.badRequest(
                `Cannot attach: ${problems.join('; ')}`,
                PRODUCTS_ERROR_CODES.IMAGE_ASSET_INVALID,
            );
        }
    }

    private toImageResponse(row: ProductImageRow): ProductImageResponse {
        return {
            imageId: row.id,
            assetId: row.assetId,
            url: this.deps.mediaUrls?.publicUrl(row.asset.storageRef) ?? null,
            storageRef: row.asset.storageRef,
            position: row.position,
            isPrimary: row.isPrimary,
            altText: row.altText,
            createdAt: row.createdAt.toISOString(),
        };
    }

    /** The first renderable image URL for a listing row, or null. */
    imageUrlOf(row: { productImages: { asset: { storageRef: string } }[] }): string | null {
        const ref = row.productImages[0]?.asset.storageRef;
        if (!ref) return null;
        return this.deps.mediaUrls?.publicUrl(ref) ?? null;
    }

    /** The default-market base price of a listing row, as a decimal string. */
    priceOf(row: ProductListingRow): { amount: string | null; currency: string } | null {
        const price = row.productPrices[0];
        if (!price) return null;
        return {
            amount: price.isFree ? '0' : (price.amount?.toString() ?? null),
            currency: price.market.currency,
        };
    }

    private async requireById(id: string): Promise<ProductWithRelations> {
        const product = await this.deps.products.findById(id);
        if (!product) {
            throw AppError.notFound('Product not found', PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return product;
    }

    private toResponse(product: ProductWithRelations): ProductResponse {
        const price = product.productPrices[0];
        return {
            id: product.id,
            groupCode: product.groupCode,
            name: product.name,
            description: product.description,
            vertical: product.vertical,
            category: product.category,
            rarity: product.rarity,
            status: product.status,
            complianceStatus: product.complianceStatus,
            totalSupply: product.totalSupply,
            purchaseLimit: product.purchaseLimit,
            releaseStart: product.releaseStart?.toISOString() ?? null,
            releaseEnd: product.releaseEnd?.toISOString() ?? null,
            publishedAt: product.publishedAt?.toISOString() ?? null,
            isAgeSpecific: product.isAgeSpecific,
            minimumAge: product.minimumAge,
            oddsDisclosureRef: product.oddsDisclosureRef,
            isActive: product.isActive,
            archivedAt: product.archivedAt?.toISOString() ?? null,
            createdAt: product.createdAt.toISOString(),
            updatedAt: product.updatedAt.toISOString(),
            collectionId: product.collectionId,
            artistId: product.artistId,
            artistName: product.artist?.name ?? product.collection?.artist.name ?? null,
            organizationId: product.organizationId,
            images: product.productImages
                .map((image) => this.deps.mediaUrls?.publicUrl(image.asset.storageRef) ?? null)
                .filter((url): url is string => url !== null),
            price: price
                ? {
                    amount: price.isFree ? '0' : (price.amount?.toString() ?? null),
                    currency: price.market.currency,
                    isFree: price.isFree,
                }
                : null,
            variants: product.productVariants.map((variant) => ({
                id: variant.id,
                label: variant.label,
                optionName: variant.optionName,
                optionValue: variant.optionValue,
            })),
        };
    }

    private isUniqueViolation(error: unknown, field: string): boolean {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            return false;
        }
        // meta.target may hold Prisma field names or @map'd column names.
        const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const target = error.meta?.target;
        const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
        return names.some((name) => name.includes(field) || name.includes(snake));
    }
}

/**
 * One serialized unit as the detail screen renders it.
 *
 * The owner is exposed by **email**, not id — an operator looking at unit #14
 * of a disputed drop needs to know who holds it, and a UUID answers that only
 * after another lookup.
 */
function toSkuUnit(sku: SkuUnitRow) {
    return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        serialNumber: sku.serialNumber,
        variantId: sku.variantId,
        claimedStatus: sku.claimedStatus,
        ownerId: sku.ownerId,
        ownerEmail: sku.owner?.email ?? null,
        ownerHandle: sku.owner?.handle ?? null,
        tagId: sku.tagId,
        tagLifecycleState: sku.tagLifecycleState,
        vendorId: sku.vendorId,
        resaleBlocked: sku.resaleBlocked,
        resaleBlockedReason: sku.resaleBlockedReason,
        tamperStatus: sku.tamperStatus,
        lastTapCounter: sku.lastTapCounter,
        isActive: sku.isActive,
        createdAt: sku.createdAt.toISOString(),
    };
}

/**
 * Turns whatever the client sent into a gallery that satisfies both
 * invariants: contiguous 0-based positions, and exactly one primary.
 *
 * Neither is enforced by the schema — `position` is a plain Int and
 * `isPrimary` a plain Boolean, so nothing stops two rows claiming the card
 * image or a gallery numbering itself 0, 5, 5, 11. Both are the kind of drift
 * a drag-and-drop UI produces constantly, and both render wrong rather than
 * failing loudly, so they are normalised on every write.
 *
 * Ordering rule: explicit `position` wins; entries without one keep their
 * arrival order, after the positioned ones. `totalWas` biases appended entries
 * to the end of an existing gallery instead of interleaving them.
 */
export function normaliseGallery(
    entries: {
        assetId: string;
        position?: number | undefined;
        isPrimary?: boolean | undefined;
        altText: string | null;
    }[],
    opts: { totalWas?: number },
): NormalisedImage[] {
    const ordered = entries
        .map((entry, index) => ({
            entry,
            sortKey: entry.position ?? (opts.totalWas ?? 0) + index,
            index,
        }))
        .sort((a, b) => a.sortKey - b.sortKey || a.index - b.index);

    // First explicit claim wins; a second is demoted rather than rejected,
    // because "make this one the cover" is the intent behind every such
    // payload and erroring on it would be pedantry.
    const claimed = ordered.find((row) => row.entry.isPrimary === true);

    return ordered.map((row, position) => ({
        assetId: row.entry.assetId,
        position,
        isPrimary: claimed ? row.entry.assetId === claimed.entry.assetId : position === 0,
        altText: row.entry.altText,
    }));
}

/** `undefined` leaves the relation alone; `null`/'' disconnects it. */
function relationUpdate(
    relation: 'collection' | 'artist' | 'organization',
    id: string | null | undefined,
): Record<string, unknown> {
    if (id === undefined) return {};
    return { [relation]: id ? { connect: { id } } : { disconnect: true } };
}

import { randomInt, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { ComplianceStatus, Prisma } from '@hitbox/database';
import {
    PRODUCT_CODE_MAX_ATTEMPTS,
    PRODUCT_CODE_UNIQUE_LENGTH,
    PRODUCT_EVENTS,
    PRODUCTS_ERROR_CODES,
} from '../constants/products.constant';
import type { IMediaUrlResolver } from '../domain/interfaces/media-url-resolver.interface';
import type {
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    UpdateProductDto,
} from '../dto/product.dto';
import type {
    ProductListingRow,
    ProductRepository,
    ProductWithRelations,
} from '../repository/product.repository';

interface ProductServiceDeps {
    products: ProductRepository;
    eventBus: IEventBus;
    logger: Logger;
    /** Optional: without it, image URLs come back null rather than failing. */
    mediaUrls?: IMediaUrlResolver | undefined;
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

    async create(dto: CreateProductDto): Promise<ProductResponse> {
        const { groupCode: groupSuffix, collectionId, artistId, organizationId, ...fields } = dto;

        // Random 8-digit prefix + 4-digit group suffix; retry on the (rare)
        // unique-constraint collision instead of pre-checking.
        for (let attempt = 1; attempt <= PRODUCT_CODE_MAX_ATTEMPTS; attempt += 1) {
            const groupCode = `${generateUniqueSegment()}${groupSuffix}`;
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
                });
                await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_CREATED, {
                    productId: product.id,
                    groupCode: product.groupCode,
                });
                return this.toResponse(product);
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

/** `undefined` leaves the relation alone; `null`/'' disconnects it. */
function relationUpdate(
    relation: 'collection' | 'artist' | 'organization',
    id: string | undefined,
): Record<string, unknown> {
    if (id === undefined) return {};
    return { [relation]: id ? { connect: { id } } : { disconnect: true } };
}

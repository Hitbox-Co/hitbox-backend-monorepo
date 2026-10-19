import { randomInt, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { ComplianceStatus, DropStatus, Prisma } from '@hitbox/database';
import {
    PRODUCT_AUDIT_EVENTS,
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
import type { IMarketLookup } from '../domain/interfaces/market-lookup.interface';
import type { IProductAudit } from '../domain/interfaces/product-audit.interface';
import type { DropTypeRepository, DropTypeRow } from '../drop-type/drop-type.repository';
import type { VariantRepository } from '../variant/variant.repository';
import type {
    IReleaseGate,
    ReleaseGateVerdict,
} from '../domain/interfaces/release-gate.interface';
import type {
    AttachProductImagesDto,
    CreateProductDto,
    ListProductsQuery,
    PaginatedResult,
    ProductImageResponse,
    ProductPriceInput,
    ProductPriceResponse,
    ClearedReview,
    PublishProductDto,
    ReplaceProductImagesDto,
    SetProductPricesDto,
    UpdateProductDto,
    UpdateProductImageDto,
    UpdateProductPriceDto,
} from '../dto/product.dto';
import type {
    NormalisedImage,
    NormalisedPrice,
    ProductImageRow,
    ProductPriceRow,
    ProductListingRow,
    ProductPerformance,
    ProductRepository,
    ProductWithRelations,
    SkuUnitRow,
} from '../repository/product.repository';

/** What `POST /admin/products/:id/publish` returns. */
export interface PublishProductResult {
    product: ProductResponse;
    /** The review this publication cleared. */
    clearedReview: ClearedReview;
}

interface ProductServiceDeps {
    products: ProductRepository;
    /**
     * Resolves `dropType` on create/update. Optional so existing test
     * harnesses build without it; a `dropType` sent to a service without it
     * is refused rather than ignored.
     */
    dropTypes?: DropTypeRepository | undefined;
    /** Answers "does this drop have variants yet?" — a drop's type locks once it does. */
    variants?: VariantRepository | undefined;
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
    /**
     * Resolves the markets a price refers to, and the currency each settles
     * in. Provided by @hitbox/markets, which owns the `Market` table.
     *
     * Optional: without it, pricing is refused rather than writing rows
     * pointing at markets nobody validated.
     */
    markets?: IMarketLookup | undefined;
    /**
     * Answers "has this drop cleared review?". Provided by @hitbox/releases,
     * which owns `ReleaseApproval`.
     *
     * Optional so a test harness can build the service without it — but
     * publishing is **refused** when it is absent rather than allowed. A
     * deployment that cannot verify an approval must not take drops live on
     * the assumption that one exists.
     */
    releaseGate?: IReleaseGate | undefined;
    /**
     * The compliance trail for publication. Optional so tests need not wire
     * the audit module; a server must pass the real recorder, or a drop goes
     * live with nothing recording who did it.
     */
    audit?: IProductAudit | undefined;
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
    /** The product type, or null for a legacy (untyped) drop. */
    dropType: { code: string; name: string; variantMode: string } | null;
    /**
     * Active variants. `optionName` / `optionValue` are unchanged for existing
     * clients; `options` is the per-dimension breakdown, with color swatches.
     */
    variants: {
        id: string;
        variantCode: string;
        label: string;
        optionName: string;
        optionValue: string;
        options: { dimension: string; value: string; label: string; hexCode: string | null }[];
        totalSupply: number | null;
        isActive: boolean;
    }[];
}

/**
 * A timestamp as the API returns it, from whatever the row actually holds.
 *
 * Belt to the cache codec's braces. The codec is the fix — it keeps Dates as
 * Dates across Redis — but two realities keep this here:
 *
 *  1. **Stale entries survive a deploy.** Rows cached by the previous build
 *     hold untagged ISO strings and stay readable for their full TTL. Without
 *     this, the endpoint keeps throwing for minutes after the fix ships.
 *  2. A cast at any future serialization boundary can reintroduce the same
 *     mismatch, and the failure mode — a 500 only on a warm cache — is
 *     expensive to diagnose relative to four lines here.
 */
function toIso(value: Date | string | null | undefined): string | null {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    // Already an ISO string from a JSON round trip; re-parse so an invalid
    // value surfaces as null rather than as plausible-looking garbage.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
            dropType: dropTypeCode,
            skus,
            images,
            prices,
            ...fields
        } = dto;

        const dropType = dropTypeCode ? await this.requireActiveDropType(dropTypeCode) : null;

        // A REQUIRED-variant drop has no variants at the moment it is created,
        // so units minted inline would belong to no variant — a T-shirt with no
        // size. Create the drop, add variants, then mint per variant.
        if (skus && dropType?.variantMode === 'REQUIRED') {
            throw AppError.badRequest(
                `Every unit of a ${dropType.name} must belong to a variant, and this drop has none yet. ` +
                'Create it without `skus`, add variants, then mint through ' +
                'POST /admin/products/:productId/skus with a variantId.',
                PRODUCTS_ERROR_CODES.VARIANTS_REQUIRED,
            );
        }

        if (skus && !this.deps.skuMinting) {
            throw AppError.badRequest(
                'This deployment cannot mint units; create the drop without `skus`.',
                PRODUCTS_ERROR_CODES.MINTING_UNAVAILABLE,
            );
        }

        /**
         * Units may not be minted for a drop that will need its owner's
         * approval — the approval has to come first.
         *
         * A drop is born in DRAFT, so an owned drop is never approved at the
         * moment it is created and a `skus` block here could never be
         * legitimate. Minting it anyway would create serialized inventory for
         * a drop the artist may yet reject, which somebody then has to
         * reconcile against nothing.
         *
         * A drop naming neither an artist nor an organization has no owner to
         * ask, so it stays mintable at creation exactly as before. That is
         * asked through the gate rather than re-derived here, so the authority
         * rule lives in one place — see domain/interfaces/release-gate.interface.ts.
         */
        if (skus && this.deps.releaseGate) {
            const needsApproval = this.deps.releaseGate.requiresApproval({
                artistId: dto.artistId ?? null,
                organizationId: dto.organizationId ?? null,
            });
            if (needsApproval) {
                throw AppError.badRequest(
                    'This drop belongs to an artist or organization, so its units cannot be ' +
                    'minted until its owner has approved it. Create the drop, submit it for ' +
                    'review, then mint through POST /admin/products/:productId/skus.',
                    PRODUCTS_ERROR_CODES.NOT_APPROVED,
                );
            }
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

        // Markets are resolved before the product is written too, and for the
        // same reason: a mistyped market code should not roll back a drop that
        // was otherwise correct. `productId` is null because the drop does not
        // exist yet — which also means no variant prices are possible here.
        const priceEntries = await this.resolvePrices(null, prices);

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
                    ...(dropType && {
                        dropType: { connect: { id: dropType.id } },
                        dropTypeVersion: dropType.version,
                    }),
                },
                    // Runs inside the product's own transaction; a failure in
                    // either the mint or the gallery rolls the drop back too.
                    async (tx, created) => {
                            // Prices first: they are required, so a failure
                            // here should abort before any units are minted.
                            await this.deps.products.writePrices(
                                created.id,
                                priceEntries,
                                'upsert',
                                tx,
                            );
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
                        },
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
        const current = await this.requireById(id); // 404 before update
        const { collectionId, artistId, organizationId, dropType: dropTypeCode, ...fields } = dto;

        // The type decides which variants are valid, so it is fixed once the
        // drop has any — changing it would orphan them under rules they were
        // never checked against.
        let dropTypeChange: Prisma.DropUpdateInput = {};
        if (dropTypeCode !== undefined && dropTypeCode !== (current.dropType?.code ?? null)) {
            if (this.deps.variants && (await this.deps.variants.hasAny(id))) {
                throw AppError.conflict(
                    'This drop already has variants, so its drop type cannot change. ' +
                    'Remove the variants first, or create a new drop.',
                    PRODUCTS_ERROR_CODES.DROP_TYPE_LOCKED,
                );
            }
            if (dropTypeCode === null) {
                dropTypeChange = { dropType: { disconnect: true }, dropTypeVersion: null };
            } else {
                const type = await this.requireActiveDropType(dropTypeCode);
                dropTypeChange = { dropType: { connect: { id: type.id } }, dropTypeVersion: type.version };
            }
        }

        const product = await this.deps.products.update(id, {
            ...fields,
            ...dropTypeChange,
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

    /**
     * Takes a drop live.
     *
     * The last gate before a drop becomes purchasable, and the reason it is a
     * route of its own rather than `PATCH { status }`: every check below is a
     * question about the drop's **whole state**, not about one field, and a
     * generic field-patcher has nowhere to put them.
     *
     * The checks run in a deliberate order — cheapest and most fundamental
     * first, so the reason a caller gets back is the most useful one rather
     * than whichever check happened to be written first.
     */
    async publish(input: {
        id: string;
        dto: PublishProductDto;
        actorId: string;
        correlationId: string;
    }): Promise<PublishProductResult> {
        const product = await this.requireById(input.id);

        // 1. Is it a drop that can be live at all?
        if (product.archivedAt !== null) {
            throw AppError.conflict(
                'This drop is archived. Restore it before publishing.',
                PRODUCTS_ERROR_CODES.NOT_PUBLISHABLE,
            );
        }
        if (product.status === input.dto.target) {
            throw AppError.conflict(
                `This drop is already ${input.dto.target}.`,
                PRODUCTS_ERROR_CODES.NOT_PUBLISHABLE,
            );
        }
        if (
            product.status === DropStatus.ENDED ||
            product.status === DropStatus.ARCHIVED
        ) {
            throw AppError.conflict(
                `A drop that is ${product.status} cannot be published again.`,
                PRODUCTS_ERROR_CODES.NOT_PUBLISHABLE,
            );
        }

        // 2. Has its owner approved it?
        //
        // Refused rather than skipped when the gate is not wired in. A
        // deployment that cannot verify an approval must not take drops live
        // on the assumption one exists — that is precisely the hole this
        // endpoint was built to close.
        if (!this.deps.releaseGate) {
            throw AppError.badRequest(
                'Publication is unavailable on this deployment: approvals cannot be verified.',
                PRODUCTS_ERROR_CODES.RELEASE_GATE_UNAVAILABLE,
            );
        }
        const review = await this.deps.releaseGate.describeLatest(input.id);
        if (!review.cleared) {
            await this.recordPublishAttempt(input, product, review, 'DENIED');
            throw AppError.conflict(
                review.reason ?? 'This drop has not been approved for release.',
                PRODUCTS_ERROR_CODES.NOT_APPROVED,
                {
                    approvalId: review.approvalId,
                    version: review.version,
                    status: review.status,
                },
            );
        }

        // 3. Is its compliance evidence complete?
        //
        // Checked again here rather than trusted from the approval: the
        // approval was recorded against the drop as it stood then, and these
        // fields are editable afterwards. An age flag added after sign-off
        // would otherwise go live unchecked.
        if (product.isAgeSpecific && product.minimumAge === null) {
            throw AppError.badRequest(
                'This drop is age-restricted but carries no minimum age. Set one before publishing.',
                PRODUCTS_ERROR_CODES.PUBLISH_BLOCKED,
                { field: 'minimumAge' },
            );
        }

        // 4. Is there anything to sell?
        const priceCount = await this.deps.products.countActivePrices(input.id);
        if (priceCount === 0) {
            throw AppError.badRequest(
                'This drop has no active price. Add one before publishing.',
                PRODUCTS_ERROR_CODES.PUBLISH_BLOCKED,
                { field: 'prices' },
            );
        }

        // A drop declaring supply but holding no serialized units would be
        // purchasable with nothing to deliver.
        if (product.totalSupply > 0) {
            const minted = await this.deps.products.countSkus(input.id);
            if (minted === 0) {
                throw AppError.badRequest(
                    `This drop declares ${product.totalSupply} units but none have been minted. ` +
                    'Mint the edition before publishing.',
                    PRODUCTS_ERROR_CODES.PUBLISH_BLOCKED,
                    { field: 'skus', totalSupply: product.totalSupply, minted: 0 },
                );
            }
        }

        // ── Go live ─────────────────────────────────────────────────────────
        const published = await this.deps.products.publish(input.id, {
            status: input.dto.target,
            // First publication only. A drop staged to PUBLISHED and later
            // moved to ACTIVE keeps the moment it first went out, which is what
            // `publishedAt` means — `publishAt` is the scheduled intent and is
            // a different column.
            setPublishedAt: product.publishedAt === null,
        });

        await this.recordPublishAttempt(input, product, review, 'SUCCESS');

        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_PUBLISHED, {
            productId: input.id,
            status: input.dto.target,
            approvalId: review.approvalId,
            authority: review.authority,
            actorId: input.actorId,
        });
        this.deps.logger.info(
            {
                productId: input.id,
                from: product.status,
                to: input.dto.target,
                approvalId: review.approvalId,
                authority: review.authority,
            },
            'drop published',
        );

        return {
            product: this.toResponse(published),
            clearedReview: {
                approvalId: review.approvalId,
                version: review.version,
                status: review.status,
                authority: review.authority,
            },
        };
    }

    /**
     * Records the attempt, allowed or refused.
     *
     * A refused publication is worth recording: someone trying to take an
     * unapproved drop live is exactly what the approval rule exists to stop,
     * and the refusal leaves no other trace.
     */
    private async recordPublishAttempt(
        input: { id: string; dto: PublishProductDto; actorId: string; correlationId: string },
        product: ProductWithRelations,
        review: ReleaseGateVerdict,
        result: 'SUCCESS' | 'DENIED',
    ): Promise<void> {
        if (!this.deps.audit) return;
        await this.deps.audit.record({
            eventType: PRODUCT_AUDIT_EVENTS.PUBLISH,
            actorId: input.actorId,
            organizationId: product.organizationId,
            productId: input.id,
            result,
            correlationId: input.correlationId,
            before: { status: product.status, publishedAt: product.publishedAt },
            ...(result === 'SUCCESS' ? { after: { status: input.dto.target } } : {}),
            metadata: {
                approvalId: review.approvalId,
                approvalVersion: review.version,
                approvalStatus: review.status,
                authority: review.authority,
                ...(result === 'DENIED' ? { reason: review.reason } : {}),
                ...(input.dto.note ? { note: input.dto.note } : {}),
            },
        });
    }

    // ── Prices ──────────────────────────────────────────────────────────

    async listPrices(productId: string): Promise<ProductPriceResponse[]> {
        await this.requireById(productId);
        return (await this.deps.products.listPrices(productId)).map(toPriceResponse);
    }

    /**
     * `PUT /admin/products/:id/prices` — replace the price list.
     *
     * Replace rather than merge: a pricing table is edited as a whole, and
     * "these are the prices now" is the only statement that can express
     * *removing* a market. The schema requires at least one entry, so this can
     * never leave a drop unsellable.
     */
    async setPrices(
        productId: string,
        dto: SetProductPricesDto,
    ): Promise<ProductPriceResponse[]> {
        await this.requireById(productId);
        const entries = await this.resolvePrices(productId, dto.prices);
        const rows = await this.deps.products.writePrices(productId, entries, 'replace');
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map(toPriceResponse);
    }

    /** `PATCH /admin/products/:id/prices/:priceId` — edit one price point. */
    async updatePrice(
        productId: string,
        priceId: string,
        dto: UpdateProductPriceDto,
    ): Promise<ProductPriceResponse[]> {
        await this.requireById(productId);
        const existing = await this.deps.products.findPrice(productId, priceId);
        if (!existing) {
            throw AppError.notFound(
                'Price point not found on this product',
                PRODUCTS_ERROR_CODES.PRICE_NOT_FOUND,
            );
        }

        // The free/amount pair has to stay coherent across a partial edit: the
        // schema can only see the fields that arrived, so flipping isFree on a
        // priced row (or off a free one) is checked against the stored row.
        const isFree = dto.isFree ?? existing.isFree;
        const amount = dto.amount ?? (dto.isFree === true ? null : existing.amount?.toString() ?? null);
        if (!isFree && amount === null) {
            throw AppError.badRequest(
                'A priced entry needs an amount; send `isFree: true` to make it free instead.',
                PRODUCTS_ERROR_CODES.PRICE_MARKET_INVALID,
            );
        }

        const rows = await this.deps.products.updatePrice(productId, priceId, {
            isFree,
            amount: isFree ? null : amount,
            ...(dto.costOfGoods !== undefined ? { costOfGoods: dto.costOfGoods } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
        });
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map(toPriceResponse);
    }

    /** `DELETE /admin/products/:id/prices/:priceId` */
    async removePrice(productId: string, priceId: string): Promise<ProductPriceResponse[]> {
        await this.requireById(productId);
        const existing = await this.deps.products.findPrice(productId, priceId);
        if (!existing) {
            throw AppError.notFound(
                'Price point not found on this product',
                PRODUCTS_ERROR_CODES.PRICE_NOT_FOUND,
            );
        }

        // The compulsory-pricing rule has to hold after a delete too, or it is
        // only enforced on the path people happen to use first.
        if ((await this.deps.products.countPrices(productId)) <= 1) {
            throw AppError.conflict(
                'This is the drop\'s only price. A drop must keep at least one market price — ' +
                'add another market first, or disable this one with `status: "DISABLED"`.',
                PRODUCTS_ERROR_CODES.PRICE_REQUIRED,
            );
        }

        const rows = await this.deps.products.deletePrice(productId, priceId);
        await this.deps.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId });
        return rows.map(toPriceResponse);
    }

    /**
     * Turns price input into rows, resolving each market and refusing the ones
     * that would produce a price nobody can buy at.
     *
     * Every problem is reported at once — a pricing table is filled in for
     * several markets in one sitting, and one error per submission is a poor
     * way to find three typos.
     */
    private async resolvePrices(
        productId: string | null,
        prices: ProductPriceInput[],
    ): Promise<NormalisedPrice[]> {
        if (!this.deps.markets) {
            throw AppError.badRequest(
                'This deployment cannot resolve markets, so prices cannot be set.',
                PRODUCTS_ERROR_CODES.MARKETS_UNAVAILABLE,
            );
        }

        const ids = prices
            .map((price) => price.marketId)
            .filter((value): value is string => value !== undefined);
        const codes = prices
            .map((price) => price.marketCode)
            .filter((value): value is string => value !== undefined);

        const found = await this.deps.markets.findManyByIdsOrCodes(ids, codes);
        const byId = new Map(found.map((market) => [market.id, market]));
        // Codes are matched case-insensitively: markets store them upper-cased
        // and an operator typing "in" means India.
        const byCode = new Map(found.map((market) => [market.code.toUpperCase(), market]));

        // Variant prices can only reference this product's own variants. On
        // create there are none, so any variantId is necessarily another
        // product's — and the foreign key would accept it.
        const ownVariantIds = productId
            ? new Set(await this.deps.products.variantIdsOf(productId))
            : new Set<string>();

        const problems: string[] = [];
        const entries: NormalisedPrice[] = [];

        for (const price of prices) {
            const label = price.marketCode ?? price.marketId ?? '(no market)';
            const market = price.marketId
                ? byId.get(price.marketId)
                : byCode.get(price.marketCode!.toUpperCase());

            if (!market) {
                problems.push(`${label}: no such market`);
                continue;
            }
            if (market.archivedAt) {
                problems.push(`${market.code}: market is archived`);
                continue;
            }
            if (!market.isActive) {
                problems.push(`${market.code}: market is inactive`);
                continue;
            }
            if (price.variantId && !ownVariantIds.has(price.variantId)) {
                problems.push(
                    `${market.code}: variant ${price.variantId} does not belong to this product`,
                );
                continue;
            }

            entries.push({
                marketId: market.id,
                variantId: price.variantId ?? null,
                amount: price.isFree ? null : (price.amount ?? null),
                isFree: price.isFree,
                costOfGoods: price.costOfGoods ?? null,
                status: price.status,
            });
        }

        if (problems.length > 0) {
            throw AppError.badRequest(
                `Cannot price: ${problems.join('; ')}`,
                PRODUCTS_ERROR_CODES.PRICE_MARKET_INVALID,
            );
        }
        return entries;
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
    imageUrlOf(row: { dropImages: { asset: { storageRef: string } }[] }): string | null {
        const ref = row.dropImages[0]?.asset.storageRef;
        if (!ref) return null;
        return this.deps.mediaUrls?.publicUrl(ref) ?? null;
    }

    /** The default-market base price of a listing row, as a decimal string. */
    priceOf(row: ProductListingRow): { amount: string | null; currency: string } | null {
        const price = row.dropPrices[0];
        if (!price) return null;
        return {
            amount: price.isFree ? '0.00' : (price.amount?.toFixed(2) ?? null),
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
        const price = product.dropPrices[0];
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
            releaseStart: toIso(product.releaseStart),
            releaseEnd: toIso(product.releaseEnd),
            publishedAt: toIso(product.publishedAt),
            isAgeSpecific: product.isAgeSpecific,
            minimumAge: product.minimumAge,
            oddsDisclosureRef: product.oddsDisclosureRef,
            isActive: product.isActive,
            archivedAt: toIso(product.archivedAt),
            createdAt: toIso(product.createdAt) ?? '',
            updatedAt: toIso(product.updatedAt) ?? '',
            collectionId: product.collectionId,
            artistId: product.artistId,
            artistName: product.artist?.name ?? product.collection?.artist.name ?? null,
            organizationId: product.organizationId,
            images: product.dropImages
                .map((image) => this.deps.mediaUrls?.publicUrl(image.asset.storageRef) ?? null)
                .filter((url): url is string => url !== null),
            price: price
                ? {
                    amount: price.isFree ? '0.00' : (price.amount?.toFixed(2) ?? null),
                    currency: price.market.currency,
                    isFree: price.isFree,
                }
                : null,
            dropType: product.dropType
                ? {
                    code: product.dropType.code,
                    name: product.dropType.name,
                    variantMode: product.dropType.variantMode,
                }
                : null,
            variants: product.dropVariants.map((variant) => ({
                id: variant.id,
                variantCode: variant.variantCode,
                label: variant.label,
                optionName: variant.optionName,
                optionValue: variant.optionValue,
                options: variant.options.map((option) => ({
                    dimension: option.dimensionCode,
                    value: option.valueCode,
                    label: option.valueLabel,
                    hexCode: option.hexCode,
                })),
                totalSupply: variant.totalSupply,
                isActive: variant.isActive,
            })),
        };
    }

    /** An active drop type by code, or 404. */
    private async requireActiveDropType(code: string): Promise<DropTypeRow> {
        if (!this.deps.dropTypes) {
            throw AppError.badRequest(
                'This deployment has no drop types configured; create the drop without `dropType`.',
                PRODUCTS_ERROR_CODES.DROP_TYPE_NOT_FOUND,
            );
        }
        const type = await this.deps.dropTypes.findByCode(code);
        if (!type || !type.isActive) {
            throw AppError.notFound(
                `Drop type ${code} not found. GET /admin/drop-types lists the available types.`,
                PRODUCTS_ERROR_CODES.DROP_TYPE_NOT_FOUND,
            );
        }
        return type;
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
 * One price point as the API returns it.
 *
 * `currency` comes from the joined market, never from the price row — the row
 * has no currency column, precisely so a price cannot disagree with the
 * market it is quoted in. `amount` is a decimal string for the same reason
 * money always is here: a float would round it.
 */
function toPriceResponse(row: ProductPriceRow): ProductPriceResponse {
    return {
        priceId: row.id,
        marketId: row.marketId,
        marketCode: row.market.code,
        marketName: row.market.name,
        currency: row.market.currency,
        // `toFixed(2)`, not `toString()`: Decimal normalises away trailing
        // zeros, so a 1999.00 price would come back as "1999". Every other
        // money field on the platform is 2dp (see dashboard/domain/money.ts)
        // and a pricing table that renders "1999" next to "24.99" looks broken.
        amount: row.isFree ? '0.00' : (row.amount?.toFixed(2) ?? null),
        isFree: row.isFree,
        costOfGoods: row.costOfGoods?.toFixed(2) ?? null,
        status: row.status,
        variantId: row.variantId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
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

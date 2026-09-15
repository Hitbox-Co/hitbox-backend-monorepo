import type { Logger } from 'pino';
import { ClaimedStatus, Prisma, TagLifecycleState } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    SKU_EVENTS,
    SKU_MINT_MAX_ATTEMPTS,
    SKUS_ERROR_CODES,
} from '../constants/skus.constant';
import { Visibility, maskEmail, maskId, maskTag } from '../domain/sku-access';
import type { SkuAccess } from '../domain/sku-access';
import type {
    BindTagDto,
    BulkBindResult,
    BulkBindTagsDto,
    ListSkusQuery,
    MintResult,
    MintSkusDto,
    SkuDetail,
    SkuListItem,
    SkuSummary,
} from '../dto/sku.dto';
import type {
    MintOutcome,
    MintTargetProduct,
    SkuDetailRow,
    SkuRepository,
    SkuRow,
    TagBindTarget,
} from '../repository/sku.repository';

/**
 * Tag states that mean "the physical tag is gone or untrustworthy", and so
 * make re-tagging a claimed unit legitimate rather than destructive.
 */
const REPLACEABLE_TAG_STATES: TagLifecycleState[] = [
    TagLifecycleState.LOST,
    TagLifecycleState.REVOKED,
    TagLifecycleState.DISPUTED,
];

interface SkuServiceDeps {
    skus: SkuRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/** What the products module passes when it mints an edition with a new drop. */
export interface InlineMintSpec {
    productId: string;
    groupCode: string;
    totalSupply: number;
    count: number;
    variantId?: string | null | undefined;
}

export class SkuService {
    constructor(private readonly deps: SkuServiceDeps) { }

    // ── Mint ────────────────────────────────────────────────────────────────

    /**
     * Mints units for an existing drop.
     *
     * Retries the whole transaction on a serial collision: two operators
     * minting the tail of the same edition at once is ordinary, and the loser
     * should get the next block rather than an error.
     */
    async mint(
        access: SkuAccess,
        productId: string,
        dto: MintSkusDto,
    ): Promise<MintResult> {
        const product = await this.requireProduct(access, productId);

        // Binding a physical tag is a different capability from minting the
        // unit it goes on. A Drop Manager can mint any edition on the platform
        // and still cannot write a tag UID — which is the point of keeping
        // `nfc-tag-claim` a separate resource.
        if (dto.tagIds && !access.canManageTags) {
            throw AppError.forbidden(
                'Binding NFC tags requires the nfc-tag-claim:manage capability. ' +
                'Mint the units without `tagIds` and have tag custody bind them.',
                SKUS_ERROR_CODES.FORBIDDEN,
            );
        }

        if (dto.variantId && !(await this.deps.skus.variantBelongsTo(dto.variantId, productId))) {
            throw AppError.badRequest(
                'variantId does not belong to this product',
                SKUS_ERROR_CODES.VARIANT_MISMATCH,
            );
        }

        // Pre-checked only for a usable error message — the unique index on
        // `Sku.tagId` is the authority, and a tag bound between this read and
        // the insert still fails, as it must.
        if (dto.tagIds) {
            const bound = await this.deps.skus.findBoundTags(dto.tagIds);
            if (bound.length > 0) {
                throw AppError.conflict(
                    `Already bound to another unit: ${bound
                        .map((row) => `${row.tagId} → ${row.skuCode}`)
                        .join(', ')}`,
                    SKUS_ERROR_CODES.TAG_TAKEN,
                );
            }
        }

        for (let attempt = 1; attempt <= SKU_MINT_MAX_ATTEMPTS; attempt += 1) {
            try {
                const outcome = await this.deps.skus.runInTransaction((tx) =>
                    this.mintWithin(tx, {
                        productId,
                        groupCode: product.groupCode,
                        totalSupply: product.totalSupply,
                        count: dto.count,
                        variantId: dto.variantId ?? null,
                        tagIds: dto.tagIds,
                        vendorId: dto.vendorId ?? null,
                        provisioningBatchId: dto.provisioningBatchId ?? null,
                        isActive: dto.isActive,
                    }),
                );

                await this.deps.eventBus.publish(SKU_EVENTS.SKUS_MINTED, {
                    productId,
                    minted: outcome.minted,
                    firstSerial: outcome.firstSerial,
                    lastSerial: outcome.lastSerial,
                });

                return { productId, ...outcome };
            } catch (error) {
                if (isUniqueViolation(error, 'tagId')) {
                    throw AppError.conflict(
                        'One of these NFC tags was bound to another unit while this request was in flight.',
                        SKUS_ERROR_CODES.TAG_TAKEN,
                    );
                }
                if (isUniqueViolation(error, 'serialNumber') && attempt < SKU_MINT_MAX_ATTEMPTS) {
                    this.deps.logger.warn(
                        { productId, attempt },
                        'serial range taken by a concurrent mint — retrying',
                    );
                    continue;
                }
                if (isUniqueViolation(error, 'serialNumber')) {
                    throw AppError.conflict(
                        'Could not allocate a serial range; another mint is in progress.',
                        SKUS_ERROR_CODES.SERIAL_TAKEN,
                    );
                }
                throw error;
            }
        }

        /* c8 ignore next */
        throw AppError.conflict('Mint failed', SKUS_ERROR_CODES.SERIAL_TAKEN);
    }

    /**
     * The transactional core, also reachable through the module's
     * `ISkuMinting` port so the products module can create a drop and its
     * edition in one atomic request.
     *
     * The supply cap is read and enforced **inside** the transaction. Checked
     * outside it, two callers each see 400 of 500 minted and each mint 100,
     * and the edition quietly becomes 600 — in a table whose entire purpose is
     * to say how many of a thing exist.
     */
    async mintWithin(
        tx: Prisma.TransactionClient,
        spec: InlineMintSpec & {
            tagIds?: string[] | undefined;
            vendorId?: string | null | undefined;
            provisioningBatchId?: string | null | undefined;
            isActive?: boolean | undefined;
        },
    ): Promise<MintOutcome> {
        const existing = await this.deps.skus.countForProduct(tx, spec.productId);

        // `totalSupply: 0` means "not declared yet", not "an edition of none" —
        // a drop is often created before its size is fixed.
        if (spec.totalSupply > 0 && existing + spec.count > spec.totalSupply) {
            throw AppError.conflict(
                `Minting ${spec.count} would take this drop to ${existing + spec.count} units, ` +
                `past its declared supply of ${spec.totalSupply}. ` +
                `${Math.max(0, spec.totalSupply - existing)} remaining.`,
                SKUS_ERROR_CODES.SUPPLY_EXCEEDED,
            );
        }

        return this.deps.skus.mintWithin(tx, {
            productId: spec.productId,
            groupCode: spec.groupCode,
            count: spec.count,
            variantId: spec.variantId ?? null,
            tagIds: spec.tagIds,
            vendorId: spec.vendorId ?? null,
            provisioningBatchId: spec.provisioningBatchId ?? null,
            isActive: spec.isActive,
        });
    }

    // ── Tag binding ─────────────────────────────────────────────────────────

    /**
     * Binds a whole vendor manifest to an already-minted edition.
     *
     * This is the answer to "I minted 500 units — how do 500 different tag
     * UIDs get in?". They arrive as a manifest from the tag vendor, keyed by
     * serial number, and are applied in batches against units that already
     * exist. Requiring all 500 UIDs at mint time would mean knowing them
     * before a single unit existed.
     */
    async bulkBindTags(
        access: SkuAccess,
        productId: string,
        dto: BulkBindTagsDto,
    ): Promise<BulkBindResult> {
        this.requireTagCustody(access);
        await this.requireProduct(access, productId);

        const serialNumbers = dto.bindings
            .map((binding) => binding.serialNumber)
            .filter((value): value is number => value !== undefined);
        const skuCodes = dto.bindings
            .map((binding) => binding.skuCode)
            .filter((value): value is string => value !== undefined);

        const targets = await this.deps.skus.findForBinding(productId, serialNumbers, skuCodes);
        const bySerial = new Map(targets.map((target) => [target.serialNumber, target]));
        const byCode = new Map(targets.map((target) => [target.skuCode, target]));

        // Every failure is collected before anything is written. A manifest is
        // applied by a person with a box of tags in front of them; telling them
        // about one bad row at a time is 40 round trips.
        const problems: string[] = [];
        const resolved: {
            target: TagBindTarget;
            tagId: string;
            replaced: boolean;
        }[] = [];

        for (const binding of dto.bindings) {
            const label = binding.skuCode ?? `#${binding.serialNumber}`;
            const target =
                binding.skuCode !== undefined
                    ? byCode.get(binding.skuCode)
                    : bySerial.get(binding.serialNumber!);

            if (!target) {
                problems.push(`${label}: not a unit of this drop`);
                continue;
            }
            const check = this.tagReplaceProblem(target, binding.tagId, dto.replace);
            if (check) {
                problems.push(`${label}: ${check}`);
                continue;
            }
            resolved.push({ target, tagId: binding.tagId, replaced: target.tagId !== null });
        }

        if (problems.length > 0) {
            throw AppError.conflict(
                `Manifest rejected: ${problems.join('; ')}`,
                SKUS_ERROR_CODES.UNIT_NOT_IN_PRODUCT,
            );
        }

        await this.assertTagsFree(
            dto.bindings.map((binding) => binding.tagId),
            new Set(resolved.map((entry) => entry.target.skuCode)),
        );

        try {
            await this.deps.skus.bindTags(
                resolved.map((entry) => ({
                    skuId: entry.target.id,
                    tagId: entry.tagId,
                    vendorId: dto.vendorId ?? null,
                    provisioningBatchId: dto.provisioningBatchId ?? null,
                })),
            );
        } catch (error) {
            throw this.asTagConflict(error);
        }

        return {
            productId,
            bound: resolved.length,
            items: resolved.map((entry) => ({
                skuCode: entry.target.skuCode,
                serialNumber: entry.target.serialNumber,
                tagId: entry.tagId,
                replaced: entry.replaced,
            })),
        };
    }

    /** Binds one tag to one unit. */
    async bindTag(access: SkuAccess, skuId: string, dto: BindTagDto): Promise<SkuDetail> {
        this.requireTagCustody(access);

        // Confirms the unit exists AND that the caller's scope reaches the
        // drop it belongs to, before anything is written.
        this.requireReachable(await this.deps.skus.findDetail(skuId), access);

        const target = await this.deps.skus.findByIdForBinding(skuId);
        if (!target) {
            throw AppError.notFound('Unit not found', SKUS_ERROR_CODES.NOT_FOUND);
        }

        const problem = this.tagReplaceProblem(target, dto.tagId, dto.replace);
        if (problem) {
            throw AppError.conflict(
                `${target.skuCode}: ${problem}`,
                target.tagId
                    ? SKUS_ERROR_CODES.TAG_ALREADY_BOUND
                    : SKUS_ERROR_CODES.TAG_REPLACE_REFUSED,
            );
        }

        await this.assertTagsFree([dto.tagId], new Set([target.skuCode]));

        try {
            await this.deps.skus.bindTags([
                {
                    skuId,
                    tagId: dto.tagId,
                    vendorId: dto.vendorId ?? null,
                    provisioningBatchId: dto.provisioningBatchId ?? null,
                },
            ]);
        } catch (error) {
            throw this.asTagConflict(error);
        }

        return this.getDetail(access, skuId);
    }

    private requireTagCustody(access: SkuAccess): void {
        if (!access.canManageTags) {
            throw AppError.forbidden(
                'Binding NFC tags requires the nfc-tag-claim:manage capability.',
                SKUS_ERROR_CODES.FORBIDDEN,
            );
        }
    }

    /**
     * Why this binding cannot proceed, or null.
     *
     * Re-tagging a CLAIMED unit is refused unless its current tag is already
     * recorded as LOST / REVOKED / DISPUTED. The owner's app and the unit's
     * hash chain are keyed to the tag it was claimed with; swapping it under a
     * live owner silently breaks verification for the person holding the item.
     * Mark the old tag lost first — that is what those states are for.
     */
    private tagReplaceProblem(
        target: TagBindTarget,
        tagId: string,
        replace: boolean,
    ): string | null {
        if (target.tagId === tagId) return null; // idempotent re-send
        if (target.tagId === null) return null;
        if (!replace) {
            return `already bound to ${target.tagId}; send replace: true to overwrite`;
        }
        if (
            target.claimedStatus === ClaimedStatus.CLAIMED &&
            !REPLACEABLE_TAG_STATES.includes(target.tagLifecycleState)
        ) {
            return (
                `is claimed and its tag is ${target.tagLifecycleState}; ` +
                'mark the tag LOST, REVOKED or DISPUTED before re-tagging'
            );
        }
        return null;
    }

    /** Refuses tags already bound elsewhere, naming every conflict at once. */
    private async assertTagsFree(tagIds: string[], ownCodes: Set<string>): Promise<void> {
        const bound = await this.deps.skus.findBoundTags(tagIds);
        const conflicts = bound.filter((row) => !ownCodes.has(row.skuCode));
        if (conflicts.length > 0) {
            throw AppError.conflict(
                `Already bound to another unit: ${conflicts
                    .map((row) => `${row.tagId} → ${row.skuCode}`)
                    .join(', ')}`,
                SKUS_ERROR_CODES.TAG_TAKEN,
            );
        }
    }

    /** The unique index is the authority; this turns its error into a usable one. */
    private asTagConflict(error: unknown): unknown {
        if (isUniqueViolation(error, 'tagId')) {
            return AppError.conflict(
                'One of these NFC tags was bound to another unit while this request was in flight.',
                SKUS_ERROR_CODES.TAG_TAKEN,
            );
        }
        return error;
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    async listForProduct(
        access: SkuAccess,
        productId: string,
        query: ListSkusQuery,
    ): Promise<{ data: SkuListItem[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
        await this.requireProduct(access, productId);
        return this.list(access, productId, query);
    }

    async list(
        access: SkuAccess,
        productId: string | undefined,
        query: ListSkusQuery,
    ): Promise<{ data: SkuListItem[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
        const { total, items } = await this.deps.skus.list({
            productId,
            organizationIds: access.organizationIds,
            query,
        });
        return {
            data: items.map((row) => this.toListItem(row, access)),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        };
    }

    async getDetail(access: SkuAccess, skuId: string): Promise<SkuDetail> {
        const row = await this.deps.skus.findDetail(skuId);
        return this.toDetail(this.requireReachable(row, access), access);
    }

    async getDetailByCode(access: SkuAccess, skuCode: string): Promise<SkuDetail> {
        const row = await this.deps.skus.findDetailByCode(skuCode);
        return this.toDetail(this.requireReachable(row, access), access);
    }

    async summary(access: SkuAccess, productId: string): Promise<SkuSummary> {
        const product = await this.requireProduct(access, productId);
        const counts = await this.deps.skus.summary(productId);

        const summary: SkuSummary = {
            productId,
            total: counts.total,
            byClaimedStatus: counts.byClaimedStatus,
            remainingSupply:
                product.totalSupply > 0 ? Math.max(0, product.totalSupply - counts.total) : null,
        };
        if (access.tag) {
            summary.byTagLifecycleState = counts.byTagLifecycleState;
            summary.tagged = counts.tagged;
            summary.untagged = counts.total - counts.tagged;
        }
        return summary;
    }

    // ── Access ──────────────────────────────────────────────────────────────

    /**
     * Loads the drop and confirms the caller reaches it.
     *
     * The route guard already checked the capability against the product's
     * organization; this repeats the containment check against the row that
     * was actually loaded, which is the half the middleware cannot do.
     */
    private async requireProduct(
        access: SkuAccess,
        productId: string,
    ): Promise<MintTargetProduct> {
        const product = await this.deps.skus.findProduct(productId);
        if (!product || !reaches(access, product.organizationId)) {
            // 404 rather than 403 for an out-of-scope drop: a 403 confirms the
            // id exists, which is itself a fact about another brand's catalog.
            throw AppError.notFound('Product not found', SKUS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return product;
    }

    private requireReachable(row: SkuDetailRow | null, access: SkuAccess): SkuDetailRow {
        if (!row || !reaches(access, row.product.organizationId)) {
            throw AppError.notFound('Unit not found', SKUS_ERROR_CODES.NOT_FOUND);
        }
        return row;
    }

    // ── Projection ──────────────────────────────────────────────────────────

    /**
     * Every block below is added only when the caller holds the resource that
     * governs it. Nothing is emitted as an explicit null placeholder: an absent
     * key means "not shown to you", and a null value means "we looked and there
     * is nothing there".
     */
    private toListItem(row: SkuRow, access: SkuAccess): SkuListItem {
        const item: SkuListItem = {
            skuId: row.id,
            skuCode: row.skuCode,
            serialNumber: row.serialNumber,
            claimedStatus: row.claimedStatus,
            variantId: row.variantId,
            isActive: row.isActive,
            archivedAt: row.archivedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        };

        // Trust flags say *why* an item is frozen. Support sees the unit at
        // MASKED visibility and does not get the investigation notes.
        if (access.instance.visibility === Visibility.FULL) {
            item.trust = {
                resaleBlocked: row.resaleBlocked,
                resaleBlockedReason: row.resaleBlockedReason,
                tamperStatus: row.tamperStatus,
            };
        }

        if (access.tag) {
            const full = access.tag.visibility === Visibility.FULL;
            item.tag = {
                tagId: row.tagId === null ? null : full ? row.tagId : maskTag(row.tagId),
                tagLifecycleState: row.tagLifecycleState,
                ...(full ? { lastTapCounter: row.lastTapCounter } : {}),
            };
        }

        if (access.buyer) {
            const visibility = access.buyer.visibility;
            const full = visibility === Visibility.FULL;
            item.owner = {
                ownerId:
                    row.ownerId === null ? null : full ? row.ownerId : maskId(row.ownerId),
                email: row.owner ? maskEmail(row.owner.email, visibility) : null,
                handle: full ? (row.owner?.handle ?? null) : null,
            };
        }

        return item;
    }

    private toDetail(row: SkuDetailRow, access: SkuAccess): SkuDetail {
        const detail: SkuDetail = {
            ...this.toListItem(row, access),
            product: {
                productId: row.product.id,
                groupCode: row.product.groupCode,
                name: row.product.name,
                organizationId: row.product.organizationId,
                status: row.product.status,
                totalSupply: row.product.totalSupply,
            },
        };

        if (access.tag) {
            const history = row.productHistorys[0];
            detail.provenance = {
                claimCount: row._count.productClaims,
                ledgerEntries: row._count.blockchainLedgers,
                firstClaimedAt: row.productClaims[0]?.claimedAt.toISOString() ?? null,
                currentHolderSince: history?.startedAt.toISOString() ?? null,
            };
            // What the current holder paid is a monetary figure like any
            // other: `nfc-tag-claim` opens the provenance block, it does not
            // imply financial visibility.
            if (access.canSeeMoney && history) {
                detail.provenance.currentHolderPaid = {
                    amount: history.price?.toString() ?? null,
                    currency: history.currency ?? null,
                };
            }
        }

        if (access.order) {
            const order = row.orders[0];
            const reservation = row.inventoryReservations[0];
            detail.commerce = {
                allocatedOrderId: order?.id ?? null,
                allocatedOrderStatus: order?.status ?? null,
                reservationStatus: reservation?.status ?? null,
            };
            if (access.canSeeMoney && order) {
                detail.commerce.amount = order.amount.toString();
                detail.commerce.currency = order.currency;
            }
        }

        return detail;
    }
}

/** Does the caller's scope reach a record owned by this organization? */
function reaches(access: SkuAccess, organizationId: string | null): boolean {
    if (access.organizationIds === null) return true;
    return organizationId !== null && access.organizationIds.includes(organizationId);
}

function isUniqueViolation(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        return false;
    }
    // meta.target carries Prisma field names or @map'd column names.
    const snake = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    const target = error.meta?.target;
    const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    return names.some((name) => name.includes(field) || name.includes(snake));
}

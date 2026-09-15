import { randomUUID } from 'node:crypto';
import { ClaimedStatus, Prisma, TagLifecycleState } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { SKU_SERIAL_PAD } from '../constants/skus.constant';
import type { ListSkusQuery } from '../dto/sku.dto';

/**
 * The only place in this module that touches Prisma.
 *
 * Two invariants live here rather than in the service, because only a
 * transaction can hold them:
 *
 *   - **Serial allocation.** `@@unique([productId, serialNumber])` means two
 *     concurrent mints racing for "#501 onwards" cannot both win. The loser
 *     gets P2002 and the service retries with a freshly read high-water mark,
 *     rather than a pre-check that is stale the moment it returns.
 *   - **Supply cap.** The count and the insert are read and written inside the
 *     same transaction, so two callers cannot each see 400/500 minted and each
 *     mint 100.
 */

/** Everything the mint path needs to know about the target drop. */
const productSelect = {
    id: true,
    groupCode: true,
    name: true,
    organizationId: true,
    status: true,
    totalSupply: true,
} satisfies Prisma.ProductSelect;

export type MintTargetProduct = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

/**
 * One unit as the repository reads it.
 *
 * Every sensitive column is selected here and dropped later by the service,
 * not selected conditionally — one query shape keeps the SQL predictable, and
 * the redaction lives in exactly one place instead of being split between a
 * `select` and a mapper that could disagree.
 *
 * `claimToken` is the exception: it is never selected, by anyone. A live
 * one-shot claim token in a response body is a claim someone else can make.
 */
const skuSelect = {
    id: true,
    skuCode: true,
    serialNumber: true,
    productId: true,
    variantId: true,
    claimedStatus: true,
    ownerId: true,
    tagId: true,
    tagLifecycleState: true,
    provisioningBatchId: true,
    vendorId: true,
    vendorAuthenticatedAt: true,
    claimTokenIssuedAt: true,
    claimTokenUsedAt: true,
    resaleBlocked: true,
    resaleBlockedReason: true,
    tamperStatus: true,
    lastTapCounter: true,
    isActive: true,
    archivedAt: true,
    createdAt: true,
    owner: { select: { id: true, email: true, handle: true, fullName: true } },
} satisfies Prisma.SkuSelect;

export type SkuRow = Prisma.SkuGetPayload<{ select: typeof skuSelect }>;

const detailSelect = {
    ...skuSelect,
    product: { select: productSelect },
    vendor: { select: { id: true, name: true } },
    _count: { select: { productClaims: true, blockchainLedgers: true } },
    productClaims: {
        orderBy: { claimedNo: 'asc' },
        take: 1,
        select: { claimedAt: true },
    },
    productHistorys: {
        where: { isCurrent: true },
        take: 1,
        select: { startedAt: true, price: true, currency: true, acquiredVia: true },
    },
    orders: {
        where: { archivedAt: null },
        orderBy: { placedAt: 'desc' },
        take: 1,
        select: { id: true, status: true, amount: true, currency: true },
    },
    inventoryReservations: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true, expiresAt: true },
    },
} satisfies Prisma.SkuSelect;

export type SkuDetailRow = Prisma.SkuGetPayload<{ select: typeof detailSelect }>;

/** The subset of a unit the tag-binding rules need to decide. */
export interface TagBindTarget {
    id: string;
    skuCode: string;
    serialNumber: number;
    tagId: string | null;
    tagLifecycleState: TagLifecycleState;
    claimedStatus: ClaimedStatus;
}

export interface MintSpec {
    productId: string;
    groupCode: string;
    count: number;
    variantId?: string | null | undefined;
    tagIds?: string[] | undefined;
    vendorId?: string | null | undefined;
    provisioningBatchId?: string | null | undefined;
    isActive?: boolean | undefined;
}

export interface MintOutcome {
    minted: number;
    firstSerial: number;
    lastSerial: number;
    skuCodes: string[];
    tagsBound: number;
}

export class SkuRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findProduct(productId: string): Promise<MintTargetProduct | null> {
        return this.prisma.product.findUnique({
            where: { id: productId },
            select: productSelect,
        });
    }

    /** The product's organization, for the route's access context. */
    async findProductOrganization(productId: string): Promise<string | null | undefined> {
        const product = await this.prisma.product.findUnique({
            where: { id: productId },
            select: { organizationId: true },
        });
        return product?.organizationId;
    }

    /** The organization owning the product this unit belongs to. */
    async findSkuOrganization(skuId: string): Promise<string | null | undefined> {
        const sku = await this.prisma.sku.findUnique({
            where: { id: skuId },
            select: { product: { select: { organizationId: true } } },
        });
        return sku?.product.organizationId;
    }

    /** Which of these tag UIDs are already bound, and to what. */
    findBoundTags(tagIds: string[]): Promise<{ tagId: string | null; skuCode: string }[]> {
        return this.prisma.sku.findMany({
            where: { tagId: { in: tagIds } },
            select: { tagId: true, skuCode: true },
        });
    }

    /** Does this variant belong to this product? */
    async variantBelongsTo(variantId: string, productId: string): Promise<boolean> {
        const variant = await this.prisma.productVariant.findUnique({
            where: { id: variantId },
            select: { productId: true },
        });
        return variant?.productId === productId;
    }

    /**
     * Runs `work` in a transaction.
     *
     * The service owns the mint rules (supply cap, tag custody) and the
     * repository owns the transaction — so the read that enforces the cap and
     * the insert it guards run under the same snapshot without the rules
     * leaking down here.
     */
    runInTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        return this.prisma.$transaction(work);
    }

    /**
     * Mints inside a caller-supplied transaction.
     *
     * This is what makes "create a drop and its edition in one request"
     * atomic: the products module opens the transaction, creates the Product,
     * and calls this with the same `tx`. A failure anywhere rolls the drop back
     * too, so there is no window in which a product exists with a half-minted
     * edition and no record of which half.
     */
    async mintWithin(tx: Prisma.TransactionClient, spec: MintSpec): Promise<MintOutcome> {
        const now = new Date();

        // Read inside the transaction: a count taken outside it is a guess.
        const highest = await tx.sku.findFirst({
            where: { productId: spec.productId },
            orderBy: { serialNumber: 'desc' },
            select: { serialNumber: true },
        });
        const firstSerial = (highest?.serialNumber ?? 0) + 1;

        const tagIds = spec.tagIds ?? [];
        const rows = Array.from({ length: spec.count }, (_, index) => {
            const serialNumber = firstSerial + index;
            const tag = tagIds[index] ?? null;
            return {
                id: randomUUID(),
                skuCode: formatSkuCode(spec.groupCode, serialNumber),
                productId: spec.productId,
                variantId: spec.variantId ?? null,
                serialNumber,
                ownerId: null,
                claimedStatus: ClaimedStatus.UNCLAIMED,
                tagId: tag,
                provisioningBatchId: spec.provisioningBatchId ?? null,
                // A unit with a tag written to it is BOUND; one waiting for a
                // tag is UNPROVISIONED. ACTIVE is reached on first claim, by
                // the claims module — never here.
                tagLifecycleState: tag
                    ? TagLifecycleState.BOUND
                    : TagLifecycleState.UNPROVISIONED,
                vendorId: spec.vendorId ?? null,
                vendorAuthenticatedAt: null,
                resaleBlocked: false,
                lastTapCounter: 0,
                isActive: spec.isActive ?? true,
                createdAt: now,
                updatedAt: now,
            };
        });

        await tx.sku.createMany({ data: rows });

        return {
            minted: rows.length,
            firstSerial,
            lastSerial: firstSerial + rows.length - 1,
            skuCodes: rows.map((row) => row.skuCode),
            tagsBound: tagIds.length,
        };
    }

    // ── Tag binding ─────────────────────────────────────────────────────

    /**
     * Resolves manifest rows to units, by serial number or by code.
     *
     * One query for the whole manifest rather than one per row — a 500-line
     * vendor file should cost one round trip, and every unresolvable row has
     * to be reported together rather than failing on the first.
     */
    findForBinding(
        productId: string,
        serialNumbers: number[],
        skuCodes: string[],
    ): Promise<TagBindTarget[]> {
        const or: Prisma.SkuWhereInput[] = [];
        if (serialNumbers.length > 0) or.push({ serialNumber: { in: serialNumbers } });
        if (skuCodes.length > 0) or.push({ skuCode: { in: skuCodes } });
        if (or.length === 0) return Promise.resolve([]);

        return this.prisma.sku.findMany({
            where: { productId, OR: or },
            select: {
                id: true,
                skuCode: true,
                serialNumber: true,
                tagId: true,
                tagLifecycleState: true,
                claimedStatus: true,
            },
        });
    }

    findByIdForBinding(skuId: string): Promise<TagBindTarget | null> {
        return this.prisma.sku.findUnique({
            where: { id: skuId },
            select: {
                id: true,
                skuCode: true,
                serialNumber: true,
                tagId: true,
                tagLifecycleState: true,
                claimedStatus: true,
            },
        });
    }

    /**
     * Applies a whole manifest in one transaction.
     *
     * All-or-nothing on purpose: a partially applied manifest leaves a box of
     * physical tags in an unknown state, and working out which of 500 items
     * got written is a warehouse problem, not a database one.
     */
    bindTags(
        bindings: {
            skuId: string;
            tagId: string;
            vendorId?: string | null | undefined;
            provisioningBatchId?: string | null | undefined;
        }[],
    ): Promise<void> {
        const now = new Date();
        return this.prisma.$transaction(async (tx) => {
            for (const binding of bindings) {
                await tx.sku.update({
                    where: { id: binding.skuId },
                    data: {
                        tagId: binding.tagId,
                        // A unit with a tag written to it is BOUND. ACTIVE is
                        // reached on first claim, by the claims module.
                        tagLifecycleState: TagLifecycleState.BOUND,
                        ...(binding.vendorId !== undefined && binding.vendorId !== null
                            ? { vendorId: binding.vendorId }
                            : {}),
                        ...(binding.provisioningBatchId !== undefined &&
                            binding.provisioningBatchId !== null
                            ? { provisioningBatchId: binding.provisioningBatchId }
                            : {}),
                        updatedAt: now,
                    },
                });
            }
        });
    }

    /** Units already minted for a drop, counted inside the caller's transaction. */
    countForProduct(tx: Prisma.TransactionClient | PrismaClient, productId: string): Promise<number> {
        return tx.sku.count({ where: { productId } });
    }

    async list(input: {
        productId?: string | undefined;
        organizationIds: string[] | null;
        query: ListSkusQuery;
    }): Promise<{ total: number; items: SkuRow[] }> {
        const { query } = input;
        const where: Prisma.SkuWhereInput = {
            ...(input.productId ? { productId: input.productId } : {}),
            // Organization isolation is applied to the query, not to the
            // result: a caller confined to one brand must not be able to page
            // through another brand's edition and infer its size from the
            // total, which is exactly what post-filtering would leak.
            ...(input.organizationIds
                ? { product: { organizationId: { in: input.organizationIds } } }
                : {}),
            ...(query.includeArchived ? {} : { archivedAt: null }),
            ...(query.claimedStatus ? { claimedStatus: query.claimedStatus } : {}),
            ...(query.tagLifecycleState ? { tagLifecycleState: query.tagLifecycleState } : {}),
            ...(query.variantId ? { variantId: query.variantId } : {}),
            ...(query.tagged === undefined ? {} : { tagId: query.tagged ? { not: null } : null }),
            ...(query.resaleBlocked === undefined ? {} : { resaleBlocked: query.resaleBlocked }),
            ...(query.search ? searchWhere(query.search) : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.sku.count({ where }),
            this.prisma.sku.findMany({
                where,
                select: skuSelect,
                orderBy: SKU_SORTS[query.sort],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    findDetail(skuId: string): Promise<SkuDetailRow | null> {
        return this.prisma.sku.findUnique({ where: { id: skuId }, select: detailSelect });
    }

    findDetailByCode(skuCode: string): Promise<SkuDetailRow | null> {
        return this.prisma.sku.findUnique({ where: { skuCode }, select: detailSelect });
    }

    /**
     * Counts by claim state and tag state for one drop, read together so the
     * two breakdowns of the same population cannot disagree on the total.
     */
    async summary(productId: string): Promise<{
        total: number;
        byClaimedStatus: Record<string, number>;
        byTagLifecycleState: Record<string, number>;
        tagged: number;
    }> {
        const [total, byClaimed, byTag, tagged] = await Promise.all([
            this.prisma.sku.count({ where: { productId } }),
            this.prisma.sku.groupBy({
                by: ['claimedStatus'],
                where: { productId },
                _count: { _all: true },
            }),
            this.prisma.sku.groupBy({
                by: ['tagLifecycleState'],
                where: { productId },
                _count: { _all: true },
            }),
            this.prisma.sku.count({ where: { productId, tagId: { not: null } } }),
        ]);

        const byClaimedStatus: Record<string, number> = {};
        for (const row of byClaimed) byClaimedStatus[row.claimedStatus] = row._count._all;
        const byTagLifecycleState: Record<string, number> = {};
        for (const row of byTag) byTagLifecycleState[row.tagLifecycleState] = row._count._all;

        return { total, byClaimedStatus, byTagLifecycleState, tagged };
    }
}

const SKU_SORTS = {
    serial_asc: { serialNumber: 'asc' },
    serial_desc: { serialNumber: 'desc' },
    newest: { createdAt: 'desc' },
} satisfies Record<string, Prisma.SkuOrderByWithRelationInput>;

/** `123456780000-000014` — the drop's group code plus the padded serial. */
export function formatSkuCode(groupCode: string, serialNumber: number): string {
    return `${groupCode}-${String(serialNumber).padStart(SKU_SERIAL_PAD, '0')}`;
}

/**
 * One search box over three identifiers.
 *
 * A digits-only term is treated as a serial number as well as a code fragment,
 * because an operator holding the physical item reads "#14" off the card, not
 * `123456780000-000014`.
 */
function searchWhere(search: string): Prisma.SkuWhereInput {
    const serial = /^\d+$/.test(search) ? Number(search) : null;
    const normalisedTag = search.replace(/[:\- ]/g, '').toUpperCase();
    return {
        OR: [
            { skuCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
            { tagId: normalisedTag },
            ...(serial !== null && Number.isSafeInteger(serial) ? [{ serialNumber: serial }] : []),
        ],
    };
}

import { randomUUID } from 'node:crypto';
import { ClaimedStatus, Prisma, TagLifecycleState } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import { SKU_SERIAL_PAD } from '../constants/skus.constant';
import type { BatchTargetsDto, ListSkusQuery } from '../dto/sku.dto';

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
const dropSelect = {
    id: true,
    groupCode: true,
    name: true,
    organizationId: true,
    status: true,
    totalSupply: true,
} satisfies Prisma.DropSelect;

export type MintTargetProduct = Prisma.DropGetPayload<{ select: typeof dropSelect }>;

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
    updatedAt: true,
    owner: { select: { id: true, email: true, handle: true, fullName: true } },
} satisfies Prisma.SkuSelect;

export type SkuRow = Prisma.SkuGetPayload<{ select: typeof skuSelect }>;

const detailSelect = {
    ...skuSelect,
    drop: { select: dropSelect },
    vendor: { select: { id: true, name: true } },
    _count: { select: { skuClaims: true, blockchainLedgers: true } },
    skuClaims: {
        orderBy: { claimedNo: 'asc' },
        take: 1,
        select: { claimedAt: true },
    },
    skuHistories: {
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

/**
 * The columns the update rules read, plus the owning organization.
 *
 * Narrower than `skuSelect` on purpose: an update decides from the unit's own
 * state, and loading the owner relation and the four `take: 1` sub-queries of
 * `detailSelect` for every unit in a 1000-row batch would be most of the cost
 * of the request for none of the answer.
 */
const updateSelect = {
    id: true,
    skuCode: true,
    serialNumber: true,
    productId: true,
    variantId: true,
    claimedStatus: true,
    ownerId: true,
    tagId: true,
    tagLifecycleState: true,
    vendorId: true,
    provisioningBatchId: true,
    vendorAuthenticatedAt: true,
    resaleBlocked: true,
    resaleBlockedReason: true,
    tamperStatus: true,
    isActive: true,
    archivedAt: true,
    drop: { select: { id: true, organizationId: true } },
} satisfies Prisma.SkuSelect;

export type SkuUpdateRow = Prisma.SkuGetPayload<{ select: typeof updateSelect }>;

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
        return this.prisma.drop.findUnique({
            where: { id: productId },
            select: dropSelect,
        });
    }

    /** The product's organization, for the route's access context. */
    async findProductOrganization(productId: string): Promise<string | null | undefined> {
        const product = await this.prisma.drop.findUnique({
            where: { id: productId },
            select: { organizationId: true },
        });
        return product?.organizationId;
    }

    /** The organization owning the product this unit belongs to. */
    async findSkuOrganization(skuId: string): Promise<string | null | undefined> {
        const sku = await this.prisma.sku.findUnique({
            where: { id: skuId },
            select: { drop: { select: { organizationId: true } } },
        });
        return sku?.drop.organizationId;
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
        const variant = await this.prisma.dropVariant.findUnique({
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
        return this.prisma.$transaction(work, {
            // Remote (Neon) round-trips add up; the default 5s is too tight.
            //
            // `work` is a supply-cap read followed by `mintWithin`, which is
            // itself a serial read plus a `createMany` of the whole batch. On a
            // 500-unit manifest that is one large insert behind three round
            // trips, and the default ceiling cuts the transaction off partway
            // with "Transaction already closed" — after the rows were sent.
            //
            // Same figures as @hitbox/claims and the drop-create path in
            // @hitbox/products, which run into this for the same reason.
            maxWait: 10_000,
            timeout: 20_000,
        });
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

    // ── Updating ────────────────────────────────────────────────────────────

    findForUpdate(skuId: string): Promise<SkuUpdateRow | null> {
        return this.prisma.sku.findUnique({ where: { id: skuId }, select: updateSelect });
    }

    /**
     * Resolves a batch selector to rows, in one query.
     *
     * Organization isolation is part of the `where`, not a filter over the
     * result, for the same reason it is on `list`: a caller confined to one
     * brand must not learn that a `skuCode` exists by seeing it counted as
     * "matched" and then refused.
     *
     * Archived units are included deliberately — un-archiving is one of the
     * things a batch edit is for.
     */
    findBatchTargets(input: {
        productId: string | undefined;
        organizationIds: string[] | null;
        targets: BatchTargetsDto;
    }): Promise<SkuUpdateRow[]> {
        const { targets } = input;
        const where: Prisma.SkuWhereInput = {
            ...(input.productId ? { productId: input.productId } : {}),
            ...(input.organizationIds
                ? { drop: { organizationId: { in: input.organizationIds } } }
                : {}),
            ...(targets.skuIds ? { id: { in: targets.skuIds } } : {}),
            ...(targets.skuCodes ? { skuCode: { in: targets.skuCodes } } : {}),
            ...(targets.serialNumbers ? { serialNumber: { in: targets.serialNumbers } } : {}),
            ...(targets.serialFrom !== undefined && targets.serialTo !== undefined
                ? { serialNumber: { gte: targets.serialFrom, lte: targets.serialTo } }
                : {}),
        };
        return this.prisma.sku.findMany({
            where,
            select: updateSelect,
            orderBy: { serialNumber: 'asc' },
        });
    }

    /**
     * Writes a batch, all or nothing.
     *
     * Units sharing a patch are written with one `updateMany`, which is what
     * keeps "block resale on 800 units" to a couple of statements rather than
     * 800 round trips inside a transaction that would time out long before it
     * finished. Patches genuinely differ per unit — unflagging resolves to
     * CLAIMED or UNCLAIMED depending on the row — so they are grouped by
     * content rather than assumed identical.
     */
    applyUpdates(
        updates: { skuId: string; patch: Record<string, unknown> }[],
        now: Date,
    ): Promise<void> {
        const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
        for (const update of updates) {
            const key = JSON.stringify(update.patch);
            const group = groups.get(key);
            if (group) group.ids.push(update.skuId);
            else groups.set(key, { patch: update.patch, ids: [update.skuId] });
        }

        return this.prisma.$transaction(
            async (tx) => {
                for (const group of groups.values()) {
                    await tx.sku.updateMany({
                        where: { id: { in: group.ids } },
                        data: { ...(group.patch as Prisma.SkuUpdateManyMutationInput), updatedAt: now },
                    });
                }
            },
            // Same figures as the mint path: a remote database and a batch of
            // up to 1000 units make the default 5s ceiling too tight.
            { maxWait: 10_000, timeout: 20_000 },
        );
    }

    async list(input: {
        productId?: string | undefined;
        organizationIds: string[] | null;
        query: ListSkusQuery;
        /** False for a caller who may not see tag UIDs — see sku-filters.ts. */
        allowTagSearch: boolean;
    }): Promise<{ total: number; items: SkuRow[] }> {
        const { query } = input;
        const where = buildSkuWhere(input);

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
    oldest: { createdAt: 'asc' },
    /** What an operator wants after a batch edit: "show me what I just did". */
    recently_updated: { updatedAt: 'desc' },
    code_asc: { skuCode: 'asc' },
} satisfies Record<string, Prisma.SkuOrderByWithRelationInput>;

/**
 * The inventory filter, as SQL.
 *
 * Built as an `AND` array rather than one object literal because two different
 * filters narrow `product` — the caller's organization isolation and an
 * explicit `organizationId` — and spreading both into one object would silently
 * drop the first. The AND form cannot lose a clause, which matters when the
 * clause it would lose is the one confining a brand to its own catalog.
 */
function buildSkuWhere(input: {
    productId?: string | undefined;
    organizationIds: string[] | null;
    query: ListSkusQuery;
    allowTagSearch: boolean;
}): Prisma.SkuWhereInput {
    const { query } = input;
    const and: Prisma.SkuWhereInput[] = [];

    if (input.productId) and.push({ productId: input.productId });
    if (query.productId) and.push({ productId: query.productId });

    // Organization isolation is applied to the query, not to the result: a
    // caller confined to one brand must not be able to page through another
    // brand's edition and infer its size from the total, which is exactly what
    // post-filtering would leak.
    if (input.organizationIds) {
        and.push({ drop: { organizationId: { in: input.organizationIds } } });
    }
    if (query.organizationId) {
        and.push({ drop: { organizationId: query.organizationId } });
    }

    // Archival. `archivedOnly` implies including them, so it is checked first.
    if (query.archivedOnly) and.push({ archivedAt: { not: null } });
    else if (!query.includeArchived) and.push({ archivedAt: null });

    if (query.claimedStatus) and.push({ claimedStatus: { in: query.claimedStatus } });
    if (query.tagLifecycleState) {
        and.push({ tagLifecycleState: { in: query.tagLifecycleState } });
    }
    if (query.variantId) and.push({ variantId: query.variantId });
    if (query.hasVariant !== undefined) {
        and.push({ variantId: query.hasVariant ? { not: null } : null });
    }
    if (query.serialFrom !== undefined) and.push({ serialNumber: { gte: query.serialFrom } });
    if (query.serialTo !== undefined) and.push({ serialNumber: { lte: query.serialTo } });
    if (query.skuCode) and.push({ skuCode: { in: query.skuCode } });

    if (query.tagged !== undefined) {
        and.push({ tagId: query.tagged ? { not: null } : null });
    }
    if (query.tagId) and.push({ tagId: query.tagId });
    if (query.vendorId) and.push({ vendorId: query.vendorId });
    if (query.provisioningBatchId) {
        and.push({ provisioningBatchId: query.provisioningBatchId });
    }

    if (query.resaleBlocked !== undefined) and.push({ resaleBlocked: query.resaleBlocked });
    if (query.tampered !== undefined) {
        and.push({ tamperStatus: query.tampered ? { not: null } : null });
    }
    if (query.tamperStatus) and.push({ tamperStatus: query.tamperStatus });

    if (query.ownerId) and.push({ ownerId: query.ownerId });
    if (query.hasOwner !== undefined) {
        and.push({ ownerId: query.hasOwner ? { not: null } : null });
    }

    if (query.isActive !== undefined) and.push({ isActive: query.isActive });
    if (query.createdFrom) and.push({ createdAt: { gte: query.createdFrom } });
    if (query.createdTo) and.push({ createdAt: { lte: query.createdTo } });
    if (query.updatedFrom) and.push({ updatedAt: { gte: query.updatedFrom } });
    if (query.updatedTo) and.push({ updatedAt: { lte: query.updatedTo } });

    if (query.search) and.push(searchWhere(query.search, input.allowTagSearch));

    return and.length === 0 ? {} : { AND: and };
}

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
 *
 * The tag branch is included only for a caller who may read tag UIDs.
 * Otherwise `?search=04A39B2C5D6E80` is `?tagId=04A39B2C5D6E80` spelled
 * differently: one row back confirms which unit carries that tag, which is the
 * fact the response projection goes to some trouble to withhold.
 */
function searchWhere(search: string, allowTagSearch: boolean): Prisma.SkuWhereInput {
    const serial = /^\d+$/.test(search) ? Number(search) : null;
    const normalisedTag = search.replace(/[:\- ]/g, '').toUpperCase();
    return {
        OR: [
            { skuCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ...(allowTagSearch ? [{ tagId: normalisedTag }] : []),
            ...(serial !== null && Number.isSafeInteger(serial) ? [{ serialNumber: serial }] : []),
        ],
    };
}

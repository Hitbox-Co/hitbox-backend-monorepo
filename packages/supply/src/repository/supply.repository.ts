import { randomUUID } from 'node:crypto';
import {
    ClaimedStatus,
    Prisma,
    QcStatus,
    SupplyBatchStatus,
    TagLifecycleState,
} from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type {
    ListBatchesQuery,
    ListTagsQuery,
    ListVendorsQuery,
    SupplyMetricsQuery,
} from '../dto/supply.dto';

// ────────────────────────────────────────────────────────────────────────────
// Selects
//
// Explicit everywhere, and one of them is load-bearing: `tagSelect` names
// every column of NfcTag EXCEPT `tagUidHash`, `tagUidEncrypted` and
// `keyReference`. A `select` that listed them would leak the platform's
// anti-counterfeiting material into whatever a controller happens to serialise,
// so they are excluded here rather than stripped later — there is no code path
// that can forget to strip what was never read.
// ────────────────────────────────────────────────────────────────────────────

const vendorSelect = {
    id: true,
    name: true,
    legalName: true,
    country: true,
    vendorType: true,
    contactName: true,
    contactEmail: true,
    contactPhone: true,
    notes: true,
    isActive: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { supplyBatchs: true, skus: true } },
} satisfies Prisma.VendorSelect;

export type VendorRow = Prisma.VendorGetPayload<{ select: typeof vendorSelect }>;

const batchSelect = {
    id: true,
    vendorId: true,
    vendor: { select: { id: true, name: true, vendorType: true } },
    dropId: true,
    drop: { select: { id: true, groupCode: true, name: true } },
    itemType: true,
    status: true,
    quantity: true,
    batchRef: true,
    vendorInvoiceRef: true,
    receivedAt: true,
    batchDate: true,
    rowsReceived: true,
    rowsAccepted: true,
    rowsRejected: true,
    sourceFileRef: true,
    validationReportRef: true,
    enteredById: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { nfcTags: true } },
} satisfies Prisma.SupplyBatchSelect;

export type BatchRow = Prisma.SupplyBatchGetPayload<{ select: typeof batchSelect }>;

const tagSelect = {
    id: true,
    nfcTagCode: true,
    supplyBatchId: true,
    supplyBatch: {
        select: {
            id: true,
            batchRef: true,
            vendorId: true,
            vendor: { select: { name: true } },
        },
    },
    skuId: true,
    sku: { select: { id: true, skuCode: true, serialNumber: true } },
    qcStatus: true,
    qcReportedAt: true,
    qcNotes: true,
    lifecycleState: true,
    lastTapCounter: true,
    tamperStatus: true,
    personalizedAt: true,
    boundAt: true,
    activatedAt: true,
    retiredAt: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.NfcTagSelect;

export type TagRow = Prisma.NfcTagGetPayload<{ select: typeof tagSelect }>;

/** A manifest row, already hashed and encrypted by the service. */
export interface SealedTag {
    uidHash: string;
    uidEncrypted: string;
    keyReference: string;
    qcStatus: QcStatus;
    qcNotes: string | undefined;
}

/** The only place in this module that touches Prisma. */
export class SupplyRepository {
    constructor(private readonly prisma: PrismaClient) { }

    // ── Vendors ─────────────────────────────────────────────────────────────

    async listVendors(
        query: ListVendorsQuery,
    ): Promise<{ total: number; items: VendorRow[] }> {
        const where: Prisma.VendorWhereInput = {
            ...(query.includeArchived ? {} : { archivedAt: null }),
            ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
            ...(query.vendorType ? { vendorType: query.vendorType } : {}),
            ...(query.country ? { country: query.country } : {}),
            ...(query.search
                ? {
                    OR: [
                        { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                        {
                            legalName: {
                                contains: query.search,
                                mode: Prisma.QueryMode.insensitive,
                            },
                        },
                    ],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.vendor.count({ where }),
            this.prisma.vendor.findMany({
                where,
                select: vendorSelect,
                // Alphabetical: this backs a picker, and a picker is scanned by eye.
                orderBy: { name: 'asc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    findVendorById(id: string): Promise<VendorRow | null> {
        return this.prisma.vendor.findUnique({ where: { id }, select: vendorSelect });
    }

    createVendor(data: {
        name: string;
        legalName?: string | undefined;
        country?: string | undefined;
        vendorType: VendorRow['vendorType'];
        contactName?: string | undefined;
        contactEmail?: string | undefined;
        contactPhone?: string | undefined;
        notes?: string | undefined;
        isActive: boolean;
    }): Promise<VendorRow> {
        return this.prisma.vendor.create({
            // `Vendor.id` carries no Prisma default, so the application supplies
            // it. Same convention as products and markets.
            data: { id: randomUUID(), createdAt: new Date(), ...data },
            select: vendorSelect,
        });
    }

    updateVendor(id: string, data: Prisma.VendorUpdateInput): Promise<VendorRow> {
        return this.prisma.vendor.update({ where: { id }, data, select: vendorSelect });
    }

    // ── Consignments ────────────────────────────────────────────────────────

    /**
     * `organizationIds` confines an org-scoped caller to consignments ordered
     * for one of their own drops.
     *
     * A consignment with no `dropId` is platform stock bought ahead of any
     * drop, and it is therefore invisible to an org-scoped caller — deliberately,
     * since "how much chip stock does HitBox hold" is not a brand's business.
     */
    async listBatches(
        query: ListBatchesQuery,
        organizationIds: string[] | null,
    ): Promise<{ total: number; items: BatchRow[] }> {
        const where = this.batchWhere(query, organizationIds);

        const [total, items] = await Promise.all([
            this.prisma.supplyBatch.count({ where }),
            this.prisma.supplyBatch.findMany({
                where,
                select: batchSelect,
                orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    /**
     * One consignment, already confined to the caller's reach.
     *
     * The scope filter is part of the lookup rather than a check afterwards, so
     * an out-of-scope id and a non-existent id are indistinguishable — both
     * return null and both become the same 404. A different status code for
     * each would let a brand enumerate another brand's consignments.
     */
    findBatchById(id: string, organizationIds: string[] | null): Promise<BatchRow | null> {
        return this.prisma.supplyBatch.findFirst({
            where: { id, ...this.organizationFilter(organizationIds) },
            select: batchSelect,
        });
    }

    createBatch(data: {
        vendorId: string;
        dropId?: string | undefined;
        itemType: BatchRow['itemType'];
        quantity: number;
        batchRef?: string | undefined;
        receivedAt: Date;
        batchDate: Date;
        vendorInvoiceRef?: string | undefined;
        sourceFileRef?: string | undefined;
        notes?: string | undefined;
        enteredById: string;
    }): Promise<BatchRow> {
        const { dropId, ...rest } = data;
        return this.prisma.supplyBatch.create({
            data: {
                id: randomUUID(),
                createdAt: new Date(),
                status: SupplyBatchStatus.UPLOADED,
                rowsReceived: 0,
                rowsAccepted: 0,
                rowsRejected: 0,
                ...rest,
                ...(dropId ? { dropId } : {}),
            },
            select: batchSelect,
        });
    }

    updateBatch(id: string, data: Prisma.SupplyBatchUpdateInput): Promise<BatchRow> {
        return this.prisma.supplyBatch.update({ where: { id }, data, select: batchSelect });
    }

    /** Does this drop exist, and which organization owns it? */
    async findDropOrganization(dropId: string): Promise<string | null | undefined> {
        const row = await this.prisma.drop.findUnique({
            where: { id: dropId },
            select: { organizationId: true },
        });
        return row === null ? undefined : row.organizationId;
    }

    // ── Chip inventory ──────────────────────────────────────────────────────

    async listTags(
        query: ListTagsQuery,
        organizationIds: string[] | null,
    ): Promise<{ total: number; items: TagRow[] }> {
        const where: Prisma.NfcTagWhereInput = {
            ...(query.supplyBatchId ? { supplyBatchId: query.supplyBatchId } : {}),
            ...(query.vendorId ? { supplyBatch: { vendorId: query.vendorId } } : {}),
            ...(query.skuId ? { skuId: query.skuId } : {}),
            ...(query.lifecycleState ? { lifecycleState: query.lifecycleState } : {}),
            ...(query.qcStatus ? { qcStatus: query.qcStatus } : {}),
            ...(query.unbound === undefined
                ? {}
                : query.unbound
                    ? { skuId: null }
                    : { skuId: { not: null } }),
            ...(query.nfcTagCode ? { nfcTagCode: query.nfcTagCode } : {}),
            ...(organizationIds
                ? { supplyBatch: { drop: { organizationId: { in: organizationIds } } } }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.nfcTag.count({ where }),
            this.prisma.nfcTag.findMany({
                where,
                select: tagSelect,
                orderBy: { nfcTagCode: 'asc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    findTagById(id: string, organizationIds: string[] | null): Promise<TagRow | null> {
        return this.prisma.nfcTag.findFirst({
            where: {
                id,
                ...(organizationIds
                    ? { supplyBatch: { drop: { organizationId: { in: organizationIds } } } }
                    : {}),
            },
            select: tagSelect,
        });
    }

    updateTag(id: string, data: Prisma.NfcTagUpdateInput): Promise<TagRow> {
        return this.prisma.nfcTag.update({ where: { id }, data, select: tagSelect });
    }

    /** Which of these UID hashes are already registered, anywhere on the platform? */
    async findExistingUidHashes(hashes: string[]): Promise<Set<string>> {
        const rows = await this.prisma.nfcTag.findMany({
            where: { tagUidHash: { in: hashes } },
            select: { tagUidHash: true },
        });
        return new Set(rows.map((row) => row.tagUidHash));
    }

    /**
     * Writes a manifest and moves the consignment's counters, in one
     * transaction.
     *
     * All-or-nothing on purpose: a half-applied manifest leaves a physical
     * carton in a state nobody can reconcile from the database, and the chips
     * are already in the building by then.
     *
     * The `nfcTagCode` sequence is allocated inside the transaction from the
     * current maximum, so two concurrent manifests cannot mint the same code —
     * the unique index is the backstop, and a collision fails the whole batch
     * rather than writing half of it.
     */
    async registerTags(input: {
        batchId: string;
        tags: SealedTag[];
    }): Promise<{ created: number; batch: BatchRow }> {
        return this.prisma.$transaction(async (tx) => {
            const last = await tx.nfcTag.findFirst({
                orderBy: { nfcTagCode: 'desc' },
                select: { nfcTagCode: true },
            });
            let next = nextTagOrdinal(last?.nfcTagCode);

            await tx.nfcTag.createMany({
                data: input.tags.map((tag) => ({
                    id: randomUUID(),
                    nfcTagCode: formatTagCode(next++),
                    supplyBatchId: input.batchId,
                    tagUidHash: tag.uidHash,
                    tagUidEncrypted: tag.uidEncrypted,
                    keyReference: tag.keyReference,
                    qcStatus: tag.qcStatus,
                    ...(tag.qcStatus === QcStatus.PENDING
                        ? {}
                        : { qcReportedAt: new Date() }),
                    ...(tag.qcNotes ? { qcNotes: tag.qcNotes } : {}),
                    lifecycleState: TagLifecycleState.UNPROVISIONED,
                })),
            });

            // Counters are incremented rather than assigned: a carton arrives
            // as several manifest calls, and assigning would make the last one
            // overwrite what the others recorded.
            //
            // A chip that failed QC is `rowsRejected` — it was received, it was
            // just not accepted, which is exactly what the three counters
            // distinguish.
            const accepted = input.tags.filter(
                (tag) => tag.qcStatus !== QcStatus.FAILED,
            ).length;
            const batch = await tx.supplyBatch.update({
                where: { id: input.batchId },
                data: {
                    rowsReceived: { increment: input.tags.length },
                    rowsAccepted: { increment: accepted },
                    rowsRejected: { increment: input.tags.length - accepted },
                },
                select: batchSelect,
            });

            return { created: input.tags.length, batch };
        });
    }

    // ── Metrics ─────────────────────────────────────────────────────────────

    /**
     * The chip funnel: lifecycle and QC breakdowns plus the bound/unbound split.
     *
     * Four aggregates rather than one query returning rows — this is a count
     * screen, and loading 400,000 chip rows to count them in JavaScript is how
     * a metrics endpoint becomes the slowest route on the platform.
     */
    async tagMetrics(
        query: SupplyMetricsQuery,
        organizationIds: string[] | null,
    ): Promise<{
        byLifecycle: Record<string, number>;
        byQc: Record<string, number>;
        total: number;
        unbound: number;
    }> {
        const where: Prisma.NfcTagWhereInput = {
            ...(query.vendorId ? { supplyBatch: { vendorId: query.vendorId } } : {}),
            ...(organizationIds
                ? { supplyBatch: { drop: { organizationId: { in: organizationIds } } } }
                : {}),
        };

        const [lifecycle, qc, total, unbound] = await Promise.all([
            this.prisma.nfcTag.groupBy({
                by: ['lifecycleState'],
                where,
                _count: { _all: true },
            }),
            this.prisma.nfcTag.groupBy({
                by: ['qcStatus'],
                where,
                _count: { _all: true },
            }),
            this.prisma.nfcTag.count({ where }),
            this.prisma.nfcTag.count({ where: { ...where, skuId: null } }),
        ]);

        return {
            byLifecycle: tally(lifecycle, 'lifecycleState'),
            byQc: tally(qc, 'qcStatus'),
            total,
            unbound,
        };
    }

    async batchMetrics(
        query: SupplyMetricsQuery,
        organizationIds: string[] | null,
    ): Promise<{
        byStatus: Record<string, number>;
        byItemType: Record<string, number>;
        total: number;
        quantityDeclared: number;
        rowsReceived: number;
        rowsAccepted: number;
        rowsRejected: number;
    }> {
        const where = this.batchWhere(query, organizationIds);

        const [byStatus, byItemType, totals] = await Promise.all([
            this.prisma.supplyBatch.groupBy({
                by: ['status'],
                where,
                _count: { _all: true },
            }),
            this.prisma.supplyBatch.groupBy({
                by: ['itemType'],
                where,
                _count: { _all: true },
            }),
            this.prisma.supplyBatch.aggregate({
                where,
                _count: { _all: true },
                _sum: {
                    quantity: true,
                    rowsReceived: true,
                    rowsAccepted: true,
                    rowsRejected: true,
                },
            }),
        ]);

        return {
            byStatus: tally(byStatus, 'status'),
            byItemType: tally(byItemType, 'itemType'),
            total: totals._count._all,
            quantityDeclared: totals._sum.quantity ?? 0,
            rowsReceived: totals._sum.rowsReceived ?? 0,
            rowsAccepted: totals._sum.rowsAccepted ?? 0,
            rowsRejected: totals._sum.rowsRejected ?? 0,
        };
    }

    /**
     * Vendor reliability.
     *
     * ⚠️ `active` and `byType` are **platform-wide and ignore
     * `organizationIds`** — they count the vendor table, which has no
     * organization to filter on. Only `leaders` is confined, through the
     * consignment filter.
     *
     * That is safe only because the service calls this for GLOBAL-reach
     * callers alone and omits the whole `vendors` block otherwise (the vendor
     * directory is platform-level — see domain/supply-access.ts). A future
     * caller that relaxes that gate would disclose the platform's vendor count
     * to a brand. Scope the two counts before relaxing it.
     */
    async vendorMetrics(
        query: SupplyMetricsQuery,
        organizationIds: string[] | null,
        take: number,
    ): Promise<{
        active: number;
        byType: Record<string, number>;
        leaders: {
            vendorId: string;
            name: string;
            vendorType: VendorRow['vendorType'];
            batches: number;
            quantityDeclared: number;
            rowsAccepted: number;
            rowsRejected: number;
        }[];
    }> {
        const batchWhere = this.batchWhere(query, organizationIds);

        const [active, byType, grouped] = await Promise.all([
            this.prisma.vendor.count({ where: { isActive: true, archivedAt: null } }),
            this.prisma.vendor.groupBy({
                by: ['vendorType'],
                where: { archivedAt: null },
                _count: { _all: true },
            }),
            this.prisma.supplyBatch.groupBy({
                by: ['vendorId'],
                where: batchWhere,
                _count: { _all: true },
                _sum: { quantity: true, rowsAccepted: true, rowsRejected: true },
                // Ranked by rows actually rejected: the list exists to surface
                // the vendor whose cartons keep failing QC, not the biggest one.
                orderBy: { _sum: { rowsRejected: 'desc' } },
                take,
            }),
        ]);

        // One lookup for the names, rather than a join Prisma's groupBy cannot
        // express. At `take` rows this is a single indexed IN.
        const names = await this.prisma.vendor.findMany({
            where: { id: { in: grouped.map((row) => row.vendorId) } },
            select: { id: true, name: true, vendorType: true },
        });
        const byId = new Map(names.map((row) => [row.id, row]));

        return {
            active,
            byType: tally(byType, 'vendorType'),
            leaders: grouped.flatMap((row) => {
                const vendor = byId.get(row.vendorId);
                if (!vendor) return [];
                return [{
                    vendorId: row.vendorId,
                    name: vendor.name,
                    vendorType: vendor.vendorType,
                    batches: row._count._all,
                    quantityDeclared: row._sum.quantity ?? 0,
                    rowsAccepted: row._sum.rowsAccepted ?? 0,
                    rowsRejected: row._sum.rowsRejected ?? 0,
                }];
            }),
        };
    }

    /**
     * Serialized stock across drops: declared supply against what is actually
     * minted, tagged and claimed.
     *
     * `totalSupply` is summed over drops while the rest are counted over units,
     * so they are three separate aggregates — summing a per-drop column through
     * a join to its units would multiply it by the unit count.
     */
    async inventoryMetrics(organizationIds: string[] | null): Promise<{
        drops: number;
        totalSupply: number;
        minted: number;
        tagged: number;
        claimed: number;
    }> {
        const dropWhere: Prisma.DropWhereInput = {
            archivedAt: null,
            ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
        };
        const skuWhere: Prisma.SkuWhereInput = {
            ...(organizationIds ? { drop: { organizationId: { in: organizationIds } } } : {}),
        };

        const [drops, minted, tagged, claimed] = await Promise.all([
            this.prisma.drop.aggregate({
                where: dropWhere,
                _count: { _all: true },
                _sum: { totalSupply: true },
            }),
            this.prisma.sku.count({ where: skuWhere }),
            // The live column. `Sku.tagId` is the deprecated mirror of the same
            // fact and is not counted, or a backfilled row would count twice.
            this.prisma.sku.count({ where: { ...skuWhere, currentNfcTagId: { not: null } } }),
            this.prisma.sku.count({
                where: { ...skuWhere, claimedStatus: ClaimedStatus.CLAIMED },
            }),
        ]);

        return {
            drops: drops._count._all,
            totalSupply: drops._sum.totalSupply ?? 0,
            minted,
            tagged,
            claimed,
        };
    }

    /**
     * Consignments whose registered rows fall short of the declared quantity.
     *
     * Raw SQL because the comparison is column-to-column (`rowsReceived <
     * quantity`), which Prisma's filter language cannot express — and doing it
     * in JavaScript would mean loading every consignment to find the few that
     * are short.
     */
    async shortfalls(
        organizationIds: string[] | null,
        take: number,
    ): Promise<{
        batchId: string;
        batchRef: string | null;
        vendorName: string;
        declared: number;
        registered: number;
    }[]> {
        const rows = await this.prisma.$queryRaw<
            {
                batchId: string;
                batchRef: string | null;
                vendorName: string;
                declared: number;
                registered: number;
            }[]
        >(Prisma.sql`
            SELECT b.id            AS "batchId",
                   b."batchRef"    AS "batchRef",
                   v.name          AS "vendorName",
                   b.quantity      AS declared,
                   b."rowsReceived" AS registered
            FROM "SupplyBatch" b
            JOIN "Vendor" v ON v.id = b."vendorId"
            LEFT JOIN "Drop" d ON d.id = b."dropId"
            WHERE b."rowsReceived" < b.quantity
              AND b.status <> ${SupplyBatchStatus.REJECTED}::"SupplyBatchStatus"
              ${organizationIds === null
                ? Prisma.empty
                : Prisma.sql`AND d."organizationId" = ANY(${organizationIds}::uuid[])`}
            ORDER BY (b.quantity - b."rowsReceived") DESC
            LIMIT ${take}
        `);
        // Postgres returns bigint for some aggregates; these two are plain ints,
        // but the cast keeps the response type honest if that ever changes.
        return rows.map((row) => ({
            ...row,
            declared: Number(row.declared),
            registered: Number(row.registered),
        }));
    }

    /**
     * Drops closest to exhausting their declared supply.
     *
     * "Remaining" is unminted units — supply that exists on paper but has no
     * serialized row yet. A drop whose units are all minted and all sold is not
     * low on *supply*; it is sold out, which is a different screen.
     */
    async lowStock(
        organizationIds: string[] | null,
        threshold: number,
        take: number,
    ): Promise<{
        productId: string;
        groupCode: string;
        name: string;
        totalSupply: number;
        minted: number;
    }[]> {
        const rows = await this.prisma.$queryRaw<
            {
                productId: string;
                groupCode: string;
                name: string;
                totalSupply: number;
                minted: bigint;
            }[]
        >(Prisma.sql`
            SELECT d.id            AS "productId",
                   d."groupCode"   AS "groupCode",
                   d.name          AS name,
                   d."totalSupply" AS "totalSupply",
                   COUNT(s.id)     AS minted
            FROM "Drop" d
            LEFT JOIN "Sku" s ON s."productId" = d.id
            WHERE d."archivedAt" IS NULL
              AND d."totalSupply" > 0
              ${organizationIds === null
                ? Prisma.empty
                : Prisma.sql`AND d."organizationId" = ANY(${organizationIds}::uuid[])`}
            GROUP BY d.id, d."groupCode", d.name, d."totalSupply"
            HAVING (d."totalSupply" - COUNT(s.id))::float / d."totalSupply" <= ${threshold}
            ORDER BY (d."totalSupply" - COUNT(s.id))::float / d."totalSupply" ASC
            LIMIT ${take}
        `);
        // COUNT() comes back as bigint, which JSON.stringify throws on.
        return rows.map((row) => ({ ...row, minted: Number(row.minted) }));
    }

    // ── Shared filters ──────────────────────────────────────────────────────

    private batchWhere(
        query: Partial<ListBatchesQuery> & Partial<SupplyMetricsQuery>,
        organizationIds: string[] | null,
    ): Prisma.SupplyBatchWhereInput {
        const receivedAt =
            query.receivedFrom || query.receivedTo
                ? {
                    receivedAt: {
                        ...(query.receivedFrom ? { gte: query.receivedFrom } : {}),
                        ...(query.receivedTo ? { lte: query.receivedTo } : {}),
                    },
                }
                : {};

        return {
            ...(query.vendorId ? { vendorId: query.vendorId } : {}),
            ...(query.dropId ? { dropId: query.dropId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.itemType ? { itemType: query.itemType } : {}),
            ...receivedAt,
            ...(query.search
                ? {
                    OR: [
                        { batchRef: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                        {
                            vendorInvoiceRef: {
                                contains: query.search,
                                mode: Prisma.QueryMode.insensitive,
                            },
                        },
                    ],
                }
                : {}),
            ...this.organizationFilter(organizationIds),
        };
    }

    /**
     * Confines a query to the caller's organizations.
     *
     * Note what this does NOT do: it never widens. `null` means the caller
     * already reaches everything, so no clause is added; a list means the
     * consignment must name a drop owned by one of them, which also excludes
     * platform stock (`dropId IS NULL`) by construction.
     */
    private organizationFilter(
        organizationIds: string[] | null,
    ): Prisma.SupplyBatchWhereInput {
        if (organizationIds === null) return {};
        return { drop: { organizationId: { in: organizationIds } } };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** `NT00000001` — two-letter prefix plus an ordinal, inside VarChar(10). */
export function formatTagCode(ordinal: number): string {
    return `NT${String(ordinal).padStart(8, '0')}`;
}

/**
 * The next ordinal after the highest code currently issued.
 *
 * Lexical `ORDER BY nfcTagCode DESC` is the same as numeric order here because
 * the ordinal is zero-padded to a fixed width — which is why the padding is
 * part of the format rather than cosmetic.
 */
export function nextTagOrdinal(lastCode: string | undefined): number {
    if (!lastCode) return 1;
    const parsed = Number.parseInt(lastCode.slice(2), 10);
    return Number.isFinite(parsed) ? parsed + 1 : 1;
}

/** `[{ status: 'ACCEPTED', _count: { _all: 3 } }]` -> `{ ACCEPTED: 3 }`. */
function tally<K extends string>(
    rows: ({ _count: { _all: number } } & Record<K, string>)[],
    key: K,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) out[row[key]] = row._count._all;
    return out;
}

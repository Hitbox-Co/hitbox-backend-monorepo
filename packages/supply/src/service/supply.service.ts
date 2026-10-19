import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { QcStatus, SupplyBatchStatus, SupplyItemType } from '@hitbox/database';
import {
    LOW_STOCK_THRESHOLD,
    SUPPLY_AUDIT_EVENTS,
    SUPPLY_ERROR_CODES,
    SUPPLY_EVENTS,
    SUPPLY_METRIC_LIST_SIZE,
} from '../constants/supply.constant';
import { acceptsRows, canTransition } from '../domain/batch-state';
import type { ISupplyAudit } from '../domain/interfaces/supply-audit.interface';
import type { ITagCipher } from '../domain/interfaces/tag-cipher.interface';
import {
    requireConsignmentAccess,
    requireGlobalConsignmentAccess,
    requireReportingAccess,
    requireTagAccess,
    requireWrite,
} from '../domain/supply-access';
import { ReadScope } from '../domain/supply-access';
import type { SupplyAccess } from '../domain/supply-access';
import type {
    CreateBatchDto,
    CreateVendorDto,
    DecideBatchDto,
    ListBatchesQuery,
    ListTagsQuery,
    ListVendorsQuery,
    NfcTagResponse,
    RecordQcDto,
    RegisterTagsDto,
    RegisterTagsResult,
    SupplyBatchResponse,
    SupplyMetrics,
    SupplyMetricsQuery,
    UpdateVendorDto,
    VendorResponse,
} from '../dto/supply.dto';
import type {
    BatchRow,
    SealedTag,
    SupplyRepository,
    TagRow,
    VendorRow,
} from '../repository/supply.repository';

/**
 * Consignment types a chip manifest may be registered against.
 *
 * Chips arrive **already embedded in the goods** on this platform — nobody
 * ships a reel of loose tags — so the type that carries them is whatever the
 * finished goods were booked in as.
 *
 * Since `SupplyItemType` became a set of product categories every member is
 * listed, which looks like a check that does nothing. It is kept as an
 * explicit allowlist anyway, so that a category added later which carries no
 * chips — packaging, say — has to opt in deliberately rather than inheriting
 * permission by silence.
 */
const MANIFEST_ITEM_TYPES: ReadonlySet<SupplyItemType> = new Set([
    SupplyItemType.FIGURE,
    SupplyItemType.KEYCHAIN,
    SupplyItemType.JERSEY,
    SupplyItemType.APPAREL,
    SupplyItemType.TRADING_CARD,
    SupplyItemType.POSTER,
    SupplyItemType.PLUSH,
    // Mixed goods that still carry a chip each.
    SupplyItemType.MERCHANDISE,
    // Uncategorised, including every row the category migration could not
    // place. They hold chips like anything else.
    SupplyItemType.OTHER,
]);

/** The caller's view plus the correlation id every write is recorded under. */
export interface SupplyMutationContext {
    access: SupplyAccess;
    correlationId: string;
}

interface SupplyServiceDeps {
    supply: SupplyRepository;
    eventBus: IEventBus;
    audit: ISupplyAudit;
    logger: Logger;
    /**
     * Absent on a deployment with no chip-UID key configured. Reads still work;
     * registering a manifest is refused with a 503, because writing chip rows
     * under an improvised key would produce records that can never be matched
     * against a real tap.
     */
    tagCipher?: ITagCipher | undefined;
}

interface Paged<T> {
    data: T[];
    meta: { page: number; limit: number; total: number; totalPages: number };
}

export class SupplyService {
    constructor(private readonly deps: SupplyServiceDeps) { }

    // ── Vendors ─────────────────────────────────────────────────────────────

    async listVendors(
        access: SupplyAccess,
        query: ListVendorsQuery,
    ): Promise<Paged<VendorResponse>> {
        requireGlobalConsignmentAccess(access);
        const { total, items } = await this.deps.supply.listVendors(query);
        return paged(items.map(toVendorResponse), query, total);
    }

    async getVendor(access: SupplyAccess, vendorId: string): Promise<VendorResponse> {
        requireGlobalConsignmentAccess(access);
        const row = await this.deps.supply.findVendorById(vendorId);
        if (!row) {
            throw AppError.notFound('Vendor not found', SUPPLY_ERROR_CODES.VENDOR_NOT_FOUND);
        }
        return toVendorResponse(row);
    }

    async createVendor(
        context: SupplyMutationContext,
        dto: CreateVendorDto,
    ): Promise<VendorResponse> {
        requireWrite(context.access);
        const row = await this.deps.supply.createVendor(dto);

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_CREATE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'Vendor',
            resourceId: row.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            after: { name: row.name, vendorType: row.vendorType, country: row.country },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_CREATED, {
            vendorId: row.id,
            vendorType: row.vendorType,
        });

        return toVendorResponse(row);
    }

    async updateVendor(
        context: SupplyMutationContext,
        vendorId: string,
        dto: UpdateVendorDto,
    ): Promise<VendorResponse> {
        requireWrite(context.access);
        const before = await this.deps.supply.findVendorById(vendorId);
        if (!before) {
            throw AppError.notFound('Vendor not found', SUPPLY_ERROR_CODES.VENDOR_NOT_FOUND);
        }

        const { archived, ...fields } = dto;
        const row = await this.deps.supply.updateVendor(vendorId, {
            ...fields,
            // Archival is a timestamp, not a flag, and un-archiving clears it.
            // Setting `isActive` alone would leave a retired vendor selectable.
            ...(archived === undefined
                ? {}
                : archived
                    ? { archivedAt: new Date(), isActive: false }
                    : { archivedAt: null }),
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_UPDATE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'Vendor',
            resourceId: vendorId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            // Field names, never a full row — an audit entry is a record of
            // what changed, not a second copy of the table.
            metadata: { fields: Object.keys(dto) },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_UPDATED, { vendorId });

        return toVendorResponse(row);
    }

    // ── Consignments ────────────────────────────────────────────────────────

    async listBatches(
        access: SupplyAccess,
        query: ListBatchesQuery,
    ): Promise<Paged<SupplyBatchResponse>> {
        requireConsignmentAccess(access);
        const { total, items } = await this.deps.supply.listBatches(
            query,
            access.organizationIds,
        );
        return paged(
            items.map((row) => toBatchResponse(row, access.tag !== null)),
            query,
            total,
        );
    }

    async getBatch(access: SupplyAccess, batchId: string): Promise<SupplyBatchResponse> {
        requireConsignmentAccess(access);
        const row = await this.loadBatch(access, batchId);
        return toBatchResponse(row, access.tag !== null);
    }

    async createBatch(
        context: SupplyMutationContext,
        dto: CreateBatchDto,
    ): Promise<SupplyBatchResponse> {
        requireWrite(context.access);

        const vendor = await this.deps.supply.findVendorById(dto.vendorId);
        if (!vendor) {
            throw AppError.notFound('Vendor not found', SUPPLY_ERROR_CODES.VENDOR_NOT_FOUND);
        }
        if (vendor.archivedAt) {
            throw AppError.conflict(
                'This vendor is archived and cannot take new consignments.',
                SUPPLY_ERROR_CODES.VENDOR_ARCHIVED,
            );
        }

        // Checked before the write so a typo'd drop id is a 404 naming the drop,
        // not a foreign-key error naming a constraint.
        let organizationId: string | null = null;
        if (dto.dropId) {
            const owner = await this.deps.supply.findDropOrganization(dto.dropId);
            if (owner === undefined) {
                throw AppError.notFound('Drop not found', SUPPLY_ERROR_CODES.NOT_FOUND);
            }
            organizationId = owner;
        }

        const row = await this.deps.supply.createBatch({
            ...dto,
            batchDate: dto.batchDate ?? dto.receivedAt,
            enteredById: context.access.userId,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.BATCH_CREATE,
            actorId: context.access.userId,
            organizationId,
            resourceType: 'SupplyBatch',
            resourceId: row.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            after: {
                vendorId: row.vendorId,
                itemType: row.itemType,
                quantity: row.quantity,
                batchRef: row.batchRef,
            },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.BATCH_CREATED, {
            batchId: row.id,
            vendorId: row.vendorId,
            itemType: row.itemType,
            quantity: row.quantity,
        });

        return toBatchResponse(row, context.access.tag !== null);
    }

    /**
     * Accept, reject or mark a consignment validated.
     *
     * The transition is checked against the state machine rather than assigned,
     * so a double-click cannot re-decide a consignment and a rejected carton
     * cannot quietly become an accepted one.
     */
    async decideBatch(
        context: SupplyMutationContext,
        batchId: string,
        dto: DecideBatchDto,
    ): Promise<SupplyBatchResponse> {
        requireWrite(context.access);
        const before = await this.loadBatch(context.access, batchId);

        if (!canTransition(before.status, dto.status)) {
            throw AppError.conflict(
                `A consignment in ${before.status} cannot move to ${dto.status}.`,
                SUPPLY_ERROR_CODES.BATCH_STATE_INVALID,
            );
        }

        const row = await this.deps.supply.updateBatch(batchId, {
            status: dto.status,
            ...(dto.validationReportRef
                ? { validationReportRef: dto.validationReportRef }
                : {}),
            // The decision note is appended rather than replacing whatever the
            // intake clerk wrote, so a rejection reason never overwrites the
            // discrepancy that prompted it.
            ...(dto.note ? { notes: appendNote(before.notes, dto.status, dto.note) } : {}),
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.BATCH_DECIDE,
            actorId: context.access.userId,
            organizationId: before.drop ? null : null,
            resourceType: 'SupplyBatch',
            resourceId: batchId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { status: before.status },
            after: { status: row.status },
            ...(dto.note ? { metadata: { note: dto.note } } : {}),
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.BATCH_DECIDED, {
            batchId,
            from: before.status,
            to: row.status,
            rowsAccepted: row.rowsAccepted,
            rowsRejected: row.rowsRejected,
        });

        return toBatchResponse(row, context.access.tag !== null);
    }

    // ── Chip manifest ───────────────────────────────────────────────────────

    /**
     * Registers a vendor manifest into a consignment.
     *
     * Three refusals, in order, and the order matters — each is cheaper than
     * the next and none of them should be reached with rows already written:
     *
     *   1. the consignment is not one chips belong in, or is already decided;
     *   2. the manifest repeats a UID within itself;
     *   3. a UID is already registered somewhere on the platform.
     *
     * The third is the anti-cloning check. Two rows claiming the same chip is
     * precisely the state a counterfeit produces, so the whole manifest is
     * refused rather than the offending row being skipped — a carton that
     * contains one duplicate is a carton nobody should accept the rest of
     * without looking at it.
     */
    async registerTags(
        context: SupplyMutationContext,
        batchId: string,
        dto: RegisterTagsDto,
    ): Promise<RegisterTagsResult> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const cipher = this.deps.tagCipher;
        if (!cipher) {
            throw new AppError(
                'Chip registration is not configured on this deployment (no tag UID key).',
                503,
                'SUPPLY_TAG_KEY_UNAVAILABLE',
            );
        }

        const batch = await this.loadBatch(context.access, batchId);

        if (!MANIFEST_ITEM_TYPES.has(batch.itemType)) {
            throw AppError.conflict(
                `A ${batch.itemType} consignment does not carry chips, so no manifest can be ` +
                `registered against it.`,
                SUPPLY_ERROR_CODES.BATCH_ITEM_TYPE_INVALID,
            );
        }
        if (!acceptsRows(batch.status)) {
            throw AppError.conflict(
                `A consignment in ${batch.status} no longer accepts rows.`,
                SUPPLY_ERROR_CODES.BATCH_STATE_INVALID,
            );
        }
        if (batch.rowsReceived + dto.tags.length > batch.quantity) {
            throw AppError.conflict(
                `Registering ${dto.tags.length} rows would exceed the declared quantity ` +
                `(${batch.rowsReceived} of ${batch.quantity} already registered).`,
                SUPPLY_ERROR_CODES.BATCH_QUANTITY_EXCEEDED,
            );
        }

        // Hash first: the rest of this method works on hashes, so a raw UID
        // never reaches a query, a log line or an error message.
        const hashed = dto.tags.map((tag) => ({ ...tag, hash: cipher.hash(tag.uid) }));

        const seen = new Map<string, number>();
        const duplicates: { row: number; reason: string }[] = [];
        hashed.forEach((tag, index) => {
            const first = seen.get(tag.hash);
            if (first === undefined) seen.set(tag.hash, index + 1);
            else duplicates.push({ row: index + 1, reason: `Repeats row ${first}.` });
        });
        if (duplicates.length > 0) {
            throw AppError.badRequest(
                'The manifest repeats a tag UID.',
                SUPPLY_ERROR_CODES.TAG_UID_DUPLICATED,
                { duplicates },
            );
        }

        const existing = await this.deps.supply.findExistingUidHashes(
            hashed.map((tag) => tag.hash),
        );
        if (existing.size > 0) {
            const clashes = hashed.flatMap((tag, index) =>
                existing.has(tag.hash)
                    ? [{ row: index + 1, reason: 'Already registered on this platform.' }]
                    : [],
            );
            throw AppError.conflict(
                'The manifest contains a tag UID that is already registered.',
                SUPPLY_ERROR_CODES.TAG_UID_TAKEN,
                { duplicates: clashes },
            );
        }

        if (dto.dryRun) {
            const accepted = hashed.filter(
                (tag) => (tag.qcStatus ?? QcStatus.PENDING) !== QcStatus.FAILED,
            ).length;
            return {
                batchId,
                dryRun: true,
                registered: hashed.length,
                duplicates: [],
                batch: {
                    rowsReceived: batch.rowsReceived + hashed.length,
                    rowsAccepted: batch.rowsAccepted + accepted,
                    rowsRejected: batch.rowsRejected + (hashed.length - accepted),
                    status: batch.status,
                },
            };
        }

        const sealed: SealedTag[] = hashed.map((tag) => ({
            uidHash: tag.hash,
            uidEncrypted: cipher.encrypt(tag.uid),
            keyReference: cipher.keyReference,
            qcStatus: tag.qcStatus ?? QcStatus.PENDING,
            qcNotes: tag.qcNotes,
        }));

        const result = await this.deps.supply.registerTags({ batchId, tags: sealed });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAGS_REGISTER,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'SupplyBatch',
            resourceId: batchId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            // Counts, never UIDs. An audit trail that recorded the UIDs would
            // be a second place the anti-counterfeiting material is stored, and
            // a longer-lived one than the table it came from.
            metadata: { registered: result.created, keyReference: cipher.keyReference },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.TAGS_REGISTERED, {
            batchId,
            registered: result.created,
        });

        return {
            batchId,
            dryRun: false,
            registered: result.created,
            duplicates: [],
            batch: {
                rowsReceived: result.batch.rowsReceived,
                rowsAccepted: result.batch.rowsAccepted,
                rowsRejected: result.batch.rowsRejected,
                status: result.batch.status,
            },
        };
    }

    // ── Chip inventory ──────────────────────────────────────────────────────

    async listTags(
        access: SupplyAccess,
        query: ListTagsQuery,
    ): Promise<Paged<NfcTagResponse>> {
        requireTagAccess(access);
        const { total, items } = await this.deps.supply.listTags(
            query,
            access.organizationIds,
        );
        return paged(items.map(toTagResponse), query, total);
    }

    async getTag(access: SupplyAccess, tagId: string): Promise<NfcTagResponse> {
        requireTagAccess(access);
        const row = await this.deps.supply.findTagById(tagId, access.organizationIds);
        if (!row) {
            throw AppError.notFound('NFC tag not found', SUPPLY_ERROR_CODES.TAG_NOT_FOUND);
        }
        return toTagResponse(row);
    }

    /**
     * Records a QC verdict on one chip.
     *
     * The consignment's accepted/rejected counters are deliberately NOT moved
     * here. They record what the *manifest* said on intake; a later QC reversal
     * is a fact about the chip, and rewriting the intake counters would change
     * a figure an acceptance decision was already taken against.
     */
    async recordQc(
        context: SupplyMutationContext,
        tagId: string,
        dto: RecordQcDto,
    ): Promise<NfcTagResponse> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const before = await this.deps.supply.findTagById(
            tagId,
            context.access.organizationIds,
        );
        if (!before) {
            throw AppError.notFound('NFC tag not found', SUPPLY_ERROR_CODES.TAG_NOT_FOUND);
        }
        if (
            before.qcStatus === dto.qcStatus &&
            (dto.qcNotes ?? null) === before.qcNotes
        ) {
            throw AppError.badRequest(
                'This QC verdict is already recorded.',
                SUPPLY_ERROR_CODES.NO_CHANGES,
            );
        }

        const row = await this.deps.supply.updateTag(tagId, {
            qcStatus: dto.qcStatus,
            qcReportedAt: new Date(),
            qcNotes: dto.qcNotes ?? null,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAG_QC,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'NfcTag',
            resourceId: tagId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { qcStatus: before.qcStatus },
            after: { qcStatus: row.qcStatus },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.TAG_QC_RECORDED, {
            tagId,
            qcStatus: row.qcStatus,
        });

        return toTagResponse(row);
    }

    // ── Metrics ─────────────────────────────────────────────────────────────

    /**
     * The supply/inventory rollup.
     *
     * Each block is gated by the capability of the resource whose data it
     * exposes, and a block the caller may not see is **omitted, not zeroed** —
     * `tags: { total: 0 }` would read as "no chips exist", which is a different
     * and actionable claim from "you cannot see this".
     *
     * `organizationId` narrows; it never widens. A caller who names an
     * organization they hold nothing for is refused rather than handed an empty
     * result, which would let them probe which organizations exist by watching
     * response shapes.
     */
    async metrics(
        access: SupplyAccess,
        query: SupplyMetricsQuery,
    ): Promise<SupplyMetrics> {
        requireReportingAccess(access);

        let organizationIds = access.organizationIds;
        if (query.organizationId) {
            if (organizationIds !== null && !organizationIds.includes(query.organizationId)) {
                throw AppError.forbidden(
                    'organizationId does not match your granted scope.',
                    SUPPLY_ERROR_CODES.FORBIDDEN,
                );
            }
            organizationIds = [query.organizationId];
        }

        const canSeeTags = access.tag !== null;
        const canSeeConsignments = access.consignment !== null;
        // The vendor block is platform-level for the same reason the directory
        // is: it names who HitBox buys from and how often their cartons fail.
        // An org-scoped caller gets every other block, confined to their drops,
        // and this one omitted.
        const canSeeVendors =
            canSeeConsignments && access.consignment?.scope === ReadScope.GLOBAL;

        const [tags, batches, vendors, inventory, shortfalls, lowStock] = await Promise.all([
            canSeeTags
                ? this.deps.supply.tagMetrics(query, organizationIds)
                : Promise.resolve(null),
            canSeeConsignments
                ? this.deps.supply.batchMetrics(query, organizationIds)
                : Promise.resolve(null),
            canSeeVendors
                ? this.deps.supply.vendorMetrics(
                    query,
                    organizationIds,
                    SUPPLY_METRIC_LIST_SIZE,
                )
                : Promise.resolve(null),
            canSeeConsignments
                ? this.deps.supply.inventoryMetrics(organizationIds)
                : Promise.resolve(null),
            canSeeConsignments
                ? this.deps.supply.shortfalls(organizationIds, SUPPLY_METRIC_LIST_SIZE)
                : Promise.resolve(null),
            canSeeConsignments
                ? this.deps.supply.lowStock(
                    organizationIds,
                    LOW_STOCK_THRESHOLD,
                    SUPPLY_METRIC_LIST_SIZE,
                )
                : Promise.resolve(null),
        ]);

        const metrics: SupplyMetrics = {
            generatedAt: new Date().toISOString(),
            scope: organizationIds === null ? 'GLOBAL' : 'ORGANIZATION',
            organizationIds,
        };

        if (tags) {
            const failed = tags.byQc[QcStatus.FAILED] ?? 0;
            metrics.tags = {
                total: tags.total,
                byLifecycle: tags.byLifecycle,
                byQc: tags.byQc,
                qcFailureRate: percent(failed, tags.total),
                unbound: tags.unbound,
                bound: tags.total - tags.unbound,
            };
        }

        if (batches) {
            const decided = batches.rowsAccepted + batches.rowsRejected;
            metrics.batches = {
                total: batches.total,
                byStatus: batches.byStatus,
                byItemType: batches.byItemType,
                quantityDeclared: batches.quantityDeclared,
                rowsReceived: batches.rowsReceived,
                rowsAccepted: batches.rowsAccepted,
                rowsRejected: batches.rowsRejected,
                acceptanceRate: percent(batches.rowsAccepted, decided),
                pendingReview:
                    (batches.byStatus[SupplyBatchStatus.UPLOADED] ?? 0) +
                    (batches.byStatus[SupplyBatchStatus.VALIDATED] ?? 0),
            };
        }

        if (vendors) {
            metrics.vendors = {
                active: vendors.active,
                byType: vendors.byType,
                leaders: vendors.leaders.map((vendor) => ({
                    ...vendor,
                    rejectionRate: percent(
                        vendor.rowsRejected,
                        vendor.rowsAccepted + vendor.rowsRejected,
                    ),
                })),
            };
        }

        if (inventory) {
            metrics.inventory = {
                drops: inventory.drops,
                totalSupply: inventory.totalSupply,
                minted: inventory.minted,
                // Clamped: an edition over-minted against a later-reduced
                // `totalSupply` would otherwise report negative headroom.
                unminted: Math.max(0, inventory.totalSupply - inventory.minted),
                claimed: inventory.claimed,
                unclaimed: Math.max(0, inventory.minted - inventory.claimed),
                ...(canSeeTags
                    ? {
                        tagged: inventory.tagged,
                        untagged: Math.max(0, inventory.minted - inventory.tagged),
                    }
                    : {}),
            };
        }

        if (shortfalls) {
            metrics.reconciliation = {
                shortfalls: shortfalls.map((row) => ({
                    ...row,
                    shortfall: row.declared - row.registered,
                })),
                ...(tags && inventory
                    ? {
                        unboundTagStock: tags.unbound,
                        untaggedUnits: Math.max(0, inventory.minted - inventory.tagged),
                    }
                    : {}),
            };
        }

        if (lowStock) {
            metrics.lowStock = lowStock.map((row) => ({
                productId: row.productId,
                groupCode: row.groupCode,
                name: row.name,
                totalSupply: row.totalSupply,
                minted: row.minted,
                remaining: Math.max(0, row.totalSupply - row.minted),
                percentRemaining: percent(
                    Math.max(0, row.totalSupply - row.minted),
                    row.totalSupply,
                ),
            }));
        }

        return metrics;
    }

    // ── Shared ──────────────────────────────────────────────────────────────

    /** Loads a consignment already confined to the caller's reach, or 404s. */
    private async loadBatch(
        access: SupplyAccess,
        batchId: string,
    ): Promise<BatchRow> {
        const row = await this.deps.supply.findBatchById(batchId, access.organizationIds);
        if (!row) {
            throw AppError.notFound(
                'Supply batch not found',
                SUPPLY_ERROR_CODES.BATCH_NOT_FOUND,
            );
        }
        return row;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Projections
// ────────────────────────────────────────────────────────────────────────────

function toVendorResponse(row: VendorRow): VendorResponse {
    return {
        id: row.id,
        name: row.name,
        legalName: row.legalName,
        country: row.country,
        vendorType: row.vendorType,
        contactName: row.contactName,
        contactEmail: row.contactEmail,
        contactPhone: row.contactPhone,
        notes: row.notes,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        counts: { batches: row._count.supplyBatchs, units: row._count.skus },
    };
}

export function toBatchResponse(row: BatchRow, canSeeTags: boolean): SupplyBatchResponse {
    return {
        id: row.id,
        vendorId: row.vendorId,
        vendor: row.vendor
            ? { id: row.vendor.id, name: row.vendor.name, vendorType: row.vendor.vendorType }
            : null,
        dropId: row.dropId,
        drop: row.drop
            ? { id: row.drop.id, groupCode: row.drop.groupCode, name: row.drop.name }
            : null,
        itemType: row.itemType,
        status: row.status,
        quantity: row.quantity,
        batchRef: row.batchRef,
        vendorInvoiceRef: row.vendorInvoiceRef,
        receivedAt: row.receivedAt.toISOString(),
        batchDate: row.batchDate.toISOString(),
        rowsReceived: row.rowsReceived,
        rowsAccepted: row.rowsAccepted,
        rowsRejected: row.rowsRejected,
        sourceFileRef: row.sourceFileRef,
        validationReportRef: row.validationReportRef,
        enteredById: row.enteredById,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        reconciliation: {
            declared: row.quantity,
            registered: row.rowsReceived,
            shortfall: Math.max(0, row.quantity - row.rowsReceived),
            // How many chip rows actually exist against this consignment — the
            // number that catches a manifest counted twice. Omitted rather than
            // zeroed for a caller who does not reach the chip inventory.
            ...(canSeeTags ? { tagsRegistered: row._count.nfcTags } : {}),
        },
    };
}

export function toTagResponse(row: TagRow): NfcTagResponse {
    return {
        id: row.id,
        nfcTagCode: row.nfcTagCode,
        supplyBatchId: row.supplyBatchId,
        batch: row.supplyBatch
            ? {
                id: row.supplyBatch.id,
                batchRef: row.supplyBatch.batchRef,
                vendorId: row.supplyBatch.vendorId,
                vendorName: row.supplyBatch.vendor.name,
            }
            : null,
        skuId: row.skuId,
        sku: row.sku
            ? { id: row.sku.id, skuCode: row.sku.skuCode, serialNumber: row.sku.serialNumber }
            : null,
        qcStatus: row.qcStatus,
        qcReportedAt: row.qcReportedAt?.toISOString() ?? null,
        qcNotes: row.qcNotes,
        lifecycleState: row.lifecycleState,
        lastTapCounter: row.lastTapCounter,
        tamperStatus: row.tamperStatus,
        personalizedAt: row.personalizedAt?.toISOString() ?? null,
        boundAt: row.boundAt?.toISOString() ?? null,
        activatedAt: row.activatedAt?.toISOString() ?? null,
        retiredAt: row.retiredAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * A rate as a two-decimal string, never a float.
 *
 * Same reasoning as money: `0.1 + 0.2` is a bad way to compare a threshold, and
 * a client that receives `"98.67"` cannot accidentally re-round it into
 * something that disagrees with what another screen shows.
 *
 * A zero denominator is `"0.00"`, not NaN — "no rows were decided" is a real
 * state on the intake screen and it should render as a number.
 */
export function percent(part: number, whole: number): string {
    if (whole <= 0) return '0.00';
    return ((part / whole) * 100).toFixed(2);
}

/** Appends a decision note without discarding what intake wrote. */
function appendNote(
    existing: string | null,
    status: SupplyBatchStatus,
    note: string,
): string {
    const line = `[${status}] ${note}`;
    return existing ? `${existing}\n${line}` : line;
}

function paged<T>(
    data: T[],
    query: { page: number; limit: number },
    total: number,
): Paged<T> {
    return {
        data,
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
}

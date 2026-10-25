import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { QcStatus, SupplyBatchStatus, SupplyItemType } from '@hitbox/database';
import type { Prisma } from '@hitbox/database';
import {
    LOW_STOCK_THRESHOLD,
    SUPPLY_AUDIT_EVENTS,
    SUPPLY_ERROR_CODES,
    SUPPLY_EVENTS,
    SUPPLY_METRIC_LIST_SIZE,
} from '../constants/supply.constant';
import { acceptsRows, canTransition } from '../domain/batch-state';
import type { ISupplyAudit, SupplyActorType } from '../domain/interfaces/supply-audit.interface';
import type { ITagCipher } from '../domain/interfaces/tag-cipher.interface';
import type { ISupplyStockMinter } from '../domain/interfaces/stock-minter.interface';
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
    AllotmentCheck,
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
    /**
     * Vendor allotment coverage. Accepting a consignment its vendor's
     * allotment does not cover is refused. Absent in a bare test harness.
     */
    allotmentGate?: { check(batch: BatchRow): Promise<AllotmentCheck | null> } | undefined;
    /**
     * Mints the accepted chips into sellable units of the drop. Absent in a
     * bare test harness, where an accept only changes the status.
     */
    stockMinter?: ISupplyStockMinter | undefined;
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
        return {
            ...toBatchResponse(row, access.tag !== null),
            allotment: (await this.deps.allotmentGate?.check(row)) ?? null,
        };
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

        if (dto.lines && dto.dropId) {
            await this.assertLinesBelongToDrop(dto.dropId, dto.lines);
        }

        const row = await this.bookConsignment({
            actorId: context.access.userId,
            actorType: 'HITBOX_ADMIN',
            correlationId: context.correlationId,
            organizationId,
            dto,
        });
        return toBatchResponse(row, context.access.tag !== null);
    }

    /**
     * Writes a consignment, its audit row and its event. No access checks —
     * the caller has made them: `createBatch` for HitBox staff, the vendor
     * portal for a vendor booking against one of its assigned drops.
     */
    async bookConsignment(input: {
        actorId: string;
        actorType: SupplyActorType;
        correlationId: string;
        organizationId: string | null;
        dto: CreateBatchDto;
    }): Promise<BatchRow> {
        const { dto } = input;
        // The schema guarantees one of the two; lines win because the total
        // is defined as their sum.
        const quantity = dto.lines
            ? dto.lines.reduce((sum, line) => sum + line.quantity, 0)
            : dto.quantity!;
        const row = await this.deps.supply.createBatch({
            ...dto,
            quantity,
            batchDate: dto.batchDate ?? dto.receivedAt,
            enteredById: input.actorId,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.BATCH_CREATE,
            actorId: input.actorId,
            actorType: input.actorType,
            organizationId: input.organizationId,
            resourceType: 'SupplyBatch',
            resourceId: row.id,
            result: 'SUCCESS',
            correlationId: input.correlationId,
            after: {
                vendorId: row.vendorId,
                itemType: row.itemType,
                quantity: row.quantity,
                batchRef: row.batchRef,
                lines: row.lines.map((line) => ({
                    variantId: line.variantId,
                    quantity: line.quantity,
                })),
            },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.BATCH_CREATED, {
            batchId: row.id,
            vendorId: row.vendorId,
            itemType: row.itemType,
            quantity: row.quantity,
        });

        return row;
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

        // Every declared unit needs its chip before the carton can be taken
        // into stock: an accepted unit without a chip is an item nobody can
        // claim or verify.
        if (dto.status === SupplyBatchStatus.ACCEPTED) {
            assertManifestComplete(before);
        }

        // A vendor may book beyond its allotment; HitBox may not ACCEPT beyond
        // it. Taking the extra stock is a decision made by raising the
        // allotment first — the 409 carries the exact PATCH that would.
        if (dto.status === SupplyBatchStatus.ACCEPTED && this.deps.allotmentGate) {
            const check = await this.deps.allotmentGate.check(before);
            if (check && !check.covered) {
                throw AppError.conflict(
                    "This consignment exceeds the vendor's allotment. Increase the allotment " +
                    '(PATCH /admin/supply/vendors/:vendorId/drops/:dropId/allotment) to accept it.',
                    SUPPLY_ERROR_CODES.ALLOTMENT_INSUFFICIENT,
                    check,
                );
            }
        }

        const data = {
            status: dto.status,
            ...(dto.validationReportRef
                ? { validationReportRef: dto.validationReportRef }
                : {}),
            // The decision note is appended rather than replacing whatever the
            // intake clerk wrote, so a rejection reason never overwrites the
            // discrepancy that prompted it.
            ...(dto.note ? { notes: appendNote(before.notes, dto.status, dto.note) } : {}),
        };

        // Accepting a consignment for a drop takes its chips into stock: one
        // unit per chip that did not fail QC, of the chip's variant, born
        // bound to it. Status, mint and binding commit together.
        let row: BatchRow;
        let stock: SupplyBatchResponse['stock'] = null;
        if (
            dto.status === SupplyBatchStatus.ACCEPTED &&
            before.dropId &&
            this.deps.stockMinter
        ) {
            ({ row, stock } = await this.acceptIntoStock(context, before, data));
        } else {
            row = await this.deps.supply.updateBatch(batchId, data);
        }

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
            metadata: {
                ...(dto.note ? { note: dto.note } : {}),
                ...(stock ? { minted: stock.minted, units: stock.units } : {}),
            },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.BATCH_DECIDED, {
            batchId,
            from: before.status,
            to: row.status,
            rowsAccepted: row.rowsAccepted,
            rowsRejected: row.rowsRejected,
            minted: stock?.minted ?? 0,
        });

        return { ...toBatchResponse(row, context.access.tag !== null), stock };
    }

    /**
     * ACCEPTED, for a consignment booked against a drop: the chips become
     * units. One transaction, in this order:
     *
     *   1. lock the batch row and confirm nobody decided it meanwhile — a
     *      double-clicked Accept is a 409, never a second set of units;
     *   2. lock the drop, so accepts into one drop run one at a time;
     *   3. re-check the vendor allotment on settled numbers;
     *   4. release approval + variant rules + variant caps (skus' own checks);
     *   5. mint per variant (drop and variant caps re-enforced in the mint),
     *      bind each chip to its unit, set the status.
     *
     * A serial collision with a mint running elsewhere on the same drop rolls
     * the transaction back and is retried; nothing is ever half-applied.
     */
    private async acceptIntoStock(
        context: SupplyMutationContext,
        batch: BatchRow,
        data: Prisma.SupplyBatchUpdateInput,
    ): Promise<{ row: BatchRow; stock: NonNullable<SupplyBatchResponse['stock']> }> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await this.acceptIntoStockOnce(context, batch, data);
            } catch (error) {
                if (isUniqueViolation(error) && attempt < ACCEPT_MAX_ATTEMPTS) {
                    this.deps.logger.warn(
                        { batchId: batch.id, attempt },
                        'accept collided with a concurrent mint — retrying',
                    );
                    continue;
                }
                if (isUniqueViolation(error)) {
                    throw AppError.conflict(
                        'Another mint on this drop kept colliding with this accept. Try again.',
                        SUPPLY_ERROR_CODES.ACCEPT_CONFLICT,
                    );
                }
                throw error;
            }
        }
    }

    private async acceptIntoStockOnce(
        context: SupplyMutationContext,
        batch: BatchRow,
        data: Prisma.SupplyBatchUpdateInput,
    ): Promise<{ row: BatchRow; stock: NonNullable<SupplyBatchResponse['stock']> }> {
        const minter = this.deps.stockMinter!;
        const dropId = batch.dropId!;

        return this.deps.supply.transaction(async (tx) => {
            const locked = await this.deps.supply.lockBatchWithin(tx, batch.id);
            if (!locked || locked.status !== batch.status) {
                throw AppError.conflict(
                    `This consignment was decided by someone else meanwhile ` +
                    `(now ${locked?.status ?? 'gone'}). Reload it.`,
                    SUPPLY_ERROR_CODES.BATCH_STATE_INVALID,
                );
            }
            await this.deps.supply.lockDropWithin(tx, dropId);

            if (this.deps.allotmentGate) {
                const check = await this.deps.allotmentGate.check(batch);
                if (check && !check.covered) {
                    throw AppError.conflict(
                        "This consignment exceeds the vendor's allotment. Increase the allotment " +
                        '(PATCH /admin/supply/vendors/:vendorId/drops/:dropId/allotment) to accept it.',
                        SUPPLY_ERROR_CODES.ALLOTMENT_INSUFFICIENT,
                        check,
                    );
                }
            }

            const drop = await this.deps.supply.findDropForMint(tx, dropId);
            if (!drop) {
                throw AppError.notFound(
                    "This consignment's drop no longer exists.",
                    SUPPLY_ERROR_CODES.DROP_NOT_FOUND,
                );
            }

            // Grouped by variant in first-seen order, so each variant's units
            // get one contiguous serial range.
            const chips = await this.deps.supply.findChipsToStock(tx, batch.id);
            const groups = new Map<string | null, string[]>();
            for (const chip of chips) {
                const group = groups.get(chip.variantId) ?? [];
                group.push(chip.id);
                groups.set(chip.variantId, group);
            }

            await minter.assertMintable({
                productId: dropId,
                groups: [...groups].map(([variantId, ids]) => ({ variantId, count: ids.length })),
            });

            const units: NonNullable<SupplyBatchResponse['stock']>['units'] = [];
            for (const [variantId, nfcTagIds] of groups) {
                const out = await minter.mintBound(tx, {
                    productId: dropId,
                    groupCode: drop.groupCode,
                    totalSupply: drop.totalSupply,
                    variantId,
                    nfcTagIds,
                    vendorId: batch.vendorId,
                    supplyBatchId: batch.id,
                    provisioningBatchId: batch.batchRef,
                    actorId: context.access.userId,
                });
                units.push({
                    variantId,
                    count: out.minted,
                    firstSerial: out.firstSerial,
                    lastSerial: out.lastSerial,
                });
            }
            const bound = await this.deps.supply.bindChipsToUnits(tx, batch.id);
            const minted = units.reduce((sum, u) => sum + u.count, 0);
            if (bound !== minted) {
                // Every minted unit names its chip; a mismatch means the data
                // moved underneath us. Roll back rather than leave orphans.
                throw new AppError(
                    `Bound ${bound} chips to ${minted} new units — refusing a partial accept.`,
                    500,
                    SUPPLY_ERROR_CODES.ACCEPT_CONFLICT,
                );
            }

            const row = await this.deps.supply.updateBatchWithin(tx, batch.id, data);
            return { row, stock: { minted, units } };
        });
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

        const batch = await this.loadBatch(context.access, batchId);
        return this.applyManifest({
            actorId: context.access.userId,
            actorType: 'HITBOX_ADMIN',
            correlationId: context.correlationId,
            batch,
            dto,
        });
    }

    /**
     * Every line must name a live variant of the consignment's drop. A typo'd
     * or foreign variant id is a 400 naming the row, not a foreign-key error.
     */
    async assertLinesBelongToDrop(
        dropId: string,
        lines: { variantId: string }[],
    ): Promise<void> {
        const variants = await this.deps.supply.findDropVariants(dropId);
        const live = new Set(
            variants.filter((v) => v.isActive && !v.archivedAt).map((v) => v.id),
        );
        const invalid = lines
            .map((line, index) => ({ row: index + 1, variantId: line.variantId }))
            .filter((line) => !live.has(line.variantId));
        if (invalid.length > 0) {
            throw AppError.badRequest(
                'A line names a variant that is not a live variant of this drop.',
                SUPPLY_ERROR_CODES.VARIANT_INVALID,
                { invalid },
            );
        }
    }

    /**
     * Validates and commits a chip manifest against a consignment the caller
     * has already been allowed to reach. Shared by the admin route and the
     * vendor portal; every rule about the rows themselves lives here, once.
     */
    async applyManifest(input: {
        actorId: string;
        actorType: SupplyActorType;
        correlationId: string;
        batch: BatchRow;
        dto: RegisterTagsDto;
    }): Promise<RegisterTagsResult> {
        const { batch, dto } = input;
        const batchId = batch.id;

        const cipher = this.deps.tagCipher;
        if (!cipher) {
            throw new AppError(
                'Chip registration is not configured on this deployment (no tag UID key).',
                503,
                'SUPPLY_TAG_KEY_UNAVAILABLE',
            );
        }

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
        const variantCounts = assertManifestVariants(batch, dto);

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
                lines: batch.lines.map((line) => {
                    const added = variantCounts.get(line.variantId) ?? { received: 0, accepted: 0 };
                    return {
                        variantId: line.variantId,
                        quantity: line.quantity,
                        rowsReceived: line.rowsReceived + added.received,
                        rowsAccepted: line.rowsAccepted + added.accepted,
                        rowsRejected:
                            line.rowsRejected + (added.received - added.accepted),
                    };
                }),
            };
        }

        const sealed: SealedTag[] = hashed.map((tag) => ({
            uidHash: tag.hash,
            uidEncrypted: cipher.encrypt(tag.uid),
            keyReference: cipher.keyReference,
            qcStatus: tag.qcStatus ?? QcStatus.PENDING,
            qcNotes: tag.qcNotes,
            variantId: tag.variantId,
        }));

        let result: Awaited<ReturnType<SupplyRepository['registerTags']>>;
        try {
            result = await this.deps.supply.registerTags({ batchId, tags: sealed });
        } catch (error) {
            // The pre-check above read before this manifest's transaction; a
            // UID registered by a concurrent manifest in between lands here.
            if (isUniqueViolation(error)) {
                throw AppError.conflict(
                    'A tag UID in this manifest was registered by another upload just now. ' +
                    'Dry-run the file again to see which row.',
                    SUPPLY_ERROR_CODES.TAG_UID_TAKEN,
                );
            }
            throw error;
        }

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAGS_REGISTER,
            actorId: input.actorId,
            actorType: input.actorType,
            organizationId: null,
            resourceType: 'SupplyBatch',
            resourceId: batchId,
            result: 'SUCCESS',
            correlationId: input.correlationId,
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
            lines: result.batch.lines.map((line) => ({
                variantId: line.variantId,
                quantity: line.quantity,
                rowsReceived: line.rowsReceived,
                rowsAccepted: line.rowsAccepted,
                rowsRejected: line.rowsRejected,
            })),
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
        lines: row.lines.map((line) => ({
            variantId: line.variantId,
            variantCode: line.variant.variantCode,
            label: line.variant.label,
            quantity: line.quantity,
            rowsReceived: line.rowsReceived,
            rowsAccepted: line.rowsAccepted,
            rowsRejected: line.rowsRejected,
            shortfall: Math.max(0, line.quantity - line.rowsReceived),
        })),
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
        variantId: row.variantId,
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

/**
 * The variant rules for one manifest, checked before anything is hashed into
 * the database:
 *
 *   - a consignment WITH lines: every row names one of its variants, and no
 *     line receives more chips than its quantity;
 *   - a consignment WITHOUT lines: no row names a variant.
 *
 * Returns the per-variant counts the manifest would add.
 */
export function assertManifestVariants(
    batch: Pick<BatchRow, 'lines'>,
    dto: RegisterTagsDto,
): Map<string, { received: number; accepted: number }> {
    const counts = new Map<string, { received: number; accepted: number }>();

    if (batch.lines.length === 0) {
        const rows = dto.tags.flatMap((tag, index) => (tag.variantId ? [index + 1] : []));
        if (rows.length > 0) {
            throw AppError.badRequest(
                'This consignment has no variant lines, so rows must not name a variant.',
                SUPPLY_ERROR_CODES.VARIANT_NOT_IN_BATCH,
                { rows },
            );
        }
        return counts;
    }

    const lines = new Map(batch.lines.map((line) => [line.variantId, line]));
    const missing: number[] = [];
    const foreign: number[] = [];
    dto.tags.forEach((tag, index) => {
        if (!tag.variantId) missing.push(index + 1);
        else if (!lines.has(tag.variantId)) foreign.push(index + 1);
        else {
            const entry = counts.get(tag.variantId) ?? { received: 0, accepted: 0 };
            entry.received += 1;
            if ((tag.qcStatus ?? QcStatus.PENDING) !== QcStatus.FAILED) entry.accepted += 1;
            counts.set(tag.variantId, entry);
        }
    });
    if (missing.length > 0) {
        throw AppError.badRequest(
            'This consignment is split by variant: every row needs a variantId.',
            SUPPLY_ERROR_CODES.VARIANT_REQUIRED,
            { rows: missing },
        );
    }
    if (foreign.length > 0) {
        throw AppError.badRequest(
            "A row names a variant that is not one of this consignment's lines.",
            SUPPLY_ERROR_CODES.VARIANT_NOT_IN_BATCH,
            { rows: foreign },
        );
    }

    const over = [...counts].flatMap(([variantId, added]) => {
        const line = lines.get(variantId)!;
        return line.rowsReceived + added.received > line.quantity
            ? [{
                variantId,
                variantCode: line.variant.variantCode,
                quantity: line.quantity,
                alreadyRegistered: line.rowsReceived,
                requested: added.received,
            }]
            : [];
    });
    if (over.length > 0) {
        throw AppError.conflict(
            'The manifest would put more chips on a variant than its line declares.',
            SUPPLY_ERROR_CODES.LINE_QUANTITY_EXCEEDED,
            { lines: over },
        );
    }
    return counts;
}

/**
 * A consignment is complete when every declared unit has a registered chip —
 * per variant line when it is split, overall otherwise. Chips that failed QC
 * count as registered (they were received) but are not minted into units.
 */
export function assertManifestComplete(batch: Pick<BatchRow, 'lines' | 'quantity' | 'rowsReceived'>): void {
    if (batch.lines.length > 0) {
        const short = batch.lines
            .filter((line) => line.rowsReceived < line.quantity)
            .map((line) => ({
                variantId: line.variantId,
                variantCode: line.variant.variantCode,
                label: line.variant.label,
                quantity: line.quantity,
                registered: line.rowsReceived,
                shortfall: line.quantity - line.rowsReceived,
            }));
        if (short.length > 0) {
            throw AppError.conflict(
                'Not every unit in this consignment has a registered chip yet.',
                SUPPLY_ERROR_CODES.MANIFEST_INCOMPLETE,
                { lines: short },
            );
        }
        return;
    }
    if (batch.rowsReceived < batch.quantity) {
        throw AppError.conflict(
            `Only ${batch.rowsReceived} of ${batch.quantity} units have a registered chip.`,
            SUPPLY_ERROR_CODES.MANIFEST_INCOMPLETE,
            {
                quantity: batch.quantity,
                registered: batch.rowsReceived,
                shortfall: batch.quantity - batch.rowsReceived,
            },
        );
    }
}

/** Attempts before a serial collision on accept becomes a 409. */
const ACCEPT_MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'P2002'
    );
}

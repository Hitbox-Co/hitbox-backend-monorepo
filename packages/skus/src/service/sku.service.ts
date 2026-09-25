import type { Logger } from 'pino';
import { ClaimedStatus, Prisma, TagLifecycleState } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    SKU_AUDIT_EVENTS,
    SKU_EVENTS,
    SKU_MINT_MAX_ATTEMPTS,
    SKUS_ERROR_CODES,
} from '../constants/skus.constant';
import { Visibility, maskEmail, maskId, maskTag } from '../domain/sku-access';
import type { SkuAccess } from '../domain/sku-access';
import { assertFiltersPermitted, searchMayMatchTag } from '../domain/sku-filters';
import {
    assertChangesUsable,
    assertFieldsWritable,
    planSkuUpdate,
} from '../domain/sku-update';
import type { SkuUpdatePlan, SkuUpdateTarget } from '../domain/sku-update';
import type { ISkuAudit } from '../domain/interfaces/sku-audit.interface';
import type {
    BatchUpdateItem,
    BatchUpdateResult,
    BatchUpdateSkusDto,
    BindTagDto,
    BulkBindResult,
    BulkBindTagsDto,
    ListSkusQuery,
    MintResult,
    MintSkusDto,
    SkuChangesDto,
    SkuDetail,
    SkuListItem,
    SkuSummary,
    UpdateSkuDto,
} from '../dto/sku.dto';
import type {
    MintOutcome,
    MintTargetProduct,
    SkuDetailRow,
    SkuRepository,
    SkuRow,
    SkuUpdateRow,
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
    audit: ISkuAudit;
    logger: Logger;
}

/**
 * A write request: who is asking, and which request it belongs to.
 *
 * `correlationId` is carried rather than generated so the audit row for an
 * edit can be joined to the ledger write, the event, and the request log it
 * came from. An audit entry nobody can join to anything is most of the trail's
 * value lost.
 */
export interface SkuMutationContext {
    access: SkuAccess;
    correlationId: string;
}

/** The most refusals named in one batch error before it stops being readable. */
const MAX_REPORTED_PROBLEMS = 20;

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

    // ── Inventory edits ─────────────────────────────────────────────────────

    /**
     * Edits one unit's record.
     *
     * Three gates, in increasing cost: the caller's grants decide which fields
     * they may write at all, the body has to name at least one of them, and
     * only then is the unit loaded and its own state consulted. A caller who
     * may not touch tag custody learns that without a database read.
     *
     * A body that resolves to no change is **not** an error. Re-sending an edit
     * that already landed — a retried request, a form submitted twice — returns
     * the unit unchanged, so the endpoint is safe to retry.
     */
    async update(
        context: SkuMutationContext,
        skuId: string,
        dto: UpdateSkuDto,
    ): Promise<SkuDetail> {
        const { access } = context;
        assertFieldsWritable(dto, access);
        assertChangesUsable(dto);

        const row = await this.deps.skus.findForUpdate(skuId);
        if (!row || !reaches(access, row.drop.organizationId)) {
            throw AppError.notFound('Unit not found', SKUS_ERROR_CODES.NOT_FOUND);
        }

        const now = new Date();
        const outcome = planSkuUpdate(toUpdateTarget(row), dto, now);
        if (!outcome.ok) {
            await this.recordDenial(context, row, dto, `${row.skuCode}: ${outcome.problem}`);
            throw AppError.conflict(
                `${row.skuCode}: ${outcome.problem}`,
                SKUS_ERROR_CODES.UPDATE_REFUSED,
            );
        }

        await this.assertVariantUsable(outcome.plan, row.productId);

        const fields = Object.keys(outcome.plan.patch);
        if (fields.length === 0) return this.getDetail(access, skuId);

        await this.deps.skus.applyUpdates([{ skuId, patch: outcome.plan.patch }], now);

        // Awaited, and allowed to throw. These are the edits a fraud review
        // goes looking for; one that happened with no trail is worse than one
        // that failed loudly.
        await this.deps.audit.record({
            eventType: SKU_AUDIT_EVENTS.UPDATE,
            actorId: access.userId,
            organizationId: row.drop.organizationId,
            skuId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: outcome.plan.before,
            after: outcome.plan.after,
            metadata: {
                skuCode: row.skuCode,
                productId: row.productId,
                ...(dto.reason ? { reason: dto.reason } : {}),
            },
        });

        await this.deps.eventBus.publish(SKU_EVENTS.SKU_UPDATED, {
            skuId,
            skuCode: row.skuCode,
            productId: row.productId,
            fields,
        });

        return this.getDetail(access, skuId);
    }

    /**
     * Applies one set of changes to many units, all or nothing.
     *
     * The shape of this endpoint follows from what an inventory screen does:
     * an operator filters a list, selects rows, and acts on the selection. So
     * it takes one `changes` object and a selector, not a list of per-unit
     * edits — the per-unit case is a tag manifest and already has an endpoint.
     *
     * **Every refusal is reported at once and nothing is written.** A partially
     * applied batch leaves an operator working out which of 800 units took the
     * change, which is not a question the database can answer afterwards. The
     * same reasoning as the tag manifest, for the same reason.
     *
     * Units already in the requested state are counted as `unchanged`, not
     * refused: selecting 200 rows of which 13 are already blocked is ordinary,
     * and failing the whole batch over it would make the endpoint unusable.
     */
    async batchUpdate(
        context: SkuMutationContext,
        productId: string | undefined,
        dto: BatchUpdateSkusDto,
    ): Promise<BatchUpdateResult> {
        const { access } = context;
        assertFieldsWritable(dto.changes, access);
        assertChangesUsable(dto.changes);

        const drop = productId ?? dto.productId;
        const { targets } = dto;
        const bySerial = targets.serialNumbers !== undefined || targets.serialFrom !== undefined;
        if (bySerial && !drop) {
            throw AppError.badRequest(
                'Targeting units by serial number needs a productId — a serial is a ' +
                "position within one drop's edition, not a platform-wide identifier.",
                SKUS_ERROR_CODES.PRODUCT_NOT_FOUND,
            );
        }
        // Resolves reachability and 404s an out-of-scope drop before anything
        // is counted, so a refused caller cannot learn an edition's size.
        if (drop) await this.requireProduct(access, drop);

        const rows = await this.deps.skus.findBatchTargets({
            productId: drop,
            organizationIds: access.organizationIds,
            targets,
        });

        const problems = namedButMissing(targets, rows);
        if (rows.length === 0 && problems.length === 0) {
            throw AppError.notFound(
                'That selection matched no units.',
                SKUS_ERROR_CODES.BATCH_EMPTY,
            );
        }

        const now = new Date();
        const plans: { row: SkuUpdateRow; plan: SkuUpdatePlan }[] = [];
        for (const row of rows) {
            const outcome = planSkuUpdate(toUpdateTarget(row), dto.changes, now);
            if (!outcome.ok) problems.push(`${row.skuCode}: ${outcome.problem}`);
            else plans.push({ row, plan: outcome.plan });
        }

        if (problems.length > 0) {
            await this.recordBatchDenial(context, drop ?? null, dto, problems);
            throw AppError.conflict(
                `Batch rejected, nothing was written. ${summarise(problems)}`,
                SKUS_ERROR_CODES.BATCH_REJECTED,
            );
        }

        // A variant belongs to exactly one product, so a batch setting one has
        // to be confined to that product — otherwise the foreign key would
        // happily attach another drop's variant to these units.
        if (plans[0]) await this.assertVariantUsable(plans[0].plan, plans[0].row.productId);
        if (dto.changes.variantId && new Set(rows.map((row) => row.productId)).size > 1) {
            throw AppError.badRequest(
                'A variant belongs to one drop, so a batch that sets variantId cannot ' +
                'span several. Narrow the selection to one product.',
                SKUS_ERROR_CODES.VARIANT_MISMATCH,
            );
        }

        const writes = plans.filter(({ plan }) => Object.keys(plan.patch).length > 0);
        const items: BatchUpdateItem[] = plans.map(({ row, plan }) => ({
            skuId: row.id,
            skuCode: row.skuCode,
            serialNumber: row.serialNumber,
            changed: Object.keys(plan.patch),
        }));

        const result: BatchUpdateResult = {
            productId: drop ?? null,
            requested: countRequested(targets),
            matched: rows.length,
            changed: writes.length,
            unchanged: plans.length - writes.length,
            dryRun: dto.dryRun,
            items,
        };

        if (dto.dryRun || writes.length === 0) return result;

        await this.deps.skus.applyUpdates(
            writes.map(({ row, plan }) => ({ skuId: row.id, patch: plan.patch })),
            now,
        );

        await this.deps.audit.record({
            eventType: SKU_AUDIT_EVENTS.BATCH_UPDATE,
            actorId: access.userId,
            organizationId: writes[0]?.row.drop.organizationId ?? null,
            skuId: null,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            // Field names, not per-unit values: a thousand before/after pairs
            // would bury the one fact a review needs, which is what changed and
            // on which units.
            after: { changes: dto.changes as Record<string, unknown> },
            metadata: {
                productId: drop ?? null,
                matched: result.matched,
                changed: result.changed,
                unchanged: result.unchanged,
                skuIds: writes.map(({ row }) => row.id),
                ...(dto.changes.reason ? { reason: dto.changes.reason } : {}),
            },
        });

        await this.deps.eventBus.publish(SKU_EVENTS.SKUS_BATCH_UPDATED, {
            productId: drop ?? null,
            changed: result.changed,
            fields: [...new Set(writes.flatMap(({ plan }) => Object.keys(plan.patch)))],
        });

        return result;
    }

    /** Confirms a newly attached variant belongs to the unit's own drop. */
    private async assertVariantUsable(plan: SkuUpdatePlan, productId: string): Promise<void> {
        if (!plan.variantToVerify) return;
        if (await this.deps.skus.variantBelongsTo(plan.variantToVerify, productId)) return;
        throw AppError.badRequest(
            'variantId does not belong to this product',
            SKUS_ERROR_CODES.VARIANT_MISMATCH,
        );
    }

    private recordDenial(
        context: SkuMutationContext,
        row: SkuUpdateRow,
        changes: SkuChangesDto,
        problem: string,
    ): Promise<void> {
        return this.deps.audit.record({
            eventType: SKU_AUDIT_EVENTS.UPDATE,
            actorId: context.access.userId,
            organizationId: row.drop.organizationId,
            skuId: row.id,
            result: 'DENIED',
            correlationId: context.correlationId,
            metadata: { skuCode: row.skuCode, problem, attempted: changes as Record<string, unknown> },
        });
    }

    private recordBatchDenial(
        context: SkuMutationContext,
        productId: string | null,
        dto: BatchUpdateSkusDto,
        problems: string[],
    ): Promise<void> {
        return this.deps.audit.record({
            eventType: SKU_AUDIT_EVENTS.BATCH_UPDATE,
            actorId: context.access.userId,
            organizationId: null,
            skuId: null,
            result: 'DENIED',
            correlationId: context.correlationId,
            metadata: {
                productId,
                problems: problems.slice(0, MAX_REPORTED_PROBLEMS),
                problemCount: problems.length,
                attempted: dto.changes as Record<string, unknown>,
            },
        });
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
        // Filtering a column is a read of it: a caller who is not shown tag
        // UIDs may not ask yes/no questions about one either.
        assertFiltersPermitted(query as unknown as Record<string, unknown>, access);

        const { total, items } = await this.deps.skus.list({
            productId,
            organizationIds: access.organizationIds,
            query,
            allowTagSearch: searchMayMatchTag(access),
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
        if (!row || !reaches(access, row.drop.organizationId)) {
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
            updatedAt: row.updatedAt.toISOString(),
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
                // Provisioning provenance identifies the consignment a UID came
                // from, so it travels with the UID's own visibility rather than
                // with the fact that a tag exists.
                ...(full
                    ? {
                        lastTapCounter: row.lastTapCounter,
                        vendorId: row.vendorId,
                        provisioningBatchId: row.provisioningBatchId,
                        vendorAuthenticatedAt: row.vendorAuthenticatedAt?.toISOString() ?? null,
                    }
                    : {}),
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
                productId: row.drop.id,
                groupCode: row.drop.groupCode,
                name: row.drop.name,
                organizationId: row.drop.organizationId,
                status: row.drop.status,
                totalSupply: row.drop.totalSupply,
            },
        };

        if (access.tag) {
            const history = row.skuHistories[0];
            detail.provenance = {
                claimCount: row._count.skuClaims,
                ledgerEntries: row._count.blockchainLedgers,
                firstClaimedAt: row.skuClaims[0]?.claimedAt.toISOString() ?? null,
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

/** The update rules read the unit alone; the product relation is not theirs. */
function toUpdateTarget(row: SkuUpdateRow): SkuUpdateTarget {
    const { drop: _drop, ...unit } = row;
    return unit;
}

/**
 * Targets the caller named by hand that did not resolve to a unit.
 *
 * A serial *range* is exempt: `#401–500` over an edition that only reached 460
 * is a perfectly ordinary way to say "the tail of this drop", and refusing it
 * would make the range selector useless for exactly the case it exists for. An
 * explicitly listed id, code or serial that is not there is an operator
 * mistake, and is reported as one.
 */
function namedButMissing(targets: BatchUpdateSkusDto['targets'], rows: SkuUpdateRow[]): string[] {
    if (targets.skuIds) {
        const found = new Set(rows.map((row) => row.id));
        return targets.skuIds.filter((id) => !found.has(id)).map((id) => `${id}: no such unit`);
    }
    if (targets.skuCodes) {
        const found = new Set(rows.map((row) => row.skuCode));
        return targets.skuCodes
            .filter((code) => !found.has(code))
            .map((code) => `${code}: no such unit`);
    }
    if (targets.serialNumbers) {
        const found = new Set(rows.map((row) => row.serialNumber));
        return targets.serialNumbers
            .filter((serial) => !found.has(serial))
            .map((serial) => `#${serial}: not a unit of this drop`);
    }
    return [];
}

/** How many units the selector named, before anything was looked up. */
function countRequested(targets: BatchUpdateSkusDto['targets']): number {
    if (targets.skuIds) return targets.skuIds.length;
    if (targets.skuCodes) return targets.skuCodes.length;
    if (targets.serialNumbers) return targets.serialNumbers.length;
    if (targets.serialFrom !== undefined && targets.serialTo !== undefined) {
        return targets.serialTo - targets.serialFrom + 1;
    }
    /* c8 ignore next */
    return 0;
}

/** The first few refusals plus a count — a 400-line message helps nobody. */
function summarise(problems: string[]): string {
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).join('; ');
    const rest = problems.length > MAX_REPORTED_PROBLEMS
        ? ` (and ${problems.length - MAX_REPORTED_PROBLEMS} more)`
        : '';
    return `${shown}${rest}`;
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

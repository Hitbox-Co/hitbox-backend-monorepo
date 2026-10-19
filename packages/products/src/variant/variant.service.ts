import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    PRODUCT_EVENTS,
    PRODUCTS_ERROR_CODES,
    VARIANT_EDITABLE_STATUSES,
    VARIANT_GENERATE_MAX,
} from '../constants/products.constant';
import { toRuleType } from '../drop-type/drop-type.repository';
import {
    buildLegacyPair,
    buildOptionsKey,
    buildVariantCode,
    buildVariantLabel,
    cartesian,
    combinationCount,
    pruneForbidden,
    resolveOptions,
    type OptionInput,
    type OptionProblem,
    type ResolvedOption,
    type RuleType,
} from '../drop-type/rules';
import type { CreateVariantsDto, GenerateVariantsDto, UpdateVariantDto } from './variant.dto';
import type { DropForVariants, NewVariant, VariantRepository, VariantRow } from './variant.repository';

/** A variant as the API returns it. */
export interface VariantResponse {
    id: string;
    publicCode: string | null;
    variantCode: string;
    label: string;
    options: {
        dimension: string;
        dimensionLabel: string;
        value: string;
        label: string;
        hexCode: string | null;
    }[];
    /** Kept for existing clients — "size/color". */
    optionName: string;
    /** Kept for existing clients — "M/BLK". */
    optionValue: string;
    position: number;
    totalSupply: number | null;
    mintedUnits: number;
    isActive: boolean;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
}

export function toVariantResponse(row: VariantRow): VariantResponse {
    return {
        id: row.id,
        publicCode: row.publicCode,
        variantCode: row.variantCode,
        label: row.label,
        options: row.options.map((o) => ({
            dimension: o.dimensionCode,
            dimensionLabel: o.dimensionLabel,
            value: o.valueCode,
            label: o.valueLabel,
            hexCode: o.hexCode,
        })),
        optionName: row.optionName,
        optionValue: row.optionValue,
        position: row.position,
        totalSupply: row.totalSupply,
        mintedUnits: row._count.skus,
        isActive: row.isActive,
        archived: row.archivedAt !== null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** A variant that would be (or was) created, before it has an id. */
export interface VariantPreview {
    variantCode: string;
    label: string;
    options: { dimension: string; value: string; label: string; hexCode: string | null }[];
    totalSupply: number | null;
}

export interface GenerateVariantsResult {
    dryRun: boolean;
    /** New variants — previews on a dry run, real rows otherwise. */
    created: (VariantPreview | VariantResponse)[];
    /** Archived variants brought back because the combination was asked for again. */
    revived: string[];
    /** Combinations the drop already has (active). Re-running generate is safe. */
    existing: string[];
    /** Combinations the type's rules refuse, with why. */
    skipped: { options: Record<string, string>; problems: OptionProblem[] }[];
}

interface VariantServiceDeps {
    variants: VariantRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/** A candidate after validation, before codes are assigned. */
interface Candidate {
    options: ResolvedOption[];
    key: string;
    label: string | null;
    position: number | null;
    totalSupply: number | null;
}

/**
 * A drop's variants — the sellable options ("business SKUs"), not the
 * serialized `Sku` units, which the skus module mints per variant later.
 *
 * The rules, in one place:
 *  - the drop must have a type, and the type must allow variants;
 *  - options are validated by the type's rule engine (drop-type/rules.ts);
 *  - the same combination twice is refused — in one request, and by the
 *    `(productId, optionsKey)` unique index across requests;
 *  - variants are added / removed only in DRAFT or REJECTED, because the
 *    owner approves the drop *with* its variants;
 *  - capped variant supplies never add up past the drop's totalSupply.
 *
 * docs/admin/drop-types-and-variants.md §7.
 */
export class VariantService {
    constructor(private readonly deps: VariantServiceDeps) { }

    async list(dropId: string, includeArchived: boolean): Promise<VariantResponse[]> {
        await this.requireDrop(dropId);
        const rows = await this.deps.variants.list(dropId, includeArchived);
        return rows.map(toVariantResponse);
    }

    /** Explicit list — all-or-nothing. */
    async create(dropId: string, dto: CreateVariantsDto): Promise<VariantResponse[]> {
        const { drop, type, version } = await this.requireEditableTypedDrop(dropId);

        const problems: (OptionProblem & { index: number })[] = [];
        const candidates: Candidate[] = [];
        dto.variants.forEach((input, index) => {
            const result = resolveOptions(type, input.options as Record<string, OptionInput>);
            if (!result.ok) {
                problems.push(...result.problems.map((p) => ({ ...p, index })));
                return;
            }
            candidates.push({
                options: result.options,
                key: buildOptionsKey(result.options),
                label: input.label ?? null,
                position: input.position ?? null,
                totalSupply: input.totalSupply ?? null,
            });
        });
        if (problems.length > 0) {
            throw AppError.badRequest(
                'One or more variants break the rules of this drop type.',
                PRODUCTS_ERROR_CODES.VARIANT_INVALID_OPTIONS,
                { dropType: type.code, problems },
            );
        }

        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (seen.has(candidate.key)) {
                throw AppError.conflict(
                    `The same combination appears twice in this request: ${buildVariantLabel(candidate.options)}.`,
                    PRODUCTS_ERROR_CODES.VARIANT_DUPLICATE,
                    { optionsKey: candidate.key },
                );
            }
            seen.add(candidate.key);
        }

        const existing = await this.deps.variants.findByKeys(drop.id, [...seen]);
        const active = existing.filter((row) => row.archivedAt === null);
        if (active.length > 0) {
            throw AppError.conflict(
                `This drop already has: ${active.map((row) => row.variantCode).join(', ')}.`,
                PRODUCTS_ERROR_CODES.VARIANT_DUPLICATE,
                { existing: active.map((row) => row.variantCode) },
            );
        }
        const revive = existing.filter((row) => row.archivedAt !== null);
        const reviveKeys = new Set(revive.map((row) => row.optionsKey));
        const fresh = candidates.filter((c) => !reviveKeys.has(c.key));

        await this.assertSupply(drop, [
            ...fresh.map((c) => c.totalSupply),
            ...revive.map((row) => row.totalSupply),
        ]);

        const planned = await this.plan(drop, type, fresh);
        const rows = await this.deps.variants.createMany(drop, version, planned, revive.map((row) => row.id));
        await this.publishCreated(drop.id, rows);
        return rows.map(toVariantResponse);
    }

    /** Every combination of the chosen values, minus what the rules forbid. */
    async generate(dropId: string, dto: GenerateVariantsDto): Promise<GenerateVariantsResult> {
        const { drop, type, version } = await this.requireEditableTypedDrop(dropId);
        const select = dto.select as Record<string, OptionInput[]>;

        const total = combinationCount(select);
        if (total > VARIANT_GENERATE_MAX) {
            throw AppError.badRequest(
                `That selection makes ${total} combinations; one call may make at most ` +
                `${VARIANT_GENERATE_MAX}. Split it — for example one color group per call.`,
                PRODUCTS_ERROR_CODES.VARIANT_GENERATE_TOO_LARGE,
                { combinations: total, max: VARIANT_GENERATE_MAX },
            );
        }

        const skipped: GenerateVariantsResult['skipped'] = [];
        const byKey = new Map<string, Candidate>();
        for (const combo of cartesian(select)) {
            // A forbidden dimension is dropped from the combination, not
            // refused: SINGLE × packSize 5 is simply SINGLE.
            const pruned = pruneForbidden(type, combo);
            const result = resolveOptions(type, pruned);
            if (!result.ok) {
                skipped.push({ options: flatten(pruned), problems: result.problems });
                continue;
            }
            const key = buildOptionsKey(result.options);
            if (!byKey.has(key)) {
                byKey.set(key, {
                    options: result.options,
                    key,
                    label: null,
                    position: null,
                    totalSupply: dto.totalSupplyEach ?? null,
                });
            }
        }

        const existing = await this.deps.variants.findByKeys(drop.id, [...byKey.keys()]);
        const active = existing.filter((row) => row.archivedAt === null);
        const revive = existing.filter((row) => row.archivedAt !== null);
        const known = new Set(existing.map((row) => row.optionsKey));
        const fresh = [...byKey.values()].filter((c) => !known.has(c.key));

        await this.assertSupply(drop, [
            ...fresh.map((c) => c.totalSupply),
            ...revive.map((row) => row.totalSupply),
        ]);

        const planned = await this.plan(drop, type, fresh);
        const base = {
            revived: revive.map((row) => row.variantCode),
            existing: active.map((row) => row.variantCode),
            skipped,
        };

        if (dto.dryRun) {
            return { dryRun: true, created: planned.map(toPreview), ...base };
        }
        if (planned.length === 0 && revive.length === 0) {
            return { dryRun: false, created: [], ...base };
        }
        const rows = await this.deps.variants.createMany(drop, version, planned, revive.map((row) => row.id));
        await this.publishCreated(drop.id, rows);
        const reviveIds = new Set(revive.map((row) => row.id));
        return {
            dryRun: false,
            created: rows.filter((row) => !reviveIds.has(row.id)).map(toVariantResponse),
            ...base,
        };
    }

    /**
     * Label, position, supply and active flag. Allowed in any status — none
     * of these changes WHAT the variant is, only how it is shown and stocked.
     */
    async update(dropId: string, variantId: string, dto: UpdateVariantDto): Promise<VariantResponse> {
        const drop = await this.requireDrop(dropId);
        const variant = await this.requireVariant(drop.id, variantId);
        if (variant.archivedAt !== null) {
            throw AppError.badRequest(
                'This variant is archived. Ask for the same combination again (create or generate) to restore it.',
                PRODUCTS_ERROR_CODES.VARIANT_INACTIVE,
            );
        }

        if (dto.totalSupply !== undefined && dto.totalSupply !== null) {
            if (dto.totalSupply < variant._count.skus) {
                throw AppError.badRequest(
                    `${variant._count.skus} units of ${variant.variantCode} are already minted; ` +
                    'its supply cannot go below that.',
                    PRODUCTS_ERROR_CODES.VARIANT_SUPPLY_EXCEEDED,
                );
            }
            if (drop.totalSupply > 0) {
                const others = await this.deps.variants.cappedSupply(drop.id, variant.id);
                if (others + dto.totalSupply > drop.totalSupply) {
                    throw AppError.badRequest(
                        `Variant supplies would total ${others + dto.totalSupply}, more than the drop's ${drop.totalSupply}.`,
                        PRODUCTS_ERROR_CODES.VARIANT_SUPPLY_EXCEEDED,
                    );
                }
            }
        }

        const row = await this.deps.variants.update(drop, variant.id, {
            ...(dto.label !== undefined && { label: dto.label }),
            ...(dto.position !== undefined && { position: dto.position }),
            ...(dto.totalSupply !== undefined && { totalSupply: dto.totalSupply }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        });
        await this.deps.eventBus.publish(PRODUCT_EVENTS.VARIANT_UPDATED, {
            productId: drop.id,
            variantId: row.id,
        });
        return toVariantResponse(row);
    }

    /**
     * Removes a variant. Deleted outright when nothing points at it; archived
     * when units, prices, orders or wishlists do — those records must keep
     * meaning what they meant.
     */
    async remove(
        dropId: string,
        variantId: string,
    ): Promise<{ outcome: 'deleted' | 'archived'; variant: VariantResponse | null }> {
        const drop = await this.requireDrop(dropId);
        this.assertEditable(drop);
        const variant = await this.requireVariant(drop.id, variantId);

        const refs = await this.deps.variants.references(variant.id);
        const referenced = refs.skus + refs.prices + refs.orders + refs.wishlists > 0;

        if (!referenced) {
            await this.deps.variants.delete(drop, variant.id);
            await this.deps.eventBus.publish(PRODUCT_EVENTS.VARIANT_ARCHIVED, {
                productId: drop.id,
                variantId: variant.id,
                deleted: true,
            });
            return { outcome: 'deleted', variant: null };
        }
        const row = await this.deps.variants.archive(drop, variant.id);
        await this.deps.eventBus.publish(PRODUCT_EVENTS.VARIANT_ARCHIVED, {
            productId: drop.id,
            variantId: variant.id,
            deleted: false,
        });
        return { outcome: 'archived', variant: toVariantResponse(row) };
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private async requireDrop(dropId: string): Promise<DropForVariants> {
        const drop = await this.deps.variants.findDrop(dropId);
        if (!drop) {
            throw AppError.notFound('Product not found', PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        return drop;
    }

    private async requireVariant(dropId: string, variantId: string): Promise<VariantRow> {
        const variant = await this.deps.variants.find(dropId, variantId);
        if (!variant) {
            throw AppError.notFound('Variant not found on this drop.', PRODUCTS_ERROR_CODES.VARIANT_NOT_FOUND);
        }
        return variant;
    }

    private assertEditable(drop: DropForVariants): void {
        if (drop.archivedAt !== null) {
            throw AppError.conflict('This drop is archived.', PRODUCTS_ERROR_CODES.DROP_NOT_EDITABLE);
        }
        if (!(VARIANT_EDITABLE_STATUSES as readonly string[]).includes(drop.status)) {
            throw AppError.conflict(
                `Variants can be added or removed only while the drop is DRAFT or REJECTED; it is ${drop.status}. ` +
                'The owner approves a drop together with its variants. To change them, reject the review ' +
                '(POST /admin/releases/:approvalId/decision), edit the variants, then submit again.',
                PRODUCTS_ERROR_CODES.DROP_NOT_EDITABLE,
                { status: drop.status },
            );
        }
    }

    private async requireEditableTypedDrop(
        dropId: string,
    ): Promise<{ drop: DropForVariants; type: RuleType; version: number }> {
        const drop = await this.requireDrop(dropId);
        if (!drop.dropType) {
            throw AppError.badRequest(
                'This drop has no drop type, so its variants have no rules. ' +
                'Set `dropType` with PATCH /admin/products/:id first.',
                PRODUCTS_ERROR_CODES.DROP_TYPE_REQUIRED,
            );
        }
        if (drop.dropType.variantMode === 'NONE') {
            throw AppError.badRequest(
                `A ${drop.dropType.name} has no variants — the drop itself is the one sellable item.`,
                PRODUCTS_ERROR_CODES.VARIANTS_NOT_ALLOWED,
            );
        }
        this.assertEditable(drop);
        return { drop, type: toRuleType(drop.dropType), version: drop.dropType.version };
    }

    /** Capped variant supplies may not add up past the drop's own. */
    private async assertSupply(drop: DropForVariants, adding: (number | null)[]): Promise<void> {
        if (drop.totalSupply <= 0) return;
        const extra = adding.reduce<number>((sum, n) => sum + (n ?? 0), 0);
        if (extra === 0) return;
        const current = await this.deps.variants.cappedSupply(drop.id);
        if (current + extra > drop.totalSupply) {
            throw AppError.badRequest(
                `Variant supplies would total ${current + extra}, more than the drop's ${drop.totalSupply}.`,
                PRODUCTS_ERROR_CODES.VARIANT_SUPPLY_EXCEEDED,
                { current, adding: extra, dropTotalSupply: drop.totalSupply },
            );
        }
    }

    /** Assigns codes, labels and positions. Codes are unique platform-wide. */
    private async plan(drop: DropForVariants, type: RuleType, candidates: Candidate[]): Promise<NewVariant[]> {
        if (candidates.length === 0) return [];
        const base = candidates.map((c) => buildVariantCode(type.variantCodePattern, drop.groupCode, c.options));
        const taken = await this.deps.variants.takenCodes(base);
        const used = new Set<string>();
        let position = (await this.deps.variants.maxPosition(drop.id)) + 1;

        return candidates.map((candidate, index) => {
            // Two different combinations can only spell the same code if
            // optional dimensions share value codes; suffix rather than fail.
            let code = base[index]!;
            for (let n = 2; taken.has(code) || used.has(code); n += 1) code = `${base[index]}-${n}`;
            used.add(code);
            return {
                variantCode: code,
                label: candidate.label ?? buildVariantLabel(candidate.options),
                ...buildLegacyPair(candidate.options),
                optionsKey: candidate.key,
                position: candidate.position ?? position++,
                totalSupply: candidate.totalSupply,
                options: candidate.options,
            };
        });
    }

    private async publishCreated(productId: string, rows: VariantRow[]): Promise<void> {
        if (rows.length === 0) return;
        await this.deps.eventBus.publish(PRODUCT_EVENTS.VARIANT_CREATED, {
            productId,
            variantIds: rows.map((row) => row.id),
        });
    }
}

function toPreview(variant: NewVariant): VariantPreview {
    return {
        variantCode: variant.variantCode,
        label: variant.label,
        options: variant.options.map((o) => ({
            dimension: o.dimensionCode,
            value: o.valueCode,
            label: o.valueLabel,
            hexCode: o.hexCode,
        })),
        totalSupply: variant.totalSupply,
    };
}

function flatten(options: Record<string, OptionInput>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(options).map(([d, v]) => [d, typeof v === 'object' && v !== null ? v.code : String(v)]),
    );
}

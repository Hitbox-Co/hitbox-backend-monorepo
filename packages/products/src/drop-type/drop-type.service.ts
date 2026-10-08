import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import { PRODUCT_EVENTS, PRODUCTS_ERROR_CODES } from '../constants/products.constant';
import type {
    CreateDropTypeDto,
    DimensionInput,
    DimensionValueInput,
    UpdateDimensionDto,
    UpdateDimensionValueDto,
    UpdateDropTypeDto,
} from './drop-type.dto';
import type { DropTypeRepository, DropTypeRow } from './drop-type.repository';
import {
    DEFAULT_VARIANT_CODE_PATTERN,
    dropTypeRulesSchema,
    type DropTypeRule,
    validateRulesAgainst,
} from './rules';

/** A drop type as the API returns it. */
export interface DropTypeResponse {
    id: string;
    publicCode: string | null;
    code: string;
    name: string;
    description: string | null;
    variantMode: string;
    variantCodePattern: string;
    version: number;
    isActive: boolean;
    rules: DropTypeRule[];
    dimensions: {
        code: string;
        label: string;
        position: number;
        required: boolean;
        allowCustomValues: boolean;
        displayType: string;
        archived: boolean;
        values: { code: string; label: string; hexCode: string | null; position: number; archived: boolean }[];
    }[];
    createdAt: string;
    updatedAt: string;
}

export function toDropTypeResponse(row: DropTypeRow, includeArchived = true): DropTypeResponse {
    return {
        id: row.id,
        publicCode: row.publicCode,
        code: row.code,
        name: row.name,
        description: row.description,
        variantMode: row.variantMode,
        variantCodePattern: row.variantCodePattern,
        version: row.version,
        isActive: row.isActive,
        rules: dropTypeRulesSchema.safeParse(row.rules).data ?? [],
        dimensions: row.dimensions
            .filter((d) => includeArchived || d.archivedAt === null)
            .map((d) => ({
                code: d.code,
                label: d.label,
                position: d.position,
                required: d.required,
                allowCustomValues: d.allowCustomValues,
                displayType: d.displayType,
                archived: d.archivedAt !== null,
                values: d.values
                    .filter((v) => includeArchived || v.archivedAt === null)
                    .map((v) => ({
                        code: v.code,
                        label: v.label,
                        hexCode: v.hexCode,
                        position: v.position,
                        archived: v.archivedAt !== null,
                    })),
            })),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

interface DropTypeServiceDeps {
    dropTypes: DropTypeRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/**
 * Drop-type administration. A type is shared by every drop that uses it, so
 * the rules here are about not breaking drops that already exist:
 *
 *  - adding values or optional dimensions is always fine;
 *  - archiving hides a value/dimension from NEW variants, existing ones keep it;
 *  - anything that changes which variants are valid bumps `version`, and
 *    existing drops are never re-checked against the new rules;
 *  - `variantMode` cannot change once any drop uses the type.
 *
 * docs/admin/drop-types-and-variants.md §7.6.
 */
export class DropTypeService {
    constructor(private readonly deps: DropTypeServiceDeps) { }

    async list(includeInactive: boolean): Promise<DropTypeResponse[]> {
        const rows = await this.deps.dropTypes.list(includeInactive);
        // The picker wants only what can be used today.
        return rows.map((row) => toDropTypeResponse(row, includeInactive));
    }

    async get(code: string): Promise<DropTypeResponse & { dropCount: number }> {
        const row = await this.require(code);
        return { ...toDropTypeResponse(row), dropCount: await this.deps.dropTypes.countDrops(row.id) };
    }

    async create(dto: CreateDropTypeDto): Promise<DropTypeResponse> {
        for (const dimension of dto.dimensions) this.assertHexAllowed(dimension);
        this.assertRules(dto.dimensions.map((d) => d.code), dto.rules);

        try {
            const row = await this.deps.dropTypes.create({
                code: dto.code,
                name: dto.name,
                description: dto.description ?? null,
                variantMode: dto.variantMode,
                variantCodePattern: dto.variantCodePattern ?? DEFAULT_VARIANT_CODE_PATTERN,
                rules: dto.rules,
                dimensions: dto.dimensions,
            });
            await this.deps.eventBus.publish(PRODUCT_EVENTS.DROP_TYPE_CREATED, { code: row.code });
            return toDropTypeResponse(row);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw AppError.conflict(
                    `A drop type with code ${dto.code} already exists.`,
                    PRODUCTS_ERROR_CODES.DROP_TYPE_CODE_TAKEN,
                );
            }
            throw error;
        }
    }

    async update(code: string, dto: UpdateDropTypeDto): Promise<DropTypeResponse> {
        const row = await this.require(code);

        if (dto.variantMode !== undefined && dto.variantMode !== row.variantMode) {
            const inUse = await this.deps.dropTypes.countDrops(row.id);
            if (inUse > 0) {
                throw AppError.conflict(
                    `${row.code} is used by ${inUse} drop(s), so its variantMode cannot change. ` +
                    'Create a new type instead.',
                    PRODUCTS_ERROR_CODES.DROP_TYPE_LOCKED,
                );
            }
            if (dto.variantMode === 'NONE' && row.dimensions.some((d) => d.archivedAt === null)) {
                throw AppError.badRequest(
                    'A NONE type has no variants — archive its dimensions first.',
                    PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
                );
            }
        }
        if (dto.rules !== undefined) {
            this.assertRules(activeDimensionCodes(row), dto.rules);
        }

        const bump =
            dto.rules !== undefined ||
            (dto.variantMode !== undefined && dto.variantMode !== row.variantMode) ||
            (dto.variantCodePattern !== undefined && dto.variantCodePattern !== row.variantCodePattern);

        const updated = await this.deps.dropTypes.update(
            row.id,
            {
                ...(dto.name !== undefined && { name: dto.name }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.variantMode !== undefined && { variantMode: dto.variantMode }),
                ...(dto.variantCodePattern !== undefined && { variantCodePattern: dto.variantCodePattern }),
                ...(dto.rules !== undefined && { rules: dto.rules as Prisma.InputJsonValue }),
                ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            },
            bump,
        );
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    // ── Dimensions ──────────────────────────────────────────────────────────

    async addDimension(code: string, input: DimensionInput): Promise<DropTypeResponse> {
        const row = await this.require(code);
        if (row.variantMode === 'NONE') {
            throw AppError.badRequest(
                `${row.code} has variantMode NONE, so it takes no dimensions.`,
                PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
            );
        }
        this.assertHexAllowed(input);
        if (row.dimensions.some((d) => d.code === input.code)) {
            throw AppError.conflict(
                `${row.code} already has a dimension "${input.code}" (archived dimensions count — restore it instead).`,
                PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
            );
        }
        const position = Math.max(-1, ...row.dimensions.map((d) => d.position)) + 1;
        const updated = await this.deps.dropTypes.addDimension(row.id, input, position);
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    async updateDimension(code: string, dimensionCode: string, dto: UpdateDimensionDto): Promise<DropTypeResponse> {
        const row = await this.require(code);
        const dimension = this.requireDimension(row, dimensionCode);
        const updated = await this.deps.dropTypes.updateDimension(row.id, dimension.id, {
            ...(dto.label !== undefined && { label: dto.label }),
            ...(dto.required !== undefined && { required: dto.required }),
            ...(dto.allowCustomValues !== undefined && { allowCustomValues: dto.allowCustomValues }),
            ...(dto.displayType !== undefined && { displayType: dto.displayType }),
            ...(dto.position !== undefined && { position: dto.position }),
        });
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    async setDimensionArchived(code: string, dimensionCode: string, archived: boolean): Promise<DropTypeResponse> {
        const row = await this.require(code);
        const dimension = this.requireDimension(row, dimensionCode);
        if (archived) {
            const rules = dropTypeRulesSchema.safeParse(row.rules).data ?? [];
            const stillValid = validateRulesAgainst(
                activeDimensionCodes(row).filter((d) => d !== dimensionCode),
                rules,
            );
            if (stillValid.length > 0) {
                throw AppError.badRequest(
                    `Rules still name "${dimensionCode}" — remove them from the type's rules first.`,
                    PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
                    { problems: stillValid },
                );
            }
        }
        const updated = await this.deps.dropTypes.setDimensionArchived(row.id, dimension.id, archived);
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    // ── Values ──────────────────────────────────────────────────────────────

    async addValue(code: string, dimensionCode: string, input: DimensionValueInput): Promise<DropTypeResponse> {
        const row = await this.require(code);
        const dimension = this.requireDimension(row, dimensionCode);
        this.assertHexAllowed({ ...dimension, values: [input] });
        if (dimension.values.some((v) => v.code === input.code)) {
            throw AppError.conflict(
                `${dimension.label} already has the value "${input.code}" (archived values count — restore it instead).`,
                PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
            );
        }
        const position = Math.max(-1, ...dimension.values.map((v) => v.position)) + 1;
        const updated = await this.deps.dropTypes.addValue(row.id, dimension.id, input, position);
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    async updateValue(
        code: string,
        dimensionCode: string,
        valueCode: string,
        dto: UpdateDimensionValueDto,
    ): Promise<DropTypeResponse> {
        const row = await this.require(code);
        const dimension = this.requireDimension(row, dimensionCode);
        const value = this.requireValue(dimension, valueCode);
        if (dto.hexCode) this.assertHexAllowed({ ...dimension, values: [{ hexCode: dto.hexCode }] });
        const updated = await this.deps.dropTypes.updateValue(row.id, value.id, {
            ...(dto.label !== undefined && { label: dto.label }),
            ...(dto.hexCode !== undefined && { hexCode: dto.hexCode }),
            ...(dto.position !== undefined && { position: dto.position }),
        });
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    async setValueArchived(
        code: string,
        dimensionCode: string,
        valueCode: string,
        archived: boolean,
    ): Promise<DropTypeResponse> {
        const row = await this.require(code);
        const dimension = this.requireDimension(row, dimensionCode);
        const value = this.requireValue(dimension, valueCode);
        const updated = await this.deps.dropTypes.setValueArchived(row.id, value.id, archived);
        await this.published(updated);
        return toDropTypeResponse(updated);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** Active types only for drop creation; this one is for administration. */
    private async require(code: string): Promise<DropTypeRow> {
        const row = await this.deps.dropTypes.findByCode(code.trim().toUpperCase());
        if (!row) {
            throw AppError.notFound(`Drop type ${code} not found.`, PRODUCTS_ERROR_CODES.DROP_TYPE_NOT_FOUND);
        }
        return row;
    }

    private requireDimension(row: DropTypeRow, dimensionCode: string) {
        const dimension = row.dimensions.find((d) => d.code === dimensionCode);
        if (!dimension) {
            throw AppError.notFound(
                `${row.code} has no dimension "${dimensionCode}".`,
                PRODUCTS_ERROR_CODES.DIMENSION_NOT_FOUND,
            );
        }
        return dimension;
    }

    private requireValue(dimension: DropTypeRow['dimensions'][number], valueCode: string) {
        const code = valueCode.trim().toUpperCase();
        const value = dimension.values.find((v) => v.code === code);
        if (!value) {
            throw AppError.notFound(
                `${dimension.label} has no value "${code}".`,
                PRODUCTS_ERROR_CODES.DIMENSION_VALUE_NOT_FOUND,
            );
        }
        return value;
    }

    /** Hex codes belong to COLOR dimensions only. */
    private assertHexAllowed(dimension: {
        code: string;
        displayType: string;
        values: { hexCode?: string | null | undefined }[];
    }): void {
        if (dimension.displayType === 'COLOR') return;
        if (dimension.values.some((v) => v.hexCode)) {
            throw AppError.badRequest(
                `"${dimension.code}" is not a COLOR dimension, so its values take no hexCode. ` +
                'Set displayType: "COLOR" to use swatches.',
                PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
            );
        }
    }

    private assertRules(dimensionCodes: string[], rules: DropTypeRule[]): void {
        const problems = validateRulesAgainst(dimensionCodes, rules);
        if (problems.length > 0) {
            throw AppError.badRequest(
                'The type\'s rules name dimensions it does not have.',
                PRODUCTS_ERROR_CODES.DROP_TYPE_INVALID,
                { problems },
            );
        }
    }

    private async published(row: DropTypeRow): Promise<void> {
        await this.deps.eventBus.publish(PRODUCT_EVENTS.DROP_TYPE_UPDATED, {
            code: row.code,
            version: row.version,
        });
    }
}

function activeDimensionCodes(row: DropTypeRow): string[] {
    return row.dimensions.filter((d) => d.archivedAt === null).map((d) => d.code);
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

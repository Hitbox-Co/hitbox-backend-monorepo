import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@hitbox/database';
import type { DimensionInput, DimensionValueInput } from './drop-type.dto';
import { dropTypeRulesSchema, type RuleType } from './rules';

/**
 * Persistence for drop types. The only file in the drop-type feature that
 * touches Prisma.
 *
 * Archived dimensions and values are always loaded: existing variants may
 * still reference them, and the rule engine needs to know they are archived
 * in order to refuse them for NEW variants.
 */
export const dropTypeInclude = {
    dimensions: {
        orderBy: [{ position: 'asc' }, { code: 'asc' }],
        include: { values: { orderBy: [{ position: 'asc' }, { code: 'asc' }] } },
    },
} satisfies Prisma.DropTypeInclude;

export type DropTypeRow = Prisma.DropTypeGetPayload<{ include: typeof dropTypeInclude }>;

/** A row as the rule engine wants it. */
export function toRuleType(row: DropTypeRow): RuleType {
    return {
        code: row.code,
        variantMode: row.variantMode,
        variantCodePattern: row.variantCodePattern,
        // Validated on write; parsed again so a hand-edited row cannot crash
        // the engine — a malformed rule set behaves as "no rules".
        rules: dropTypeRulesSchema.safeParse(row.rules).data ?? [],
        dimensions: row.dimensions.map((d) => ({
            code: d.code,
            label: d.label,
            position: d.position,
            required: d.required,
            allowCustomValues: d.allowCustomValues,
            displayType: d.displayType,
            archived: d.archivedAt !== null,
            values: d.values.map((v) => ({
                code: v.code,
                label: v.label,
                hexCode: v.hexCode,
                position: v.position,
                archived: v.archivedAt !== null,
            })),
        })),
    };
}

function dimensionCreate(input: DimensionInput, position: number, now: Date) {
    return {
        id: randomUUID(),
        code: input.code,
        label: input.label,
        position: input.position ?? position,
        required: input.required,
        allowCustomValues: input.allowCustomValues,
        displayType: input.displayType,
        createdAt: now,
        updatedAt: now,
        values: {
            create: input.values.map((value, index) => valueCreate(value, index, now)),
        },
    };
}

function valueCreate(input: DimensionValueInput, position: number, now: Date) {
    return {
        id: randomUUID(),
        code: input.code,
        label: input.label,
        hexCode: input.hexCode ?? null,
        position: input.position ?? position,
        createdAt: now,
        updatedAt: now,
    };
}

export class DropTypeRepository {
    constructor(private readonly prisma: PrismaClient) { }

    list(includeInactive: boolean): Promise<DropTypeRow[]> {
        return this.prisma.dropType.findMany({
            where: includeInactive ? {} : { isActive: true },
            include: dropTypeInclude,
            orderBy: { name: 'asc' },
        });
    }

    findByCode(code: string): Promise<DropTypeRow | null> {
        return this.prisma.dropType.findUnique({ where: { code }, include: dropTypeInclude });
    }

    findById(id: string): Promise<DropTypeRow | null> {
        return this.prisma.dropType.findUnique({ where: { id }, include: dropTypeInclude });
    }

    /** How many drops (archived included) use this type. */
    countDrops(dropTypeId: string): Promise<number> {
        return this.prisma.drop.count({ where: { dropTypeId } });
    }

    create(input: {
        code: string;
        name: string;
        description: string | null;
        variantMode: 'NONE' | 'OPTIONAL' | 'REQUIRED';
        variantCodePattern: string;
        rules: unknown[];
        dimensions: DimensionInput[];
    }): Promise<DropTypeRow> {
        const now = new Date();
        return this.prisma.dropType.create({
            data: {
                id: randomUUID(),
                code: input.code,
                name: input.name,
                description: input.description,
                variantMode: input.variantMode,
                variantCodePattern: input.variantCodePattern,
                rules: input.rules as Prisma.InputJsonValue,
                createdAt: now,
                updatedAt: now,
                dimensions: {
                    create: input.dimensions.map((d, index) => dimensionCreate(d, index, now)),
                },
            },
            include: dropTypeInclude,
        });
    }

    /**
     * Updates the type row. `bumpVersion` is set by the service whenever the
     * change affects which variants are valid (rules, dimensions, values).
     */
    update(
        id: string,
        data: Omit<Prisma.DropTypeUpdateInput, 'version' | 'updatedAt'>,
        bumpVersion: boolean,
    ): Promise<DropTypeRow> {
        return this.prisma.dropType.update({
            where: { id },
            data: {
                ...data,
                updatedAt: new Date(),
                ...(bumpVersion ? { version: { increment: 1 } } : {}),
            },
            include: dropTypeInclude,
        });
    }

    /** Runs `work` and bumps the type's version in the same transaction. */
    private async withVersionBump(
        dropTypeId: string,
        work: (tx: Prisma.TransactionClient, now: Date) => Promise<unknown>,
    ): Promise<DropTypeRow> {
        return this.prisma.$transaction(async (tx) => {
            const now = new Date();
            await work(tx, now);
            return tx.dropType.update({
                where: { id: dropTypeId },
                data: { version: { increment: 1 }, updatedAt: now },
                include: dropTypeInclude,
            });
        });
    }

    addDimension(dropTypeId: string, input: DimensionInput, position: number): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimension.create({
                data: { ...dimensionCreate(input, position, now), dropType: { connect: { id: dropTypeId } } },
            }),
        );
    }

    updateDimension(
        dropTypeId: string,
        dimensionId: string,
        data: Prisma.DropTypeDimensionUpdateInput,
    ): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimension.update({ where: { id: dimensionId }, data: { ...data, updatedAt: now } }),
        );
    }

    /** `archivedAt: null` restores. */
    setDimensionArchived(dropTypeId: string, dimensionId: string, archived: boolean): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimension.update({
                where: { id: dimensionId },
                data: { archivedAt: archived ? now : null, updatedAt: now },
            }),
        );
    }

    addValue(dropTypeId: string, dimensionId: string, input: DimensionValueInput, position: number): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimensionValue.create({
                data: { ...valueCreate(input, position, now), dimension: { connect: { id: dimensionId } } },
            }),
        );
    }

    updateValue(
        dropTypeId: string,
        valueId: string,
        data: Prisma.DropTypeDimensionValueUpdateInput,
    ): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimensionValue.update({ where: { id: valueId }, data: { ...data, updatedAt: now } }),
        );
    }

    setValueArchived(dropTypeId: string, valueId: string, archived: boolean): Promise<DropTypeRow> {
        return this.withVersionBump(dropTypeId, (tx, now) =>
            tx.dropTypeDimensionValue.update({
                where: { id: valueId },
                data: { archivedAt: archived ? now : null, updatedAt: now },
            }),
        );
    }
}

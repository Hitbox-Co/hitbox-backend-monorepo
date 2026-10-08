/**
 * Seeds the built-in drop types and their variant dimensions.
 *
 *   pnpm db:seed:drop-types
 *
 * ── Safe to re-run ──────────────────────────────────────────────────────────
 *
 * Additive only. A type, dimension or value that already exists (matched by
 * code) is left exactly as it is — an admin may have renamed a value or
 * changed a hex code through the API, and re-seeding must not undo that.
 * Only what is missing is created. To change a seeded value, use
 * PATCH /admin/drop-types/... rather than editing this file.
 *
 * See docs/admin/drop-types-and-variants.md §5.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/index';

interface SeedValue { code: string; label: string; hexCode?: string }
interface SeedDimension {
    code: string;
    label: string;
    required: boolean;
    allowCustomValues?: boolean;
    displayType?: 'TEXT' | 'COLOR';
    values: SeedValue[];
}
interface SeedType {
    code: string;
    name: string;
    description: string;
    variantMode: 'NONE' | 'OPTIONAL' | 'REQUIRED';
    dimensions: SeedDimension[];
    rules: unknown[];
}

/** Common garment colors, with swatches. */
const GARMENT_COLORS: SeedValue[] = [
    { code: 'BLK', label: 'Black', hexCode: '#1A1A1A' },
    { code: 'WHT', label: 'White', hexCode: '#FFFFFF' },
    { code: 'NVY', label: 'Navy', hexCode: '#1F2A44' },
    { code: 'GRY', label: 'Heather Grey', hexCode: '#9EA3A8' },
    { code: 'RED', label: 'Red', hexCode: '#C8102E' },
];

const EDITION: SeedDimension = {
    code: 'edition',
    label: 'Edition',
    required: true,
    values: [
        { code: 'STANDARD', label: 'Standard' },
        { code: 'LIMITED', label: 'Limited' },
    ],
};

const TYPES: SeedType[] = [
    {
        code: 'T_SHIRT',
        name: 'T-Shirt',
        description: 'Apparel sold by size and color — every unit is one size in one color.',
        variantMode: 'REQUIRED',
        dimensions: [
            {
                code: 'size',
                label: 'Size',
                required: true,
                values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((s) => ({ code: s, label: s })),
            },
            { code: 'color', label: 'Color', required: true, allowCustomValues: true, displayType: 'COLOR', values: GARMENT_COLORS },
        ],
        rules: [],
    },
    {
        code: 'CAP',
        name: 'Cap',
        description: 'Headwear sold by color, optionally by style.',
        variantMode: 'REQUIRED',
        dimensions: [
            { code: 'color', label: 'Color', required: true, allowCustomValues: true, displayType: 'COLOR', values: GARMENT_COLORS },
            {
                code: 'style',
                label: 'Style',
                required: false,
                values: [
                    { code: 'SNAPBACK', label: 'Snapback' },
                    { code: 'FITTED', label: 'Fitted' },
                    { code: 'TRUCKER', label: 'Trucker' },
                    { code: 'DAD', label: 'Dad Cap' },
                ],
            },
        ],
        rules: [],
    },
    {
        code: 'KEYCHAIN',
        name: 'Key Chain',
        description: 'No variants — the drop itself is the one sellable item.',
        variantMode: 'NONE',
        dimensions: [],
        rules: [],
    },
    {
        code: 'ACTION_FIGURE',
        name: 'Action Figure',
        description: 'Collectible figures by edition, optionally signed or exclusive.',
        variantMode: 'OPTIONAL',
        dimensions: [
            EDITION,
            {
                code: 'variant',
                label: 'Variant',
                required: false,
                values: [
                    { code: 'STANDARD', label: 'Standard' },
                    { code: 'SIGNED', label: 'Signed' },
                    { code: 'EXCLUSIVE', label: 'Exclusive' },
                ],
            },
        ],
        rules: [],
    },
    {
        code: 'CARD',
        name: 'Card',
        description: 'Trading cards as a single card, a pack (with a pack size) or a complete set.',
        variantMode: 'REQUIRED',
        dimensions: [
            {
                code: 'format',
                label: 'Format',
                required: true,
                values: [
                    { code: 'SINGLE', label: 'Single Card' },
                    { code: 'PACK', label: 'Pack' },
                    { code: 'SET', label: 'Complete Set' },
                ],
            },
            {
                code: 'packSize',
                label: 'Pack Size',
                required: false,
                values: [
                    { code: '1', label: '1 card' },
                    { code: '5', label: '5 cards' },
                    { code: '10', label: '10 cards' },
                ],
            },
        ],
        // Pack size only means something for a pack.
        rules: [
            { kind: 'require', when: { format: 'PACK' }, dimensions: ['packSize'] },
            { kind: 'forbid', when: { format: ['SINGLE', 'SET'] }, dimensions: ['packSize'] },
        ],
    },
    {
        code: 'POSTER',
        name: 'Poster',
        description: 'Prints by paper size and edition.',
        variantMode: 'REQUIRED',
        dimensions: [
            {
                code: 'size',
                label: 'Size',
                required: true,
                values: [
                    { code: 'A4', label: 'A4' },
                    { code: 'A3', label: 'A3' },
                    { code: 'A2', label: 'A2' },
                ],
            },
            EDITION,
        ],
        rules: [],
    },
    {
        code: 'GENERIC',
        name: 'Other',
        description: 'Anything not modelled yet — one free-form option per variant.',
        variantMode: 'OPTIONAL',
        dimensions: [{ code: 'option', label: 'Option', required: true, allowCustomValues: true, values: [] }],
        rules: [],
    },
];

async function main(): Promise<void> {
    const summary: string[] = [];

    for (const type of TYPES) {
        const now = new Date();
        let row = await prisma.dropType.findUnique({
            where: { code: type.code },
            include: { dimensions: { include: { values: true } } },
        });
        let created = 0;
        const isNew = !row;

        if (!row) {
            await prisma.dropType.create({
                data: {
                    id: randomUUID(),
                    code: type.code,
                    name: type.name,
                    description: type.description,
                    variantMode: type.variantMode,
                    rules: type.rules as object[],
                    createdAt: now,
                    updatedAt: now,
                },
            });
            row = await prisma.dropType.findUniqueOrThrow({
                where: { code: type.code },
                include: { dimensions: { include: { values: true } } },
            });
            summary.push(`+ ${type.code}`);
        }

        for (const [dIndex, dimension] of type.dimensions.entries()) {
            let dim = row.dimensions.find((d) => d.code === dimension.code);
            if (!dim) {
                dim = {
                    ...(await prisma.dropTypeDimension.create({
                        data: {
                            id: randomUUID(),
                            dropTypeId: row.id,
                            code: dimension.code,
                            label: dimension.label,
                            position: dIndex,
                            required: dimension.required,
                            allowCustomValues: dimension.allowCustomValues ?? false,
                            displayType: dimension.displayType ?? 'TEXT',
                            createdAt: now,
                            updatedAt: now,
                        },
                    })),
                    values: [],
                };
                created += 1;
            }
            for (const [vIndex, value] of dimension.values.entries()) {
                if (dim.values.some((v) => v.code === value.code)) continue;
                await prisma.dropTypeDimensionValue.create({
                    data: {
                        id: randomUUID(),
                        dimensionId: dim.id,
                        code: value.code,
                        label: value.label,
                        hexCode: value.hexCode ?? null,
                        position: vIndex,
                        createdAt: now,
                        updatedAt: now,
                    },
                });
                created += 1;
            }
        }

        if (created > 0 && !isNew) {
            // New dimensions/values change what is valid — same rule as the API.
            await prisma.dropType.update({
                where: { id: row.id },
                data: { version: { increment: 1 }, updatedAt: now },
            });
            summary.push(`  ${type.code}: ${created} dimension/value row(s) added`);
        }
    }

    console.log('✔ drop types seeded');
    console.log(summary.length ? summary.join('\n') : '  (nothing to add — all present)');
}

main()
    .catch((error) => {
        console.error('✖ drop-type seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

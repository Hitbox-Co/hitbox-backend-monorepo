import {
    buildLegacyPair,
    buildOptionsKey,
    buildVariantCode,
    buildVariantLabel,
    cartesian,
    combinationCount,
    normalizeHex,
    pruneForbidden,
    resolveOptions,
    validateRulesAgainst,
    type RuleDimension,
    type RuleType,
} from '../src/drop-type/rules';
import { createDropTypeSchema } from '../src/drop-type/drop-type.dto';
import { generateVariantsSchema } from '../src/variant/variant.dto';

/**
 * The variant rule engine against the built-in types (seed-drop-types.ts).
 * docs/admin/drop-types-and-variants.md §5 and §7.
 */

const dim = (
    code: string,
    values: (string | [string, string, string?])[],
    extra: Partial<RuleDimension> = {},
): RuleDimension => ({
    code,
    label: code[0]!.toUpperCase() + code.slice(1),
    position: 0,
    required: true,
    allowCustomValues: false,
    displayType: 'TEXT',
    archived: false,
    values: values.map((v, i) => {
        const [c, label, hex] = typeof v === 'string' ? [v, v] : v;
        return { code: c, label: label ?? c, hexCode: hex ?? null, position: i, archived: false };
    }),
    ...extra,
});

const T_SHIRT: RuleType = {
    code: 'T_SHIRT',
    variantMode: 'REQUIRED',
    variantCodePattern: '{groupCode}-{values}',
    rules: [],
    dimensions: [
        dim('size', ['S', 'M', 'L', 'XL'], { position: 0 }),
        dim('color', [['BLK', 'Black', '#1A1A1A'], ['WHT', 'White', '#FFFFFF']], {
            position: 1,
            displayType: 'COLOR',
            allowCustomValues: true,
        }),
    ],
};

const CARD: RuleType = {
    code: 'CARD',
    variantMode: 'REQUIRED',
    variantCodePattern: '{groupCode}-{values}',
    rules: [
        { kind: 'require', when: { format: 'PACK' }, dimensions: ['packSize'] },
        { kind: 'forbid', when: { format: ['SINGLE', 'SET'] }, dimensions: ['packSize'] },
    ],
    dimensions: [
        dim('format', ['SINGLE', 'PACK', 'SET'], { position: 0 }),
        dim('packSize', ['1', '5', '10'], { position: 1, required: false }),
    ],
};

const ACTION_FIGURE: RuleType = {
    code: 'ACTION_FIGURE',
    variantMode: 'OPTIONAL',
    variantCodePattern: '{groupCode}-{values}',
    rules: [{ kind: 'exclude', match: { edition: 'STANDARD', variant: 'EXCLUSIVE' } }],
    dimensions: [
        dim('edition', ['STANDARD', 'LIMITED'], { position: 0 }),
        dim('variant', ['STANDARD', 'SIGNED', 'EXCLUSIVE'], { position: 1, required: false }),
    ],
};

describe('resolveOptions — T-shirt (size × color)', () => {
    it('accepts a valid combination and orders it by dimension position', () => {
        const result = resolveOptions(T_SHIRT, { color: 'blk', size: 'm' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.options.map((o) => [o.dimensionCode, o.valueCode])).toEqual([
            ['size', 'M'],
            ['color', 'BLK'],
        ]);
        // The type's swatch is carried onto the option.
        expect(result.options[1]!.hexCode).toBe('#1A1A1A');
    });

    it('refuses a missing required dimension', () => {
        const result = resolveOptions(T_SHIRT, { size: 'M' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems).toEqual([expect.objectContaining({ dimension: 'color', rule: 'missing-required' })]);
    });

    it('refuses a value not in the list on a closed dimension', () => {
        const result = resolveOptions(T_SHIRT, { size: 'XXXL', color: 'BLK' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0]).toMatchObject({ dimension: 'size', rule: 'unknown-value' });
    });

    it('refuses an unknown dimension', () => {
        const result = resolveOptions(T_SHIRT, { size: 'M', color: 'BLK', fit: 'SLIM' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0]).toMatchObject({ dimension: 'fit', rule: 'unknown-dimension' });
    });

    it('accepts a custom color with a hex code, normalised', () => {
        const result = resolveOptions(T_SHIRT, { size: 'M', color: { code: 'snd', label: 'Sand', hexCode: 'c2b280' } });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.options[1]).toMatchObject({ valueCode: 'SND', valueLabel: 'Sand', hexCode: '#C2B280' });
    });

    it('refuses a malformed custom hex code', () => {
        const result = resolveOptions(T_SHIRT, { size: 'M', color: { code: 'SND', hexCode: 'sand' } });
        expect(result.ok).toBe(false);
    });

    it('refuses a value that has been archived', () => {
        const archived: RuleType = {
            ...T_SHIRT,
            dimensions: [
                { ...T_SHIRT.dimensions[0]!, values: T_SHIRT.dimensions[0]!.values.map((v) => ({ ...v, archived: v.code === 'XL' })) },
                T_SHIRT.dimensions[1]!,
            ],
        };
        expect(resolveOptions(archived, { size: 'XL', color: 'BLK' }).ok).toBe(false);
        expect(resolveOptions(archived, { size: 'L', color: 'BLK' }).ok).toBe(true);
    });

    it('refuses an empty option set', () => {
        const result = resolveOptions(T_SHIRT, {});
        expect(result.ok).toBe(false);
    });
});

describe('resolveOptions — card rules', () => {
    it('a pack requires a pack size', () => {
        const result = resolveOptions(CARD, { format: 'PACK' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0]).toMatchObject({ dimension: 'packSize', rule: 'missing-required' });
    });

    it('a single card forbids a pack size', () => {
        const result = resolveOptions(CARD, { format: 'SINGLE', packSize: '5' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0]).toMatchObject({ dimension: 'packSize', rule: 'forbidden-dimension' });
    });

    it('accepts PACK-5 and plain SINGLE', () => {
        expect(resolveOptions(CARD, { format: 'PACK', packSize: 5 as unknown as string }).ok).toBe(true);
        expect(resolveOptions(CARD, { format: 'SINGLE' }).ok).toBe(true);
    });
});

describe('resolveOptions — exclude rules', () => {
    it('refuses an excluded combination', () => {
        const result = resolveOptions(ACTION_FIGURE, { edition: 'STANDARD', variant: 'EXCLUSIVE' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0]!.rule).toBe('excluded-combination');
    });

    it('optional dimensions may be omitted', () => {
        expect(resolveOptions(ACTION_FIGURE, { edition: 'LIMITED' }).ok).toBe(true);
    });
});

describe('generation', () => {
    it('counts combinations before pruning', () => {
        expect(combinationCount({ size: ['S', 'M', 'L', 'XL'], color: ['BLK', 'WHT'] })).toBe(8);
        expect(combinationCount({})).toBe(0);
    });

    it('builds the cartesian product', () => {
        expect(cartesian({ size: ['S', 'M'], color: ['BLK', 'WHT'] })).toHaveLength(4);
    });

    it('prunes a forbidden dimension instead of refusing the combination', () => {
        const combos = cartesian({ format: ['SINGLE', 'PACK', 'SET'], packSize: ['5', '10'] });
        const keys = new Set<string>();
        for (const combo of combos) {
            const result = resolveOptions(CARD, pruneForbidden(CARD, combo));
            if (result.ok) keys.add(buildOptionsKey(result.options));
        }
        expect([...keys].sort()).toEqual([
            'format=PACK|packSize=10',
            'format=PACK|packSize=5',
            'format=SET',
            'format=SINGLE',
        ]);
    });
});

describe('naming', () => {
    const resolved = () => {
        const result = resolveOptions(T_SHIRT, { size: 'M', color: 'BLK' });
        if (!result.ok) throw new Error('expected valid');
        return result.options;
    };

    it('optionsKey is sorted by dimension code, so input order never matters', () => {
        expect(buildOptionsKey(resolved())).toBe('color=BLK|size=M');
    });

    it('variantCode follows the pattern, values in dimension order', () => {
        expect(buildVariantCode('{groupCode}-{values}', '123456780000', resolved())).toBe('123456780000-M-BLK');
    });

    it('label and the legacy pair', () => {
        expect(buildVariantLabel(resolved())).toBe('M / Black');
        expect(buildLegacyPair(resolved())).toEqual({ optionName: 'size/color', optionValue: 'M/BLK' });
    });
});

describe('normalizeHex', () => {
    it.each([
        ['#abc', '#AABBCC'],
        ['AABBCC', '#AABBCC'],
        ['#1a1A1a', '#1A1A1A'],
        ['  #FFF ', '#FFFFFF'],
    ])('%s → %s', (input, expected) => {
        expect(normalizeHex(input)).toBe(expected);
    });

    it.each(['red', '#12345', '#GGGGGG', ''])('rejects %s', (input) => {
        expect(normalizeHex(input)).toBeNull();
    });
});

describe('type definitions', () => {
    it('rules may only name dimensions the type has', () => {
        expect(validateRulesAgainst(['format', 'packSize'], CARD.rules)).toEqual([]);
        expect(validateRulesAgainst(['format'], CARD.rules)).toHaveLength(2);
    });

    it('createDropTypeSchema normalises codes and hex colors', () => {
        const parsed = createDropTypeSchema.parse({
            code: 't_shirt',
            name: 'T-Shirt',
            variantMode: 'required',
            dimensions: [
                {
                    code: 'color',
                    label: 'Color',
                    required: true,
                    displayType: 'color',
                    values: [{ code: 'blk', label: 'Black', hexCode: '1a1a1a' }],
                },
            ],
        });
        expect(parsed.code).toBe('T_SHIRT');
        expect(parsed.variantMode).toBe('REQUIRED');
        expect(parsed.dimensions[0]!.values[0]).toMatchObject({ code: 'BLK', hexCode: '#1A1A1A' });
    });

    it('a NONE type takes no dimensions', () => {
        expect(() =>
            createDropTypeSchema.parse({
                code: 'KEYCHAIN',
                name: 'Key Chain',
                variantMode: 'NONE',
                dimensions: [{ code: 'size', label: 'Size', values: [] }],
            }),
        ).toThrow();
    });

    it('a variant code pattern must keep both tokens', () => {
        expect(() =>
            createDropTypeSchema.parse({ code: 'X_TYPE', name: 'X', variantMode: 'OPTIONAL', variantCodePattern: 'HB-{values}' }),
        ).toThrow();
    });

    it('generate accepts numbers as value codes', () => {
        const parsed = generateVariantsSchema.parse({ select: { format: ['PACK'], packSize: [5, 10] } });
        expect(parsed.select.packSize).toEqual(['5', '10']);
    });
});

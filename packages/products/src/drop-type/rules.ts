import { z } from 'zod';

/**
 * THE VARIANT RULE ENGINE — pure functions, no Prisma.
 *
 * A drop type says which dimensions a variant varies along (size, color…),
 * which values each may take, and the rules between them. Everything here
 * answers one question: "is this set of options a valid variant of this type,
 * and if so, what is it called?"
 *
 * Kept free of the database so every rule — including the CARD near-misses —
 * is unit-testable in isolation (tests/variant-rules.test.ts).
 *
 * See docs/admin/drop-types-and-variants.md §3 and §7.
 */

// ── Formats ─────────────────────────────────────────────────────────────────

/** `T_SHIRT`, `ACTION_FIGURE`. */
export const TYPE_CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** `size`, `packSize`. Used in `optionsKey`, so no `=` or `|`. */
export const DIMENSION_CODE_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
/** `M`, `BLK`, `10`. Joined with `-` into `variantCode`, so no `-`. */
export const VALUE_CODE_RE = /^[A-Z0-9]{1,12}$/;

/** Both tokens are mandatory, so variant codes stay globally unique. */
export const VARIANT_CODE_TOKENS = { GROUP_CODE: '{groupCode}', VALUES: '{values}' } as const;
export const DEFAULT_VARIANT_CODE_PATTERN = '{groupCode}-{values}';

/**
 * `#abc`, `ABC123`, `#AABBCC` → `#AABBCC`. Anything else → `null`.
 *
 * Normalised so the stored value is always the 7-char form a client can drop
 * straight into CSS.
 */
export function normalizeHex(input: string): string | null {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
    if (!match) return null;
    let hex = match[1]!.toUpperCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return `#${hex}`;
}

// ── Rules ───────────────────────────────────────────────────────────────────

const ruleMatch = z.record(
    z.string().min(1),
    z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
);

/**
 * - `require` — when `when` matches, these dimensions must have a value.
 * - `forbid`  — when `when` matches, these dimensions must NOT have a value.
 * - `exclude` — this exact combination is never valid.
 *
 * A `when` / `match` value may be one value code or a list (any of).
 */
export const dropTypeRuleSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('require'),
        when: ruleMatch,
        dimensions: z.array(z.string().min(1)).min(1),
    }).strict(),
    z.object({
        kind: z.literal('forbid'),
        when: ruleMatch,
        dimensions: z.array(z.string().min(1)).min(1),
    }).strict(),
    z.object({
        kind: z.literal('exclude'),
        match: ruleMatch,
    }).strict(),
]);
export const dropTypeRulesSchema = z.array(dropTypeRuleSchema).max(50);
export type DropTypeRule = z.infer<typeof dropTypeRuleSchema>;

// ── Shapes the engine works on ──────────────────────────────────────────────

export interface RuleValue {
    code: string;
    label: string;
    hexCode: string | null;
    position: number;
    archived: boolean;
}

export interface RuleDimension {
    code: string;
    label: string;
    position: number;
    required: boolean;
    allowCustomValues: boolean;
    displayType: 'TEXT' | 'COLOR';
    archived: boolean;
    values: RuleValue[];
}

export interface RuleType {
    code: string;
    variantMode: 'NONE' | 'OPTIONAL' | 'REQUIRED';
    variantCodePattern: string;
    rules: DropTypeRule[];
    dimensions: RuleDimension[];
}

/**
 * One option as a client sends it: a value code (`"M"`), or — for a
 * dimension that allows custom values — a full value
 * (`{ code: "SND", label: "Sand", hexCode: "#C2B280" }`).
 */
export type OptionInput = string | { code: string; label?: string | undefined; hexCode?: string | null | undefined };

export interface ResolvedOption {
    dimensionCode: string;
    dimensionLabel: string;
    valueCode: string;
    valueLabel: string;
    hexCode: string | null;
    position: number;
}

export interface OptionProblem {
    dimension: string | null;
    rule:
    | 'unknown-dimension'
    | 'unknown-value'
    | 'invalid-custom-value'
    | 'hex-not-allowed'
    | 'missing-required'
    | 'forbidden-dimension'
    | 'excluded-combination'
    | 'no-options';
    message: string;
}

export type ResolveResult =
    | { ok: true; options: ResolvedOption[] }
    | { ok: false; problems: OptionProblem[] };

// ── Evaluation ──────────────────────────────────────────────────────────────

function matches(match: Record<string, string | string[]>, chosen: Map<string, string>): boolean {
    return Object.entries(match).every(([dimension, expected]) => {
        const value = chosen.get(dimension);
        if (value === undefined) return false;
        return Array.isArray(expected) ? expected.includes(value) : expected === value;
    });
}

/**
 * Which dimensions are required / forbidden for this particular choice of
 * values, after `require` and `forbid` rules are applied on top of each
 * dimension's own `required` flag.
 */
export function effectiveRequirements(
    type: RuleType,
    chosen: Map<string, string>,
): { required: Set<string>; forbidden: Set<string> } {
    const required = new Set(
        type.dimensions.filter((d) => !d.archived && d.required).map((d) => d.code),
    );
    const forbidden = new Set<string>();
    for (const rule of type.rules) {
        if (rule.kind === 'exclude' || !matches(rule.when, chosen)) continue;
        for (const dimension of rule.dimensions) {
            if (rule.kind === 'require') {
                required.add(dimension);
                forbidden.delete(dimension);
            } else {
                forbidden.add(dimension);
                required.delete(dimension);
            }
        }
    }
    return { required, forbidden };
}

function normalizeValueCode(raw: unknown): string {
    return String(raw ?? '').trim().toUpperCase();
}

/** A bare code (string, or a number such as pack size 5) vs a full value object. */
function isValueObject(raw: OptionInput): raw is Exclude<OptionInput, string> {
    return typeof raw === 'object' && raw !== null;
}

/**
 * Validates one variant's options against its type and resolves them to
 * labelled, ordered rows. Collects every problem rather than stopping at the
 * first, so the admin screen can mark all bad fields at once.
 */
export function resolveOptions(type: RuleType, input: Record<string, OptionInput>): ResolveResult {
    const problems: OptionProblem[] = [];
    const resolved: ResolvedOption[] = [];

    for (const [dimensionCode, raw] of Object.entries(input)) {
        const dimension = type.dimensions.find((d) => d.code === dimensionCode && !d.archived);
        if (!dimension) {
            problems.push({
                dimension: dimensionCode,
                rule: 'unknown-dimension',
                message: `"${dimensionCode}" is not a dimension of ${type.code}.`,
            });
            continue;
        }

        const code = normalizeValueCode(isValueObject(raw) ? raw.code : raw);
        const known = dimension.values.find((v) => v.code === code && !v.archived);

        if (known) {
            resolved.push({
                dimensionCode,
                dimensionLabel: dimension.label,
                valueCode: known.code,
                valueLabel: known.label,
                // The type's own swatch wins over anything the client sent.
                hexCode: dimension.displayType === 'COLOR' ? known.hexCode : null,
                position: dimension.position,
            });
            continue;
        }

        if (!dimension.allowCustomValues) {
            problems.push({
                dimension: dimensionCode,
                rule: 'unknown-value',
                message: `"${code}" is not an allowed ${dimension.label} for ${type.code}.`,
            });
            continue;
        }

        // A custom value, for this drop only.
        if (!VALUE_CODE_RE.test(code)) {
            problems.push({
                dimension: dimensionCode,
                rule: 'invalid-custom-value',
                message: `Custom ${dimension.label} code "${code}" must be 1–12 letters or digits.`,
            });
            continue;
        }
        const label = (isValueObject(raw) ? raw.label?.trim() : '') || code;
        let hexCode: string | null = null;
        const rawHex = isValueObject(raw) ? raw.hexCode : undefined;
        if (rawHex) {
            if (dimension.displayType !== 'COLOR') {
                problems.push({
                    dimension: dimensionCode,
                    rule: 'hex-not-allowed',
                    message: `${dimension.label} is not a color dimension, so it takes no hex code.`,
                });
                continue;
            }
            hexCode = normalizeHex(rawHex);
            if (!hexCode) {
                problems.push({
                    dimension: dimensionCode,
                    rule: 'invalid-custom-value',
                    message: `"${rawHex}" is not a hex color — use #RRGGBB.`,
                });
                continue;
            }
        }
        resolved.push({
            dimensionCode,
            dimensionLabel: dimension.label,
            valueCode: code,
            valueLabel: label,
            hexCode,
            position: dimension.position,
        });
    }

    if (resolved.length === 0 && problems.length === 0) {
        problems.push({ dimension: null, rule: 'no-options', message: 'A variant needs at least one option.' });
    }

    const chosen = new Map(resolved.map((o) => [o.dimensionCode, o.valueCode]));
    const { required, forbidden } = effectiveRequirements(type, chosen);

    for (const dimension of type.dimensions) {
        if (dimension.archived) continue;
        const has = chosen.has(dimension.code);
        // Only report a missing dimension the client did not try to send at
        // all — a bad value for it is already reported above.
        if (required.has(dimension.code) && !has && !(dimension.code in input)) {
            problems.push({
                dimension: dimension.code,
                rule: 'missing-required',
                message: `${dimension.label} is required for this ${type.code} variant.`,
            });
        }
        if (forbidden.has(dimension.code) && has) {
            problems.push({
                dimension: dimension.code,
                rule: 'forbidden-dimension',
                message: `${dimension.label} does not apply to this combination.`,
            });
        }
    }

    for (const rule of type.rules) {
        if (rule.kind === 'exclude' && matches(rule.match, chosen)) {
            problems.push({
                dimension: null,
                rule: 'excluded-combination',
                message: `This combination is not allowed for ${type.code}: ${Object.entries(rule.match)
                    .map(([d, v]) => `${d}=${Array.isArray(v) ? v.join('|') : v}`)
                    .join(', ')}.`,
            });
        }
    }

    if (problems.length > 0) return { ok: false, problems };
    resolved.sort((a, b) => a.position - b.position || a.dimensionCode.localeCompare(b.dimensionCode));
    return { ok: true, options: resolved };
}

/**
 * Removes dimensions a rule forbids for this choice — used by generation, so
 * `format: [SINGLE, PACK] × packSize: [5, 10]` yields `SINGLE`, `PACK-5`,
 * `PACK-10` rather than refusing `SINGLE-5`. Repeated until stable, because
 * dropping one dimension can change which rules match.
 */
export function pruneForbidden(
    type: RuleType,
    input: Record<string, OptionInput>,
): Record<string, OptionInput> {
    const current = { ...input };
    for (let pass = 0; pass <= type.dimensions.length; pass += 1) {
        const chosen = new Map(
            Object.entries(current).map(([d, v]) => [d, normalizeValueCode(isValueObject(v) ? v.code : v)]),
        );
        const { forbidden } = effectiveRequirements(type, chosen);
        const drop = Object.keys(current).filter((d) => forbidden.has(d));
        if (drop.length === 0) break;
        for (const d of drop) delete current[d];
    }
    return current;
}

// ── Naming ──────────────────────────────────────────────────────────────────

/** `color=BLK|size=M` — dimension codes sorted, so order of input never matters. */
export function buildOptionsKey(options: ResolvedOption[]): string {
    return [...options]
        .sort((a, b) => a.dimensionCode.localeCompare(b.dimensionCode))
        .map((o) => `${o.dimensionCode}=${o.valueCode}`)
        .join('|');
}

/** `{groupCode}-{values}` → `123456780000-M-BLK`. Values in dimension order. */
export function buildVariantCode(pattern: string, groupCode: string, options: ResolvedOption[]): string {
    return pattern
        .replace(VARIANT_CODE_TOKENS.GROUP_CODE, groupCode)
        .replace(VARIANT_CODE_TOKENS.VALUES, options.map((o) => o.valueCode).join('-'));
}

/** `M / Black` */
export function buildVariantLabel(options: ResolvedOption[]): string {
    return options.map((o) => o.valueLabel).join(' / ');
}

/**
 * The legacy pair every existing reader still understands:
 * `optionName = "size/color"`, `optionValue = "M/BLK"`.
 */
export function buildLegacyPair(options: ResolvedOption[]): { optionName: string; optionValue: string } {
    return {
        optionName: options.map((o) => o.dimensionCode).join('/'),
        optionValue: options.map((o) => o.valueCode).join('/'),
    };
}

// ── Generation ──────────────────────────────────────────────────────────────

/** Number of combinations before rules prune anything. */
export function combinationCount(select: Record<string, OptionInput[]>): number {
    const lists = Object.values(select);
    if (lists.length === 0) return 0;
    return lists.reduce((total, list) => total * list.length, 1);
}

/** Every combination of the selected values, one value per dimension. */
export function cartesian(select: Record<string, OptionInput[]>): Record<string, OptionInput>[] {
    let combos: Record<string, OptionInput>[] = [{}];
    for (const [dimension, values] of Object.entries(select)) {
        const next: Record<string, OptionInput>[] = [];
        for (const combo of combos) {
            for (const value of values) next.push({ ...combo, [dimension]: value });
        }
        combos = next;
    }
    return combos;
}

// ── Type-definition checks ──────────────────────────────────────────────────

/**
 * Rules may only name dimensions the type has. Returns human-readable
 * problems; empty means valid.
 */
export function validateRulesAgainst(dimensionCodes: string[], rules: DropTypeRule[]): string[] {
    const known = new Set(dimensionCodes);
    const problems: string[] = [];
    rules.forEach((rule, index) => {
        const named = rule.kind === 'exclude'
            ? Object.keys(rule.match)
            : [...Object.keys(rule.when), ...rule.dimensions];
        for (const d of named) {
            if (!known.has(d)) problems.push(`rules[${index}] names unknown dimension "${d}".`);
        }
    });
    return problems;
}

export function isValidVariantCodePattern(pattern: string): boolean {
    return pattern.includes(VARIANT_CODE_TOKENS.GROUP_CODE) && pattern.includes(VARIANT_CODE_TOKENS.VALUES);
}

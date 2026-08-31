/**
 * The "interests trap" (docs/leads-schema.md §2.3): the site's
 * `useFormSubmit` builds the payload with `formData.getAll(key)` and
 * collapses the result — two ticks give `["Music","Gaming"]`, exactly one
 * gives the bare string `"Music"`, none omits the key entirely. Normalise
 * all three shapes to a plain string array before it reaches Prisma, or a
 * single-interest signup throws on a `String[]` column.
 */
export function normalizeToStringArray(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string') return value.length > 0 ? [value] : [];
    return [];
}

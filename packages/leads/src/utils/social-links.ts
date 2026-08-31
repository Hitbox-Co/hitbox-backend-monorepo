const URL_PATTERN = /((https?:\/\/)?(www\.)?[a-z0-9-]+\.[a-z]{2,}(\/[^\s,]*)?)/gi;

/**
 * The artist form's `socials` field is a free-text, multi-line textarea, not
 * a URL input (docs §2.3). This is a best-effort heuristic split — not a
 * guarantee every link is captured perfectly, which is exactly why the raw
 * text is ALSO preserved verbatim in rawPayload regardless of parse result.
 *
 * Splits on newlines/commas, extracts anything URL-shaped, normalizes to
 * include a protocol, and returns the first as `primary` and the rest as
 * `additional`.
 */
export function parseSocialLinks(raw: string | null | undefined): {
    primary: string | null;
    additional: string[];
} {
    if (!raw) return { primary: null, additional: [] };

    const candidates = raw
        .split(/[\n,]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => line.match(URL_PATTERN) ?? []);

    const normalized = candidates.map((url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`));

    const [primary = null, ...additional] = normalized;
    return { primary, additional };
}

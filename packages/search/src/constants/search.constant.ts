export const SEARCH_MODULE = 'search' as const;

/** Per-section size when `type=all` (the "search as you type" overview). */
export const SEARCH_ALL_DEFAULT_LIMIT = 5;
export const SEARCH_ALL_MAX_LIMIT = 20;

/** Page size when a single `type` is requested (a full results tab). */
export const SEARCH_TYPE_DEFAULT_LIMIT = 20;
export const SEARCH_TYPE_MAX_LIMIT = 50;

/** Search is public and hits three tables, so it is throttled per client IP. */
export const SEARCH_RATE_LIMIT = { windowMs: 60_000, max: 60 } as const;

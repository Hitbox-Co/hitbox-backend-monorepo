export const DASHBOARD_MODULE = 'dashboard' as const;

export const DASHBOARD_ERROR_CODES = {
    /** `from` >= `to`, or a custom period with a missing bound. */
    INVALID_RANGE: 'INVALID_RANGE',
    /** A client-supplied organizationId the caller's grants do not cover. */
    SCOPE_MISMATCH: 'SCOPE_MISMATCH',
    /** The caller holds nothing that would make this section visible. */
    FORBIDDEN: 'AUTHZ_FORBIDDEN',
} as const;

/**
 * Every section the dashboard can return, and the capability that gates it.
 *
 * These are **capabilities** (`resource:action`), never role names — the
 * engine resolves whichever scope the caller holds. A caller with no grant
 * for a section gets that key **omitted from the JSON entirely**, never an
 * empty object: `{}` or `0` reads as "no data this period", which is a
 * different and misleading claim.
 */
export const DASHBOARD_SECTIONS = {
    summary: 'summary',
    users: 'users',
    orders: 'orders',
    finance: 'finance',
    payments: 'payments',
    refunds: 'refunds',
    markets: 'markets',
    products: 'products',
    content: 'content',
    artists: 'artists',
    operations: 'operations',
    activity: 'activity',
    releaseApprovals: 'releaseApprovals',
    provenance: 'provenance',
    supply: 'supply',
    resale: 'resale',
    media: 'media',
    organizations: 'organizations',
    paymentGatewayConfig: 'paymentGatewayConfig',
    demandSignals: 'demandSignals',
} as const;

export type DashboardSection = (typeof DASHBOARD_SECTIONS)[keyof typeof DASHBOARD_SECTIONS];

export const DASHBOARD_DEFAULT_LIMIT = 20;

/**
 * How many products the main dashboard's inline inventory preview carries.
 * The full list is the paginated /products sub-endpoint — the summary payload
 * should not grow with the catalog.
 */
export const INVENTORY_PREVIEW_LIMIT = 10;
export const DASHBOARD_MAX_LIMIT = 100;

/** Trend buckets: day for week/month, month for year. */
export const TREND_GRANULARITY = {
    day: 'day',
    month: 'month',
} as const;
export type TrendGranularity = (typeof TREND_GRANULARITY)[keyof typeof TREND_GRANULARITY];

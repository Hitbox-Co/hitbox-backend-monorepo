export const MARKETS_MODULE = 'markets' as const;

export const MARKETS_ERROR_CODES = {
    NOT_FOUND: 'MARKETS_NOT_FOUND',
    CODE_TAKEN: 'MARKETS_CODE_TAKEN',
    COUNTRY_TAKEN: 'MARKETS_COUNTRY_TAKEN',
    /** Refused: the market still has orders or prices pointing at it. */
    IN_USE: 'MARKETS_IN_USE',
    /** Refused: the platform must always have exactly one default market. */
    DEFAULT_REQUIRED: 'MARKETS_DEFAULT_REQUIRED',
} as const;

/**
 * Markets are shared, cross-organization configuration: every product prices
 * against them and every order records one. Writing them is therefore gated
 * on a **platform-wide** grant (`globalOnly`), which today only
 * HITBOX_SYSTEM_ADMIN holds — a Brand Admin with `drop:manage:organization`
 * can edit their own drops but not the table those drops price against.
 *
 * Reading is deliberately wider: anyone who can see a dashboard needs the
 * market list to label figures.
 */
export const MARKET_WRITE_CAPABILITY = 'drop:manage' as const;
export const MARKET_READ_CAPABILITY = 'reports-dashboards:read' as const;

export const MARKETS_DEFAULT_LIMIT = 50;
export const MARKETS_MAX_LIMIT = 200;

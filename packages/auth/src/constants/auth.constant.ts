export const AUTH_MODULE = 'auth' as const;

export const AUTH_ERROR_CODES = {
    UNAUTHENTICATED: 'AUTH_UNAUTHENTICATED',
    INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    FORBIDDEN: 'AUTH_FORBIDDEN',
    ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',
    ACCOUNT_NOT_FOUND: 'AUTH_ACCOUNT_NOT_FOUND',
    WEBHOOK_INVALID_SIGNATURE: 'AUTH_WEBHOOK_INVALID_SIGNATURE',
} as const;

export const AUTH_EVENTS = {
    USER_REGISTERED: 'auth.user.registered',
    USER_UPDATED: 'auth.user.updated',
    USER_DELETED: 'auth.user.deleted',
} as const;

export type AuthEventName = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

/** Clerk webhook types this module reacts to. Everything else is ignored. */
export const HANDLED_CLERK_EVENTS = ['user.created', 'user.updated', 'user.deleted'] as const;

export const CLERK_WEBHOOK_PATH = '/clerk' as const;

/** How long processed webhook delivery IDs are kept for idempotency checks. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

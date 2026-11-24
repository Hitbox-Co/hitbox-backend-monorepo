export const USERS_MODULE = 'users' as const;

export const USERS_ERROR_CODES = {
    USER_NOT_FOUND: 'USERS_NOT_FOUND',
    /** `User.handle` is unique — renamed from USERNAME_TAKEN with the column. */
    HANDLE_TAKEN: 'USERS_HANDLE_TAKEN',
    EMAIL_TAKEN: 'USERS_EMAIL_TAKEN',
    /** No such address, or it is someone else's, or it was archived. */
    ADDRESS_NOT_FOUND: 'USERS_ADDRESS_NOT_FOUND',
    /** The user already has ADDRESS_LIMIT active addresses. */
    ADDRESS_LIMIT_REACHED: 'USERS_ADDRESS_LIMIT_REACHED',
    /** Checkout was handed one of the buyer's own addresses that has been archived. */
    ADDRESS_ARCHIVED: 'USERS_ADDRESS_ARCHIVED',
    /** A shipping-only address used as billing, or the reverse. */
    ADDRESS_USAGE_MISMATCH: 'USERS_ADDRESS_USAGE_MISMATCH',
} as const;

/** Most active addresses one user may keep. */
export const ADDRESS_LIMIT = 10;

/**
 * Per-user request budgets for the address routes, per minute. Reads are cheap;
 * writes take a row lock on the user, so they get the tighter one.
 */
export const ADDRESS_RATE_LIMIT = { windowMs: 60_000, reads: 120, writes: 30 } as const;

/**
 * Events this module publishes.
 *
 * `ACCOUNT_PROVISIONED` exists for one reason worth stating: the event bus
 * fires every subscriber of an event concurrently, via `setImmediate`, with no
 * ordering guarantee. So a second module cannot subscribe to the *auth* event
 * and safely assume this module has already written the `User` row — it would
 * race the insert and fail an foreign key intermittently.
 *
 * Publishing our own event AFTER the upsert gives that second module a
 * deterministic "the row now exists" signal. @hitbox/access-control uses it to
 * claim a pending staff invitation; see docs/authorization/admin-provisioning.md.
 */
export const USERS_EVENTS = {
    /** A user row has been created or refreshed from the identity provider. */
    ACCOUNT_PROVISIONED: 'users.account.provisioned',
} as const;

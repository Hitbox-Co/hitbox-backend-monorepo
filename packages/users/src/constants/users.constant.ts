export const USERS_MODULE = 'users' as const;

export const USERS_ERROR_CODES = {
    USER_NOT_FOUND: 'USERS_NOT_FOUND',
    /** `User.handle` is unique — renamed from USERNAME_TAKEN with the column. */
    HANDLE_TAKEN: 'USERS_HANDLE_TAKEN',
    EMAIL_TAKEN: 'USERS_EMAIL_TAKEN',
} as const;

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

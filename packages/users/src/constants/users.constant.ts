export const USERS_MODULE = 'users' as const;

export const USERS_ERROR_CODES = {
    USER_NOT_FOUND: 'USERS_NOT_FOUND',
    /** `User.handle` is unique — renamed from USERNAME_TAKEN with the column. */
    HANDLE_TAKEN: 'USERS_HANDLE_TAKEN',
    EMAIL_TAKEN: 'USERS_EMAIL_TAKEN',
} as const;

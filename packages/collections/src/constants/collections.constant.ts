export const COLLECTIONS_MODULE = 'collections' as const;

export const COLLECTIONS_ERROR_CODES = {
    ITEM_NOT_FOUND: 'COLLECTIONS_ITEM_NOT_FOUND',
    /** No such collector, or the account is deactivated or deleted. */
    USER_NOT_FOUND: 'COLLECTIONS_USER_NOT_FOUND',
    /** The collector's profile is PRIVATE: their shelf is not shown to others. */
    PROFILE_PRIVATE: 'COLLECTIONS_PROFILE_PRIVATE',
} as const;

export const COLLECTIONS_MAX_PAGE_SIZE = 50;
export const COLLECTIONS_DEFAULT_PAGE_SIZE = 20;

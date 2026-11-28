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

/** Another buyer's progress is never exposed; these two read a collection's own contents. */
export const COLLECTION_PROGRESS_ERROR_CODES = {
    /** No such collection, or it is private, deactivated or archived. */
    COLLECTION_NOT_FOUND: 'COLLECTIONS_COLLECTION_NOT_FOUND',
    /** No such artist, or the profile is not public. */
    ARTIST_NOT_FOUND: 'COLLECTIONS_ARTIST_NOT_FOUND',
} as const;

/**
 * Drop statuses that count towards "the set": a buyer can only own a drop
 * that has been released. Mirrors RELEASED_DROP_STATUSES in @hitbox/content
 * (the reward unlock rule), so progress here and the reward teaser agree.
 */
export const RELEASED_DROP_STATUSES = ['PUBLISHED', 'ACTIVE', 'ENDED'] as const;

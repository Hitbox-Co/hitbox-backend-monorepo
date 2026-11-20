export const SOCIAL_MODULE = 'social' as const;

export const WISHLIST_DEFAULT_PAGE_SIZE = 20;
export const WISHLIST_MAX_PAGE_SIZE = 50;
export const WISHLIST_NOTE_MAX_LENGTH = 500;

export const SOCIAL_ERROR_CODES = {
    /** The drop does not exist or is not publicly viewable. */
    PRODUCT_NOT_FOUND: 'SOCIAL_PRODUCT_NOT_FOUND',
    /** The variant does not belong to the drop, or is archived. */
    VARIANT_NOT_FOUND: 'SOCIAL_VARIANT_NOT_FOUND',
    /** No wishlist item with that id belongs to the caller. */
    WISHLIST_ITEM_NOT_FOUND: 'SOCIAL_WISHLIST_ITEM_NOT_FOUND',
    /** The collector does not exist, is deactivated or deleted. */
    USER_NOT_FOUND: 'SOCIAL_USER_NOT_FOUND',
    /** The artist does not exist or has no public profile. */
    ARTIST_NOT_FOUND: 'SOCIAL_ARTIST_NOT_FOUND',
    /** A user tried to follow themselves. */
    CANNOT_FOLLOW_SELF: 'SOCIAL_CANNOT_FOLLOW_SELF',
} as const;

export const FOLLOW_DEFAULT_PAGE_SIZE = 20;
export const FOLLOW_MAX_PAGE_SIZE = 50;

export const PRODUCTS_MODULE = 'products' as const;

export const PRODUCTS_ERROR_CODES = {
    PRODUCT_NOT_FOUND: 'PRODUCTS_NOT_FOUND',
    PRODUCT_CODE_TAKEN: 'PRODUCTS_CODE_TAKEN',
    TAG_TAKEN: 'PRODUCTS_TAG_TAKEN',
} as const;

export const PRODUCT_EVENTS = {
    PRODUCT_CREATED: 'products.product.created',
    PRODUCT_UPDATED: 'products.product.updated',
    PRODUCT_ARCHIVED: 'products.product.archived',
} as const;

/** productCode format: 8 unique digits + 4 group digits = 12 chars. */
export const PRODUCT_CODE_UNIQUE_LENGTH = 8;
export const PRODUCT_CODE_GROUP_LENGTH = 4;
export const DEFAULT_PRODUCT_GROUP_CODE = '0000';

/** Retries when a randomly generated productCode collides. */
export const PRODUCT_CODE_MAX_ATTEMPTS = 5;

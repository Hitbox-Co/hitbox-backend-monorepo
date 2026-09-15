/**
 * @hitbox/skus
 *
 * Serialized collectible instances (SKUs) and their NFC tag lifecycle.
 *
 * One row per physical object: its position in the edition, the tag UID that
 * proves it genuine, and whoever holds it. The catalog (@hitbox/products) says
 * what a drop *is*; this module says which objects exist.
 *
 * Two things this module deliberately does not do:
 *
 *   - **It writes no provenance.** The seq-0 MINT row of a unit's hash chain
 *     is created by @hitbox/claims on first use, so minting stays a catalog
 *     operation and the ledger stays append-only under one owner.
 *   - **It decides no visibility from role names.** How much of a unit a
 *     caller sees is resolved per request from their own grants — see
 *     domain/sku-access.ts.
 */

export { createSkusModule } from './module';
export type { SkusModule, SkusModuleDeps, SkusPermissionGuard } from './module';

export {
    SKU_READ_CAPABILITY,
    SKU_TAG_CAPABILITY,
    SKU_WRITE_CAPABILITY,
    SKU_EVENTS,
    SKUS_ERROR_CODES,
    SKUS_MODULE,
} from './constants/skus.constant';

export {
    bindTagSchema,
    bulkBindTagsSchema,
    listSkusQuerySchema,
    mintSkusSchema,
} from './dto/sku.dto';
export type {
    BindTagDto,
    BulkBindResult,
    BulkBindTagsDto,
    ListSkusQuery,
    MintResult,
    MintSkusDto,
    SkuDetail,
    SkuListItem,
    SkuSummary,
} from './dto/sku.dto';

export { buildSkuAccess, resolveAccess } from './domain/sku-access';
export type { SkuAccess, SkuPrincipal } from './domain/sku-access';

export type { SkuService, InlineMintSpec } from './service/sku.service';
export { formatSkuCode } from './repository/sku.repository';
export type { MintOutcome } from './repository/sku.repository';

export const MODULE_NAME = 'skus' as const;

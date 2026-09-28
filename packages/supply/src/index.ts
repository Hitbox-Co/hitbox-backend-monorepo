/**
 * @hitbox/supply
 *
 * The physical supply chain: vendors, received consignments, and the NFC chip
 * inventory that comes out of them.
 *
 * This is the upstream of @hitbox/skus. A `Sku` is a serialized *item*; a
 * `NfcTag` is the chip embedded in one, and it has a life the item does not —
 * it is QC'd before it is bound, it can be replaced while the item keeps its
 * history, and its UID must stay unique for ever even after it is retired.
 * `SupplyBatch` is where both came from.
 *
 * Two things this module deliberately does not do:
 *
 *   - **It binds no chips to items.** Registering a chip into inventory and
 *     embedding it in a unit are separate operations with separate
 *     capabilities; the second lives in @hitbox/skus.
 *   - **It never stores, logs or returns a tag UID in the clear.** The cipher
 *     is a port implemented at the bootstrap boundary, because the key belongs
 *     to the deployment and not to this package.
 */

export { createSupplyModule } from './module';
export type { SupplyModule, SupplyModuleDeps, SupplyPermissionGuard } from './module';

export {
    LOW_STOCK_THRESHOLD,
    SUPPLY_AUDIT_EVENTS,
    SUPPLY_DEFAULT_LIMIT,
    SUPPLY_ERROR_CODES,
    SUPPLY_EVENTS,
    SUPPLY_MANIFEST_MAX,
    SUPPLY_MAX_LIMIT,
    SUPPLY_METRICS_CAPABILITY,
    SUPPLY_MODULE,
    SUPPLY_READ_CAPABILITY,
    SUPPLY_TAG_READ_CAPABILITY,
    SUPPLY_WRITE_CAPABILITY,
} from './constants/supply.constant';

export {
    createBatchSchema,
    createVendorSchema,
    decideBatchSchema,
    listBatchesQuerySchema,
    listTagsQuerySchema,
    listVendorsQuerySchema,
    manifestRowSchema,
    recordQcSchema,
    registerTagsSchema,
    supplyMetricsQuerySchema,
    updateVendorSchema,
} from './dto/supply.dto';
export type {
    CreateBatchDto,
    CreateVendorDto,
    DecideBatchDto,
    ListBatchesQuery,
    ListTagsQuery,
    ListVendorsQuery,
    ManifestRow,
    NfcTagResponse,
    RecordQcDto,
    RegisterTagsDto,
    RegisterTagsResult,
    SupplyBatchResponse,
    SupplyMetrics,
    SupplyMetricsQuery,
    UpdateVendorDto,
    VendorResponse,
} from './dto/supply.dto';

/**
 * The access rules and the intake state machine, exported because they are the
 * authority on who sees what and which transitions are legal — a console that
 * wants to grey out a button should read the same list the API enforces rather
 * than keep a second copy of it.
 */
export {
    buildSupplyAccess,
    requireConsignmentAccess,
    requireGlobalConsignmentAccess,
    requireReportingAccess,
    requireTagAccess,
    requireWrite,
    resolveAccess,
    ReadScope,
    Visibility,
} from './domain/supply-access';
export type { SupplyAccess, SupplyPrincipal, ResourceAccess } from './domain/supply-access';

export { acceptsRows, canTransition, isTerminal, BATCH_TRANSITIONS } from './domain/batch-state';

export { NOOP_SUPPLY_AUDIT } from './domain/interfaces/supply-audit.interface';
export type { ISupplyAudit, SupplyAuditInput } from './domain/interfaces/supply-audit.interface';
export type { ITagCipher } from './domain/interfaces/tag-cipher.interface';

export type { SupplyService, SupplyMutationContext } from './service/supply.service';
export { percent } from './service/supply.service';
export { formatTagCode, nextTagOrdinal } from './repository/supply.repository';

export const MODULE_NAME = 'supply' as const;

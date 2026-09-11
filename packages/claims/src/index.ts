// Module factory
export { createClaimsModule } from './module';
export type { ClaimsModule, ClaimsModuleDeps, ClaimsRouters } from './module';

// Constants
export {
    CLAIM_OUTCOME,
    CLAIMS_ERROR_CODES,
    CLAIMS_EVENTS,
    CLAIMS_MODULE,
} from './constants/claims.constant';

// DTOs
export {
    claimBodySchema,
    tagIdParamSchema,
} from './dto/claims.dto';
export type {
    ClaimBodyDto,
    ClaimFlowResult,
    LedgerEntryView,
    OwnerView,
    ValidateResult,
    VerifyResult,
} from './dto/claims.dto';

// Event payload contracts (for subscribers in other modules)
export type {
    ProductClaimedPayload,
} from './events/claims-event.payloads';

// Port: bootstrap injects an adapter that turns a MediaAsset storageRef into
// a renderable URL. This module owns no object-storage knowledge itself.
export type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';

// Service type (for other modules that receive it via DI)
export type { ClaimsService } from './service/claims.service';

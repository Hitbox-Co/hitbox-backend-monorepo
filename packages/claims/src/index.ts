// Module factory
export { createClaimsModule } from './module';
export type { ClaimsModule, ClaimsModuleDeps, ClaimsRouters } from './module';

// Constants
export {
    CLAIM_OUTCOME,
    CLAIMS_ERROR_CODES,
    CLAIMS_EVENTS,
    CLAIMS_METRICS,
    CLAIMS_MODULE,
} from './constants/claims.constant';

// Claim tokens — the one-shot authorisation that ties a confirm to the
// validate before it. Exported for tests and for any future admin surface
// over the token table; the raw token itself never leaves the validate
// response.
export {
    CLAIM_TOKEN_TTL_SECONDS,
    ClaimTokenRejectedError,
    claimTokenExpiry,
    generateClaimToken,
    hashClaimToken,
    isClaimTokenRejected,
} from './domain/claim-token';
export type { ClaimTokenRejectionReason } from './domain/claim-token';

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
    ClaimRevokedPayload,
    ClaimTiebreakLostPayload,
    ClaimTokenRejectedPayload,
    ProductClaimedPayload,
} from './events/claims-event.payloads';

// Port: bootstrap injects an adapter that turns a MediaAsset storageRef into
// a renderable URL. This module owns no object-storage knowledge itself.
export type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';

// Service type (for other modules that receive it via DI)
export type { ClaimsService } from './service/claims.service';

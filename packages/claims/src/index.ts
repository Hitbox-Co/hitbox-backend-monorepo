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

// Service type (for other modules that receive it via DI)
export type { ClaimsService } from './service/claims.service';

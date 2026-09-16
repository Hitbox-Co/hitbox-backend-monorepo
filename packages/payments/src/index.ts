/**
 * @hitbox/payments
 *
 * Checkout, charges, webhook ingestion, the refund workflow, disputes, and
 * gateway configuration.
 *
 * Three properties this module exists to guarantee, all of them from
 * `docs/finance/finance-revenue-ledger.md`:
 *
 *   **Payment and ownership are decoupled.** Paying creates an order. Nothing
 *   is owned, and no royalty is earned, until the buyer taps the NFC tag.
 *
 *   **Webhooks are idempotent.** The provider's event id is the primary key of
 *   `PaymentWebhookEvent`, so the insert *is* the duplicate check — and the
 *   signature is verified before anything is written at all.
 *
 *   **Money never moves before the item is back.** A refund on a physical
 *   collectible waits for the return, records the tag's condition, revokes the
 *   claim, quarantines a damaged tag for 90 days, and reverses the royalty
 *   through an adjustment entry rather than a deletion.
 *
 * No card data and no credentials are stored anywhere in here:
 * `PaymentGatewayConfig.credentialsRef` is a pointer into the secrets manager,
 * and the DTO refuses to accept anything that looks like an actual API key.
 */

// Module factory
export { createPaymentsModule } from './module';
export type {
    PaymentsModule,
    PaymentsModuleDeps,
    PaymentsPermissionGuard,
} from './module';

// Constants
export {
    ORDER_CREATE_CAPABILITY,
    ORDER_REFUND_CAPABILITY,
    PAYMENTS_AUDIT_EVENTS,
    PAYMENTS_ERROR_CODES,
    PAYMENTS_MODULE,
    PAYMENT_CONFIGURE_CAPABILITY,
    PAYMENT_EVENTS,
    PAYMENT_MANAGE_CAPABILITY,
    PAYMENT_READ_CAPABILITY,
    RESALE_BLOCK_DAYS,
    STRIPE_EVENT_MAP,
} from './constants/payments.constant';

// Ports — consumer-defined here, implemented by other modules at bootstrap
export type {
    IOrderLedger,
    PlaceOrderInput,
    PlacedOrder,
} from './domain/interfaces/order-ledger.interface';
export type {
    IFinancePostings,
    IRoyaltyReversal,
} from './domain/interfaces/finance-postings.interface';
export type {
    IClaimRevocation,
    RevokeClaimInput,
    RevokeClaimResult,
} from './domain/interfaces/claim-revocation.interface';
export type {
    CreateChargeInput,
    CreateChargeResult,
    CreateRefundInput,
    CreateRefundResult,
    IPaymentGateway,
} from './domain/interfaces/payment-gateway.interface';
export { NOOP_PAYMENTS_AUDIT } from './domain/interfaces/audit-recorder.port';
export type {
    IPaymentsAuditRecorder,
    PaymentsAuditRecordInput,
} from './domain/interfaces/audit-recorder.port';

// Domain — exported because these are the parts worth testing and auditing
// against the design document directly.
export { verifyStripeSignature } from './domain/webhook-signature';
export type { VerifyResult } from './domain/webhook-signature';
export {
    REFUND_TRANSITIONS,
    canTransition,
    isDefectiveReturn,
    isTerminal,
    resaleBlockUntil,
} from './domain/refund-workflow';
export {
    buildPaymentAccess,
    PaymentScope,
    requireConfigure,
    requireManage,
    requireRefund,
} from './domain/payment-access';
export type { PaymentAccess, PaymentPrincipal } from './domain/payment-access';

// Services
export { CheckoutService } from './service/checkout.service';
export { PaymentService } from './service/payment.service';
export { RefundService } from './service/refund.service';
export { DisputeService } from './service/dispute.service';
export { GatewayConfigService } from './service/gateway-config.service';
export { WebhookService } from './service/webhook.service';
export type { WebhookOutcome } from './service/webhook.service';

// Controller contracts
export type {
    BuyerResolver,
    PaymentAccessResolver,
} from './controller/payments.controller';

// DTOs
export {
    approveRefundSchema,
    checkoutSchema,
    confirmReturnSchema,
    createGatewayConfigSchema,
    listDisputesQuerySchema,
    listPaymentsQuerySchema,
    listRefundsQuerySchema,
    openDisputeSchema,
    processRefundSchema,
    rejectRefundSchema,
    requestRefundSchema,
    resolveDisputeSchema,
    reviewPaymentSchema,
} from './dto/payments.dto';
export type {
    CheckoutView,
    DisputeView,
    GatewayConfigView,
    PaymentTransactionView,
    RefundView,
    WebhookEventView,
} from './dto/payments.dto';

/**
 * @hitbox/finance
 *
 * Royalty rules, royalty accrual, payout batches, corrections, and the
 * platform's own revenue ledger.
 *
 * Two ideas carry the whole module, and both come straight from
 * `docs/finance/finance-revenue-ledger.md`:
 *
 *   **Accrual happens at the claim, not at the payment.** HitBox has not
 *   earned anything until the physical collectible is in the buyer's hands and
 *   its NFC tag has been tapped. So the trigger is `claims.product.claimed`.
 *
 *   **Nothing is ever edited or deleted.** A mistake is corrected by posting an
 *   `AdjustmentEntry` that points back at what it corrects, and — if the money
 *   has already gone out — a negative ledger entry that nets off the next
 *   batch. The original row always keeps saying what it originally said.
 *
 * What other modules need from here is the two adapters on the module object:
 * `royaltyReversal` (payments calls it when money goes back) and `postings`
 * (payments calls it to book a sale, refund or chargeback). Nothing outside
 * this package writes a ledger row.
 */

// Module factory
export { createFinanceModule } from './module';
export type {
    ClaimedEventPayload,
    FinanceModule,
    FinanceModuleDeps,
    FinancePermissionGuard,
} from './module';

// Constants
export {
    FINANCE_AUDIT_EVENTS,
    FINANCE_ERROR_CODES,
    FINANCE_EVENTS,
    FINANCE_MANAGE_CAPABILITY,
    FINANCE_MODULE,
    FINANCE_OVERRIDE_CAPABILITY,
    FINANCE_READ_CAPABILITY,
    RESALE_BLOCK_DAYS,
    ROYALTY_DEFAULT_PAYOUT_FREQUENCY,
    ROYALTY_DEFAULT_PAYOUT_THRESHOLD,
} from './constants/finance.constant';

// Ports — the consumer-defined interfaces bootstrap fills in
export type {
    IOrderRevenueSource,
    OrderRevenueSnapshot,
} from './domain/interfaces/order-revenue.interface';
export { NOOP_FINANCE_AUDIT } from './domain/interfaces/audit-recorder.port';
export type {
    FinanceAuditRecordInput,
    IFinanceAuditRecorder,
} from './domain/interfaces/audit-recorder.port';

// The calculation, exported because it is the part other people will want to
// check against the design document by hand.
export {
    accrualKeyFor,
    calculateRoyalty,
    resolveRule,
    reversalKeyFor,
    splitsOf,
    toMoney,
    RULE_SCOPE_ORDER,
} from './domain/royalty-calculation';
export type {
    RoyaltyCalculation,
    RoyaltyCalculationInput,
    RoyaltySplit,
    ScopedRule,
} from './domain/royalty-calculation';

// Access resolution
export { buildFinanceAccess, FinanceScope, requireManage, requireOverride } from './domain/finance-access';
export type { FinanceAccess, FinancePrincipal } from './domain/finance-access';

// Services (constructed by the factory; exported for jobs and tests)
export { RoyaltyRuleService } from './service/royalty-rule.service';
export { RoyaltyAccrualService } from './service/royalty-accrual.service';
export type {
    AccrualResult,
    ReversalInput,
    ReversalResult,
} from './service/royalty-accrual.service';
export { RoyaltyPayoutService } from './service/royalty-payout.service';
export { FinanceLedgerService } from './service/finance-ledger.service';

// Controller contract
export type { FinanceAccessResolver } from './controller/finance.controller';

// DTOs
export {
    closeRoyaltyRuleSchema,
    createAdjustmentSchema,
    createRoyaltyRuleSchema,
    listAdjustmentsQuerySchema,
    listFinanceEntriesQuerySchema,
    listPayoutsQuerySchema,
    listRoyaltyEntriesQuerySchema,
    listRoyaltyRulesQuerySchema,
    revenueSummaryQuerySchema,
    reverseRoyaltyEntrySchema,
    schedulePayoutsSchema,
} from './dto/finance.dto';
export type {
    AdjustmentView,
    FinanceEntryView,
    PayoutView,
    RevenueSummaryView,
    RoyaltyBalanceView,
    RoyaltyEntryView,
    RoyaltyRuleView,
} from './dto/finance.dto';

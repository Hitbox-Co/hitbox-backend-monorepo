import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    FINANCE_MANAGE_CAPABILITY,
    FINANCE_MODULE,
    FINANCE_READ_CAPABILITY,
} from './constants/finance.constant';
import { FinanceController } from './controller/finance.controller';
import type { FinanceAccessResolver } from './controller/finance.controller';
import type { IFinanceAuditRecorder } from './domain/interfaces/audit-recorder.port';
import { NOOP_FINANCE_AUDIT } from './domain/interfaces/audit-recorder.port';
import type { IOrderRevenueSource } from './domain/interfaces/order-revenue.interface';
import { FinanceLedgerRepository } from './repository/finance-ledger.repository';
import { PayoutRepository } from './repository/payout.repository';
import { RoyaltyLedgerRepository } from './repository/royalty-ledger.repository';
import { RoyaltyRuleRepository } from './repository/royalty-rule.repository';
import { FinanceLedgerService } from './service/finance-ledger.service';
import { RoyaltyAccrualService } from './service/royalty-accrual.service';
import { RoyaltyPayoutService } from './service/royalty-payout.service';
import { RoyaltyRuleService } from './service/royalty-rule.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface FinancePermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

/** The claim event this module accrues against. Matches @hitbox/claims. */
export interface ClaimedEventPayload {
    claimId: string;
    skuId: string;
    productId: string;
    userId: string;
}

export interface FinanceModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: FinancePermissionGuard;
    resolveAccess: FinanceAccessResolver;
    /** Orders answers "what was this unit sold for" — see the port. */
    orderRevenue: IOrderRevenueSource;
    /** Defaults to a no-op so unit tests need no audit wiring. */
    audit?: IFinanceAuditRecorder;
    /**
     * The event name to accrue on. Defaults to the claims module's
     * `claims.product.claimed`; injectable so a test can drive the subscriber
     * without importing the claims package.
     */
    claimEventName?: string;
}

export interface FinanceModule {
    /** Consumed by payments: reverse royalties when money goes back. */
    royaltyReversal: Pick<RoyaltyAccrualService, 'reverseForOrder'>;
    /** Consumed by payments: book sales, refunds, chargebacks, corrections. */
    postings: Pick<
        FinanceLedgerService,
        'postSaleRevenue' | 'postRefund' | 'postChargeback' | 'postAdjustment'
    >;
    /** Exposed for jobs and scripts that run the sweep without HTTP. */
    payouts: RoyaltyPayoutService;
    accrual: RoyaltyAccrualService;
    createRouter(requireAuth: RequestHandler): Router;
}

/**
 * Wires the finance module.
 *
 * The one subscription is the important line in this file: royalties accrue on
 * `claims.product.claimed`, because HitBox has not earned anything until the
 * physical item is in the buyer's hands. Everything else here is plumbing.
 */
export function createFinanceModule(deps: FinanceModuleDeps): FinanceModule {
    const logger = createModuleLogger(FINANCE_MODULE);
    const audit = deps.audit ?? NOOP_FINANCE_AUDIT;

    const ruleRepo = new RoyaltyRuleRepository(deps.prisma);
    const ledgerRepo = new RoyaltyLedgerRepository(deps.prisma);
    const payoutRepo = new PayoutRepository(deps.prisma);
    const financeLedgerRepo = new FinanceLedgerRepository(deps.prisma);

    const rules = new RoyaltyRuleService({ rules: ruleRepo, logger });
    const accrual = new RoyaltyAccrualService({
        prisma: deps.prisma,
        rules: ruleRepo,
        ledger: ledgerRepo,
        financeLedger: financeLedgerRepo,
        orderRevenue: deps.orderRevenue,
        eventBus: deps.eventBus,
        audit,
        logger,
    });
    const payouts = new RoyaltyPayoutService({
        prisma: deps.prisma,
        payouts: payoutRepo,
        ledger: ledgerRepo,
        financeLedger: financeLedgerRepo,
        rules: ruleRepo,
        eventBus: deps.eventBus,
        audit,
        logger,
    });
    const ledger = new FinanceLedgerService({
        financeLedger: financeLedgerRepo,
        ledger: ledgerRepo,
        eventBus: deps.eventBus,
        audit,
        logger,
    });

    // Accrue at the claim. The handler swallows its own errors on purpose: the
    // event bus isolates a throwing subscriber already, but a royalty that
    // could not be posted is an operational problem to alert on, not a lost
    // claim — so it is logged with everything needed to replay it by hand.
    deps.eventBus.subscribe<ClaimedEventPayload>(
        deps.claimEventName ?? 'claims.product.claimed',
        async (payload) => {
            try {
                await accrual.accrueForClaim(payload);
            } catch (error) {
                logger.error(
                    { err: error, claimId: payload.claimId, skuId: payload.skuId },
                    'royalty accrual failed for claim — replay required',
                );
            }
        },
    );

    const controller = new FinanceController({
        rules,
        accrual,
        payouts,
        ledger,
        resolveAccess: deps.resolveAccess,
    });

    return {
        royaltyReversal: accrual,
        postings: ledger,
        payouts,
        accrual,

        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            const { requirePermission } = deps.guard;

            // Reads take the plain read capability; the SCOPE of that grant
            // (own / organization / global) is what narrows the rows, and it is
            // resolved from the grant inside the service. An artist calling
            // GET /royalty-entries gets their own accrual and nothing else.
            const read = requirePermission(FINANCE_READ_CAPABILITY);
            // Writes are global-only in the catalog; `globalOnly` makes the
            // guard say so rather than relying on the service alone.
            const manage = requirePermission(FINANCE_MANAGE_CAPABILITY, { globalOnly: true });

            // Royalty rules
            router.get('/royalty-rules', read, controller.listRules);
            router.post('/royalty-rules', manage, controller.createRule);
            router.get('/royalty-rules/:ruleId', read, controller.getRule);
            // No PUT/PATCH and no DELETE: terms are versioned, not edited.
            router.post('/royalty-rules/:ruleId/close', manage, controller.closeRule);

            // Royalty ledger
            router.get('/royalty-entries', read, controller.listEntries);
            router.get('/royalty-entries/:entryId', read, controller.getEntry);
            router.post(
                '/royalty-entries/:entryId/reverse',
                // `manage` on the route, `override` re-checked in the
                // controller — two different powers, and the second one is
                // the one that cancels money someone is owed.
                manage,
                controller.reverseEntry,
            );

            // Balances & payouts
            router.get('/balances', read, controller.balances);
            router.get('/payouts', read, controller.listPayouts);
            router.post('/payouts/schedule', manage, controller.schedulePayouts);
            router.get('/payouts/:payoutId', read, controller.getPayout);
            router.post('/payouts/:payoutId/approve', manage, controller.approvePayout);
            router.post('/payouts/:payoutId/execute', manage, controller.executePayout);
            router.post('/payouts/:payoutId/fail', manage, controller.failPayout);

            // Corrections and the platform's own books
            router.get('/adjustments', read, controller.listAdjustments);
            router.post('/adjustments', manage, controller.createAdjustment);
            router.get('/ledger', read, controller.listLedger);
            router.get('/revenue-summary', read, controller.revenueSummary);

            return router;
        },
    };
}

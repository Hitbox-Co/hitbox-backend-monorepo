import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    ORDER_CREATE_CAPABILITY,
    ORDER_REFUND_CAPABILITY,
    PAYMENTS_MODULE,
    PAYMENT_CONFIGURE_CAPABILITY,
    PAYMENT_MANAGE_CAPABILITY,
    PAYMENT_READ_CAPABILITY,
} from './constants/payments.constant';
import { PaymentsController } from './controller/payments.controller';
import type {
    BuyerResolver,
    PaymentAccessResolver,
} from './controller/payments.controller';
import { WebhookController } from './controller/webhook.controller';
import type { IPaymentsAuditRecorder } from './domain/interfaces/audit-recorder.port';
import { NOOP_PAYMENTS_AUDIT } from './domain/interfaces/audit-recorder.port';
import type { IClaimRevocation } from './domain/interfaces/claim-revocation.interface';
import type {
    IFinancePostings,
    IRoyaltyReversal,
} from './domain/interfaces/finance-postings.interface';
import type { IOrderLedger } from './domain/interfaces/order-ledger.interface';
import type { IPaymentGateway } from './domain/interfaces/payment-gateway.interface';
import { DisputeRepository } from './repository/dispute.repository';
import { GatewayConfigRepository } from './repository/gateway-config.repository';
import { PaymentRepository } from './repository/payment.repository';
import { RefundRepository } from './repository/refund.repository';
import { WebhookRepository } from './repository/webhook.repository';
import { CheckoutService } from './service/checkout.service';
import { DisputeService } from './service/dispute.service';
import { GatewayConfigService } from './service/gateway-config.service';
import { PaymentService } from './service/payment.service';
import { RefundService } from './service/refund.service';
import { WebhookService } from './service/webhook.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface PaymentsPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface PaymentsModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: PaymentsPermissionGuard;
    resolveAccess: PaymentAccessResolver;
    resolveBuyer: BuyerResolver;

    // ── Ports (consumer-defined here, implemented elsewhere) ────────────────
    /** Orders: place, settle, cancel, refund an order; release stock holds. */
    orders: IOrderLedger;
    /** Finance: book the sale, the refund, the chargeback, the correction. */
    finance: IFinancePostings;
    /** Finance: un-earn the artist's royalty when money goes back. */
    royalties: IRoyaltyReversal;
    /** Claims: revoke ownership and quarantine the tag on a refund. */
    claims: IClaimRevocation;

    /**
     * The provider adapter. Optional: without one the platform still records
     * orders, charges and refunds and still ingests webhooks — it just cannot
     * initiate a charge or a refund server-side, so those are completed in the
     * provider's own flow and confirmed by webhook. See the port's header.
     */
    gateway?: IPaymentGateway | undefined;

    /**
     * Stripe's webhook signing secret. **Without it the webhook route is not
     * mounted at all** — an unverified payment webhook is a way to mark any
     * order paid, so "no secret" must mean "no endpoint", not "an endpoint
     * that trusts whatever arrives".
     */
    webhookSigningSecret?: string | undefined;
    webhookToleranceSeconds?: number;
    /** How long a checkout holds a unit. Defaults to 15 minutes. */
    holdSeconds?: number;
    audit?: IPaymentsAuditRecorder;
}

export interface PaymentsModule {
    /** Buyer-facing: POST /checkout, POST /refunds. */
    createBuyerRouter(requireAuth: RequestHandler): Router;
    /** Operator-facing: transactions, refund workflow, disputes, gateways. */
    createAdminRouter(requireAuth: RequestHandler): Router;
    /**
     * The provider's endpoint. Null when no signing secret is configured —
     * bootstrap mounts a clear 503 in its place rather than an open endpoint.
     */
    createWebhookRouter(): Router | null;
    /** For the scheduled sweeper that frees expired stock holds. */
    releaseExpiredReservations(now?: Date): Promise<number>;
}

export function createPaymentsModule(deps: PaymentsModuleDeps): PaymentsModule {
    const logger = createModuleLogger(PAYMENTS_MODULE);
    const audit = deps.audit ?? NOOP_PAYMENTS_AUDIT;

    const paymentRepo = new PaymentRepository(deps.prisma);
    const gatewayConfigRepo = new GatewayConfigRepository(deps.prisma);
    const webhookRepo = new WebhookRepository(deps.prisma);
    const refundRepo = new RefundRepository(deps.prisma);
    const disputeRepo = new DisputeRepository(deps.prisma);

    const paymentService = new PaymentService({
        payments: paymentRepo,
        orders: deps.orders,
        finance: deps.finance,
        eventBus: deps.eventBus,
        audit,
        logger,
    });

    const checkoutService = new CheckoutService({
        orders: deps.orders,
        payments: paymentRepo,
        gatewayConfigs: gatewayConfigRepo,
        gateway: deps.gateway,
        eventBus: deps.eventBus,
        logger,
        holdSeconds: deps.holdSeconds ?? 900,
    });

    const refundService = new RefundService({
        refunds: refundRepo,
        payments: paymentRepo,
        gatewayConfigs: gatewayConfigRepo,
        orders: deps.orders,
        finance: deps.finance,
        royalties: deps.royalties,
        claims: deps.claims,
        gateway: deps.gateway,
        eventBus: deps.eventBus,
        audit,
        logger,
    });

    const disputeService = new DisputeService({
        disputes: disputeRepo,
        payments: paymentRepo,
        orders: deps.orders,
        finance: deps.finance,
        royalties: deps.royalties,
        eventBus: deps.eventBus,
        audit,
        logger,
    });

    const gatewayConfigService = new GatewayConfigService({
        configs: gatewayConfigRepo,
        audit,
        logger,
    });

    const webhookService = deps.webhookSigningSecret
        ? new WebhookService({
            webhooks: webhookRepo,
            payments: paymentRepo,
            paymentService,
            refunds: refundService,
            disputes: disputeService,
            signingSecret: deps.webhookSigningSecret,
            toleranceSeconds: deps.webhookToleranceSeconds ?? 300,
            logger,
        })
        : null;

    if (!webhookService) {
        logger.warn(
            'no webhook signing secret configured — the payment webhook route will not be mounted, so no order can be settled automatically',
        );
    }

    const controller = new PaymentsController({
        checkout: checkoutService,
        payments: paymentService,
        refunds: refundService,
        disputes: disputeService,
        gatewayConfigs: gatewayConfigService,
        webhooks: webhookRepo,
        resolveAccess: deps.resolveAccess,
        resolveBuyer: deps.resolveBuyer,
    });

    return {
        createBuyerRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            const { requirePermission } = deps.guard;

            router.post(
                '/checkout',
                requirePermission(ORDER_CREATE_CAPABILITY),
                controller.checkout,
            );
            // A buyer raising a refund on their own order needs no operator
            // grant; the service checks ownership and demands `order:refund`
            // only when the requester is not the buyer.
            router.post('/refunds', controller.requestRefund);

            return router;
        },

        createAdminRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            const { requirePermission } = deps.guard;

            const read = requirePermission(PAYMENT_READ_CAPABILITY);
            const manage = requirePermission(PAYMENT_MANAGE_CAPABILITY, { globalOnly: true });
            const refund = requirePermission(ORDER_REFUND_CAPABILITY, { globalOnly: true });
            const configure = requirePermission(PAYMENT_CONFIGURE_CAPABILITY, {
                globalOnly: true,
            });

            // Transactions
            router.get('/transactions', read, controller.listPayments);
            router.get('/transactions/:paymentId', read, controller.getPayment);
            router.post('/transactions/:paymentId/review', manage, controller.reviewPayment);

            // Refund workflow — the design document's D4-35 sequence, in order.
            router.get('/refunds', read, controller.listRefunds);
            router.get('/refunds/:refundId', read, controller.getRefund);
            router.post('/refunds/:refundId/confirm-return', refund, controller.confirmReturn);
            router.post('/refunds/:refundId/approve', refund, controller.approveRefund);
            router.post('/refunds/:refundId/reject', refund, controller.rejectRefund);
            router.post('/refunds/:refundId/process', refund, controller.processRefund);

            // Disputes
            router.get('/disputes', read, controller.listDisputes);
            router.post('/disputes', manage, controller.openDispute);
            router.get('/disputes/:disputeId', read, controller.getDispute);
            router.post('/disputes/:disputeId/evidence', manage, controller.submitEvidence);
            router.post('/disputes/:disputeId/resolve', manage, controller.resolveDispute);

            // Gateway configuration — System Admin only, by capability.
            router.get('/gateway-configs', configure, controller.listGatewayConfigs);
            router.post('/gateway-configs', configure, controller.createGatewayConfig);
            router.patch(
                '/gateway-configs/:configId',
                configure,
                controller.updateGatewayConfig,
            );

            // The replay queue.
            router.get('/webhook-events', manage, controller.listWebhookEvents);

            return router;
        },

        createWebhookRouter() {
            if (!webhookService) return null;
            const router = Router();
            const webhookController = new WebhookController(webhookService);
            router.post('/stripe', webhookController.stripe);
            return router;
        },

        releaseExpiredReservations(now = new Date()) {
            return deps.orders.releaseExpiredReservations(now);
        },
    };
}

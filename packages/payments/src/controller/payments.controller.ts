import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import type { PaymentAccess } from '../domain/payment-access';
import {
    approveRefundSchema,
    checkoutSchema,
    confirmReturnSchema,
    createGatewayConfigSchema,
    listDisputesQuerySchema,
    listGatewayConfigsQuerySchema,
    listPaymentsQuerySchema,
    listRefundsQuerySchema,
    listWebhookEventsQuerySchema,
    openDisputeSchema,
    processRefundSchema,
    rejectRefundSchema,
    requestRefundSchema,
    resolveDisputeSchema,
    reviewPaymentSchema,
    submitEvidenceSchema,
    updateGatewayConfigSchema,
} from '../dto/payments.dto';
import type { WebhookRepository } from '../repository/webhook.repository';
import type { CheckoutService } from '../service/checkout.service';
import type { DisputeService } from '../service/dispute.service';
import type { GatewayConfigService } from '../service/gateway-config.service';
import type { PaymentService } from '../service/payment.service';
import type { RefundService } from '../service/refund.service';

/** Resolves the caller's grants. Supplied by bootstrap. */
export type PaymentAccessResolver = (req: Request) => Promise<PaymentAccess>;
/** Resolves just the authenticated buyer id, for the checkout route. */
export type BuyerResolver = (req: Request) => string;

export interface PaymentsControllerDeps {
    checkout: CheckoutService;
    payments: PaymentService;
    refunds: RefundService;
    disputes: DisputeService;
    gatewayConfigs: GatewayConfigService;
    webhooks: WebhookRepository;
    resolveAccess: PaymentAccessResolver;
    resolveBuyer: BuyerResolver;
}

export class PaymentsController {
    constructor(private readonly deps: PaymentsControllerDeps) { }

    // ── Buyer ───────────────────────────────────────────────────────────────

    /** POST /checkout */
    checkout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = checkoutSchema.parse(req.body);
        const buyerId = this.deps.resolveBuyer(req);
        res.status(201).json({ data: await this.deps.checkout.checkout(dto, buyerId) });
    });

    /** POST /refunds — a buyer on their own order, or support on any. */
    requestRefund: RequestHandler = asyncHandler(async (req, res) => {
        const dto = requestRefundSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({
            data: await this.deps.refunds.request(dto, access.userId, access),
        });
    });

    // ── Payment transactions ────────────────────────────────────────────────

    listPayments: RequestHandler = asyncHandler(async (req, res) => {
        const query = listPaymentsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.payments.list(query, access));
    });

    getPayment: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payments.getById(req.params.paymentId as string, access),
        });
    });

    reviewPayment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = reviewPaymentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payments.review(req.params.paymentId as string, dto, access),
        });
    });

    // ── Refund workflow ─────────────────────────────────────────────────────

    listRefunds: RequestHandler = asyncHandler(async (req, res) => {
        const query = listRefundsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.refunds.list(query, access));
    });

    getRefund: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.refunds.getById(req.params.refundId as string, access),
        });
    });

    confirmReturn: RequestHandler = asyncHandler(async (req, res) => {
        const dto = confirmReturnSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.refunds.confirmReturn(
                req.params.refundId as string,
                dto,
                access,
            ),
        });
    });

    approveRefund: RequestHandler = asyncHandler(async (req, res) => {
        const dto = approveRefundSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.refunds.approve(req.params.refundId as string, dto, access),
        });
    });

    rejectRefund: RequestHandler = asyncHandler(async (req, res) => {
        const dto = rejectRefundSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.refunds.reject(req.params.refundId as string, dto, access),
        });
    });

    processRefund: RequestHandler = asyncHandler(async (req, res) => {
        const dto = processRefundSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.refunds.process(req.params.refundId as string, dto, access),
        });
    });

    // ── Disputes ────────────────────────────────────────────────────────────

    listDisputes: RequestHandler = asyncHandler(async (req, res) => {
        const query = listDisputesQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.disputes.list(query, access));
    });

    getDispute: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.disputes.getById(req.params.disputeId as string, access),
        });
    });

    openDispute: RequestHandler = asyncHandler(async (req, res) => {
        const dto = openDisputeSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.disputes.open(dto, access) });
    });

    submitEvidence: RequestHandler = asyncHandler(async (req, res) => {
        const dto = submitEvidenceSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.disputes.submitEvidence(
                req.params.disputeId as string,
                dto,
                access,
            ),
        });
    });

    resolveDispute: RequestHandler = asyncHandler(async (req, res) => {
        const dto = resolveDisputeSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.disputes.resolve(
                req.params.disputeId as string,
                dto,
                access,
            ),
        });
    });

    // ── Gateway configuration ───────────────────────────────────────────────

    listGatewayConfigs: RequestHandler = asyncHandler(async (req, res) => {
        const query = listGatewayConfigsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.gatewayConfigs.list(query, access));
    });

    createGatewayConfig: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createGatewayConfigSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.gatewayConfigs.create(dto, access) });
    });

    updateGatewayConfig: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateGatewayConfigSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.gatewayConfigs.update(
                req.params.configId as string,
                dto,
                access,
            ),
        });
    });

    // ── Webhook deliveries (the replay queue) ───────────────────────────────

    listWebhookEvents: RequestHandler = asyncHandler(async (req, res) => {
        const query = listWebhookEventsQuerySchema.parse(req.query);
        await this.deps.resolveAccess(req);
        const { total, items } = await this.deps.webhooks.list({
            ...query,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        res.json({
            page: query.page,
            limit: query.limit,
            total,
            // The stored `payload` is deliberately not returned: it is the
            // provider's raw JSON, it can contain cardholder detail, and the
            // screen this feeds only needs to know what arrived and whether it
            // processed.
            items: items.map((row) => ({
                id: row.id,
                provider: row.provider,
                eventType: row.eventType,
                signatureVerified: row.signatureVerified,
                processedAt: row.processedAt?.toISOString() ?? null,
                processingError: row.processingError,
                receivedAt: row.receivedAt.toISOString(),
            })),
        });
    });
}

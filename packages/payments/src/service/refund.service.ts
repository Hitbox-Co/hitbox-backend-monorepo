import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { RefundRequest } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_AUDIT_EVENTS,
    PAYMENTS_ERROR_CODES,
    PAYMENT_EVENTS,
} from '../constants/payments.constant';
import type { IPaymentsAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type { IClaimRevocation } from '../domain/interfaces/claim-revocation.interface';
import type {
    IFinancePostings,
    IRoyaltyReversal,
} from '../domain/interfaces/finance-postings.interface';
import type { IOrderLedger } from '../domain/interfaces/order-ledger.interface';
import type { CreateRefundResult, IPaymentGateway } from '../domain/interfaces/payment-gateway.interface';
import { gatewayFailure } from '../domain/gateway-error';
import { toMinorUnits } from '../domain/minor-units';
import type { PaymentAccess } from '../domain/payment-access';
import { PaymentScope, requireRefund } from '../domain/payment-access';
import {
    REFUND_TRANSITIONS,
    canTransition,
    refundActions,
    resaleBlockUntil,
} from '../domain/refund-workflow';
import type {
    ApproveRefundDto,
    ConfirmReturnDto,
    ListRefundsQuery,
    ProcessRefundDto,
    RefundView,
    RejectRefundDto,
    RequestRefundDto,
} from '../dto/payments.dto';
import type { GatewayConfigRepository } from '../repository/gateway-config.repository';
import type { PaymentRepository } from '../repository/payment.repository';
import type { RefundRepository } from '../repository/refund.repository';

export interface RefundServiceDeps {
    refunds: RefundRepository;
    payments: PaymentRepository;
    gatewayConfigs: GatewayConfigRepository;
    orders: IOrderLedger;
    finance: IFinancePostings;
    royalties: IRoyaltyReversal;
    claims: IClaimRevocation;
    gateway?: IPaymentGateway | undefined;
    eventBus: IEventBus;
    audit: IPaymentsAuditRecorder;
    logger: Logger;
}

/** A provider refund object, as the webhook hands it over. */
export interface GatewayRefundUpdate {
    /** The provider event type — `refund.created`, `refund.updated`, `refund.failed`. */
    eventType: string;
    gatewayRefundId: string;
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
    failureReason: string | null;
    /** `metadata.refundRequestId` — present on refunds this platform issued. */
    refundRequestId: string | null;
    /** The charge it refunds: PaymentIntent and/or Charge ids. */
    paymentRefs: string[];
    /** In minor units, as the provider reports it. */
    amountMinor: number | null;
    occurredAt: Date;
    correlationId: string;
}

/**
 * The refund workflow, end to end.
 *
 * The design document's day-15-to-21 sequence, as five methods:
 *
 *     request        buyer or support raises it
 *     confirmReturn  the warehouse has the item, and the tag's condition
 *     approve        a HitBox admin decides, with the item in hand
 *     process        the money goes back, the claim is revoked, the tag is
 *                    quarantined, and the royalty is reversed
 *     reject         none of the above
 *
 * `process` is the interesting one, because a HitBox refund is four different
 * reversals that have to happen together:
 *
 *   1. **the money** — back to the buyer through the provider;
 *   2. **the ownership** — the buyer's claim on the physical item is revoked,
 *      or they keep a certificate of authenticity for something they returned;
 *   3. **the tag** — quarantined for 90 days if it came back damaged, because
 *      a tag that "stopped responding" may equally have been cloned;
 *   4. **the royalty** — reversed via an adjustment entry, never by deleting
 *      the accrual, so the artist's statement still shows what happened.
 *
 * Steps 2 and 4 are other modules' jobs and happen through ports. Step 2
 * failing does not roll back step 1 — the money is already gone — so it is
 * recorded, alerted on, and left for an operator rather than retried blindly.
 */
export class RefundService {
    constructor(private readonly deps: RefundServiceDeps) { }

    // ── 1. Request ──────────────────────────────────────────────────────────

    async request(
        dto: RequestRefundDto,
        requestedById: string,
        access: PaymentAccess,
    ): Promise<RefundView> {
        const order = await this.deps.orders.findOrderSummary(dto.orderId);
        if (!order) {
            throw AppError.notFound('Order not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }

        // A buyer may raise a refund on their own order; anyone else needs the
        // refund grant. Support raising one on a buyer's behalf is the second
        // case, not a special third one.
        if (order.buyerId !== requestedById) {
            requireRefund(access, 'raise a refund on another buyer’s order');
        }

        if (!['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
            throw AppError.badRequest(
                `An order that is ${order.status} cannot be refunded.`,
                PAYMENTS_ERROR_CODES.NOT_REFUNDABLE,
                { status: order.status },
            );
        }

        const open = await this.deps.refunds.findOpenForOrder(dto.orderId);
        if (open) {
            throw AppError.conflict(
                'A refund is already in progress for this order.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
                { refundRequestId: open.id, status: open.status },
            );
        }

        const orderAmount = new Prisma.Decimal(order.amount);
        const requested = dto.amount ? new Prisma.Decimal(dto.amount) : orderAmount;
        const alreadyRefunded = await this.deps.refunds.refundedTotal(dto.orderId);
        if (requested.plus(alreadyRefunded).greaterThan(orderAmount)) {
            throw AppError.badRequest(
                'This would refund more than the order was charged.',
                PAYMENTS_ERROR_CODES.AMOUNT_EXCEEDS_CAPTURE,
                {
                    orderAmount: orderAmount.toFixed(2),
                    alreadyRefunded: alreadyRefunded.toFixed(2),
                    requested: requested.toFixed(2),
                },
            );
        }

        const now = new Date();
        const refund = await this.deps.refunds.create({
            id: randomUUID(),
            orderId: dto.orderId,
            requestedById,
            reason: dto.reason,
            reasonCode: dto.reasonCode,
            // A physical item goes straight to AWAITING_RETURN: there is no
            // state in which someone has decided to approve it yet, and
            // starting at REQUESTED would make the return look optional.
            status: dto.physicalReturnRequired ? 'AWAITING_RETURN' : 'REQUESTED',
            amount: requested,
            currency: order.currency as never,
            physicalReturnRequired: dto.physicalReturnRequired,
            createdAt: now,
            updatedAt: now,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.REFUND_REQUESTED, {
            refundRequestId: refund.id,
            orderId: dto.orderId,
            amount: requested.toFixed(2),
            currency: order.currency,
            reasonCode: dto.reasonCode,
        });
        this.deps.logger.info(
            { refundRequestId: refund.id, orderId: dto.orderId, reasonCode: dto.reasonCode },
            'refund requested',
        );

        return this.toView(refund, access);
    }

    // ── 2. Physical return ──────────────────────────────────────────────────

    /**
     * The warehouse has the item, and this is what the tag looked like.
     *
     * The tag condition is recorded here, not at approval, because it is an
     * observation rather than a decision — and because it is what the approval
     * is *based* on. It drives the resale quarantine computed at step 5.
     */
    async confirmReturn(
        id: string,
        dto: ConfirmReturnDto,
        access: PaymentAccess,
    ): Promise<RefundView> {
        requireRefund(access, 'confirm a physical return');
        const refund = await this.requireInScope(id, access);

        if (refund.status !== 'AWAITING_RETURN' && refund.status !== 'REQUESTED') {
            throw AppError.conflict(
                `A refund that is ${refund.status} is past the return step.`,
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const receivedAt = dto.receivedAt ?? new Date();
        const changed = await this.deps.refunds.transition({
            id,
            from: refund.status,
            data: {
                status: 'AWAITING_RETURN',
                physicalReturnConfirmedAt: receivedAt,
                nfcTagCondition: dto.nfcTagCondition,
            },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This refund changed while you were updating it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.ORDER_REFUND,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'RefundRequest', id },
            afterState: {
                physicalReturnConfirmedAt: receivedAt.toISOString(),
                nfcTagCondition: dto.nfcTagCondition,
                note: dto.note ?? null,
            },
            correlationId: randomUUID(),
        });

        return this.getById(id, access);
    }

    // ── 3. Approve / reject ─────────────────────────────────────────────────

    /**
     * A person decides.
     *
     * The physical-return gate is enforced here and can only be stepped past
     * with an explicit override *and* a reason — a lost shipment or a goodwill
     * refund is a legitimate thing to do, and it should be legible as a
     * decision in the trail rather than indistinguishable from a normal
     * approval.
     */
    async approve(
        id: string,
        dto: ApproveRefundDto,
        access: PaymentAccess,
    ): Promise<RefundView> {
        requireRefund(access, 'approve refunds');
        const refund = await this.requireInScope(id, access);

        if (!canTransition(refund.status, 'APPROVED')) {
            throw AppError.conflict(
                `A refund that is ${refund.status} cannot be approved.`,
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
                { allowed: REFUND_TRANSITIONS[refund.status] },
            );
        }

        const returnOutstanding =
            refund.physicalReturnRequired && refund.physicalReturnConfirmedAt === null;
        if (returnOutstanding && !dto.overridePhysicalReturn) {
            throw AppError.badRequest(
                'The item has not been confirmed as returned. Confirm the return, or approve with an explicit override and a reason.',
                PAYMENTS_ERROR_CODES.RETURN_NOT_CONFIRMED,
            );
        }

        const now = new Date();
        const changed = await this.deps.refunds.transition({
            id,
            from: refund.status,
            data: { status: 'APPROVED', approvedById: access.userId, approvedAt: now },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This refund changed while you were approving it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.ORDER_REFUND,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'RefundRequest', id },
            beforeState: { status: refund.status },
            afterState: {
                status: 'APPROVED',
                amount: refund.amount.toFixed(2),
                currency: refund.currency,
                note: dto.note ?? null,
                physicalReturnOverridden: returnOutstanding,
                overrideReason: dto.overrideReason ?? null,
            },
            correlationId: randomUUID(),
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.REFUND_APPROVED, {
            refundRequestId: id,
            orderId: refund.orderId,
            amount: refund.amount.toFixed(2),
            currency: refund.currency,
        });

        return this.getById(id, access);
    }

    async reject(
        id: string,
        dto: RejectRefundDto,
        access: PaymentAccess,
    ): Promise<RefundView> {
        requireRefund(access, 'reject refunds');
        const refund = await this.requireInScope(id, access);

        if (!canTransition(refund.status, 'REJECTED')) {
            throw AppError.conflict(
                `A refund that is ${refund.status} cannot be rejected.`,
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const changed = await this.deps.refunds.transition({
            id,
            from: refund.status,
            data: { status: 'REJECTED', rejectionReason: dto.rejectionReason },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This refund changed while you were rejecting it.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.ORDER_REFUND,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            resource: { type: 'RefundRequest', id },
            beforeState: { status: refund.status },
            afterState: { status: 'REJECTED', rejectionReason: dto.rejectionReason },
            correlationId: randomUUID(),
        });

        return this.getById(id, access);
    }

    // ── 4. Execute ──────────────────────────────────────────────────────────

    /**
     * The money goes back, and everything that followed the sale is undone.
     *
     * Deliberately sequential rather than one transaction, because the steps
     * span four modules and one external system and cannot share one. The
     * order is chosen so that a failure leaves the least-bad state:
     *
     *   1. gateway refund (or the operator's reference) — the irreversible bit
     *   2. mark the request PROCESSED — guarded, so this cannot run twice
     *   3. order → REFUNDED
     *   4. book the refund in the platform ledger
     *   5. revoke the claim + quarantine the tag
     *   6. reverse the royalty
     *
     * Steps 5 and 6 failing are logged loudly and left for an operator: the
     * money has already moved, and silently retrying a claim revocation
     * against a unit somebody has since transferred would do more damage than
     * an alert.
     */
    async process(
        id: string,
        dto: ProcessRefundDto,
        access: PaymentAccess,
        options: { issuedVia?: 'OPERATOR' | 'PROVIDER_DASHBOARD' } = {},
    ): Promise<RefundView> {
        requireRefund(access, 'execute refunds');
        const refund = await this.requireInScope(id, access);
        const correlationId = randomUUID();

        if (refund.status !== 'APPROVED') {
            throw AppError.conflict(
                `A refund that is ${refund.status} cannot be executed — approve it first.`,
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const order = await this.deps.orders.findOrderSummary(refund.orderId);
        if (!order) {
            throw AppError.notFound('Order not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }

        // 1. Move the money.
        let gatewayRefundId = dto.gatewayRefundId ?? null;
        let issued: CreateRefundResult | null = null;
        if (!gatewayRefundId) {
            const settled = await this.deps.payments.findSettledForOrder(refund.orderId);
            if (!this.deps.gateway) {
                throw AppError.badRequest(
                    'No payment provider is wired on this deployment. Issue the refund in the provider’s dashboard and supply its reference as gatewayRefundId.',
                    PAYMENTS_ERROR_CODES.GATEWAY_UNAVAILABLE,
                );
            }
            if (!settled?.gatewayRef) {
                throw AppError.badRequest(
                    'This order has no settled charge to refund.',
                    PAYMENTS_ERROR_CODES.NOT_REFUNDABLE,
                );
            }
            const config = await this.deps.gatewayConfigs.resolve({
                gateway: settled.gateway,
                organizationId: order.organizationId,
            });
            if (!config) {
                throw AppError.badRequest(
                    'No active payment configuration exists for this order.',
                    PAYMENTS_ERROR_CODES.NO_GATEWAY,
                );
            }
            // A provider failure throws before anything here is written, so
            // the refund stays APPROVED and the button can simply be pressed
            // again.
            const result = await this.deps.gateway
                .createRefund({
                    paymentGatewayRef: settled.gatewayRef,
                    amount: refund.amount.toFixed(2),
                    currency: refund.currency,
                    // Keyed on the refund request, so a retried execute cannot
                    // send the money twice.
                    idempotencyKey: `refund:${refund.id}`,
                    credentialsRef: config.credentialsRef,
                    reason: refund.reason,
                    reasonCode: refund.reasonCode,
                    metadata: { refundRequestId: refund.id, orderId: refund.orderId },
                })
                .catch((error: unknown) => gatewayFailure(error, 'issue this refund'));
            gatewayRefundId = result.gatewayRefundId;
            issued = result;
            this.deps.logger.info(
                { refundRequestId: id, gatewayRefundId, settled: result.settled },
                'refund issued through the payment provider',
            );
        }

        // 2. Lock the request. Guarded: two operators pressing execute produce
        //    one PROCESSED and one conflict.
        const processedAt = dto.processedAt ?? new Date();
        const nfcCondition = refund.nfcTagCondition;
        const blockedUntil = resaleBlockUntil(nfcCondition, processedAt);

        const changed = await this.deps.refunds.transition({
            id,
            from: 'APPROVED',
            data: {
                status: 'PROCESSED',
                gatewayRefundId,
                processedAt,
                resaleBlockedUntil: blockedUntil,
            },
        });
        if (changed === 0) {
            throw AppError.conflict(
                'This refund was already executed.',
                PAYMENTS_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        // The provider's first word on the money. Only over nothing: the
        // `refund.created` webhook can beat this line, and it knows better.
        if (issued) {
            await this.deps.refunds.setGatewayStatus({
                id,
                status: issued.settled ? 'SUCCEEDED' : 'PENDING',
                failureReason: null,
                at: processedAt,
                onlyIfUnset: true,
            });
        }

        // 3. The order.
        await this.deps.orders.markRefunded({ orderId: refund.orderId, refundedAt: processedAt });

        // 4. The platform's books.
        await this.deps.finance.postRefund({
            orderId: refund.orderId,
            refundRequestId: refund.id,
            amount: refund.amount.toFixed(2),
            currency: refund.currency,
            description: `Refund: ${refund.reason}`,
        });

        // 5. Ownership and the tag.
        let claimRevokedAt: Date | null = null;
        if (order.skuId) {
            try {
                const revocation = await this.deps.claims.revokeClaim({
                    skuId: order.skuId,
                    claimId: order.claimId,
                    reason: `Refund ${refund.id}: ${refund.reason}`,
                    actorId: access.userId,
                    resaleBlockedUntil: blockedUntil,
                });
                if (revocation.revoked) {
                    claimRevokedAt = processedAt;
                    await this.deps.refunds.transition({
                        id,
                        from: 'PROCESSED',
                        data: { claimRevokedAt: processedAt },
                    });
                }
            } catch (error) {
                this.deps.logger.error(
                    { err: error, refundRequestId: id, skuId: order.skuId },
                    'refund executed but the claim could not be revoked — manual intervention required',
                );
            }
        }

        // 6. The artist's royalty.
        try {
            await this.deps.royalties.reverseForOrder({
                orderId: refund.orderId,
                reason: `Refund ${refund.id}: ${refund.reason}`,
                reasonCode: 'REFUND_REVERSAL',
                actorId: access.userId,
                refundRequestId: refund.id,
                correlationId,
            });
        } catch (error) {
            this.deps.logger.error(
                { err: error, refundRequestId: id, orderId: refund.orderId },
                'refund executed but the royalty could not be reversed — manual intervention required',
            );
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.REFUND_PROCESS,
            actor: { type: 'HITBOX_EMPLOYEE', id: access.userId },
            result: 'SUCCESS',
            organizationId: order.organizationId,
            resource: { type: 'RefundRequest', id },
            beforeState: { status: 'APPROVED' },
            afterState: {
                status: 'PROCESSED',
                gatewayRefundId,
                amount: refund.amount.toFixed(2),
                currency: refund.currency,
                nfcTagCondition: nfcCondition,
                resaleBlockedUntil: blockedUntil?.toISOString() ?? null,
                claimRevokedAt: claimRevokedAt?.toISOString() ?? null,
                issuedVia: issued ? 'GATEWAY_ADAPTER' : (options.issuedVia ?? 'OPERATOR'),
            },
            correlationId,
        });

        await this.deps.eventBus.publish(PAYMENT_EVENTS.REFUND_PROCESSED, {
            refundRequestId: id,
            orderId: refund.orderId,
            amount: refund.amount.toFixed(2),
            currency: refund.currency,
            claimRevoked: claimRevokedAt !== null,
        });

        return this.getById(id, access);
    }

    // ── 5. What the provider says afterwards ────────────────────────────────

    /**
     * A `refund.*` webhook: the provider's view of a refund's money.
     *
     * Three cases:
     *
     *   **A refund this platform knows** (by the `refundRequestId` the adapter
     *   put in metadata, or by `gatewayRefundId`) — record the provider status.
     *   FAILED / CANCELED after PROCESSED is the dangerous one: the order says
     *   REFUNDED and the buyer has no money. Nothing is rolled back
     *   automatically — the claim was revoked and the royalty reversed on
     *   purpose, and undoing those by webhook is worse than a person deciding —
     *   so it is flagged (`gatewayStatus` FAILED), audited, logged at error and
     *   published as `payments.refund.failed` for an operator.
     *
     *   **A refund issued in the provider's dashboard** for an order whose
     *   refund is APPROVED and not yet paid, for the same amount — that is an
     *   operator who paid it out there instead of pressing Process. It is
     *   processed now, exactly as Process would, as the approver.
     *
     *   **Anything else** (no approved refund, different amount) — money left
     *   outside the workflow. Audited and published as
     *   `payments.refund.unmatched` once, on `refund.created`; never acted on.
     */
    async applyGatewayRefundUpdate(update: GatewayRefundUpdate): Promise<void> {
        let refund = update.refundRequestId
            ? await this.deps.refunds.findById(update.refundRequestId)
            : null;
        // Metadata is only a hint: it must agree with a recorded provider id.
        if (refund?.gatewayRefundId && refund.gatewayRefundId !== update.gatewayRefundId) refund = null;
        refund ??= await this.deps.refunds.findByGatewayRefundId(update.gatewayRefundId);

        if (!refund) {
            await this.matchProviderIssuedRefund(update);
            return;
        }

        const changed = await this.deps.refunds.setGatewayStatus({
            id: refund.id,
            status: update.status,
            failureReason: update.failureReason,
            at: update.occurredAt,
        });
        if (changed === 0) return; // already knew — a retried or out-of-order delivery

        if (update.status === 'FAILED' || update.status === 'CANCELED') {
            await this.flagFailedRefund(refund, update);
        } else {
            this.deps.logger.info(
                { refundRequestId: refund.id, gatewayRefundId: update.gatewayRefundId, gatewayStatus: update.status },
                'provider refund status updated',
            );
        }
    }

    private async flagFailedRefund(refund: RefundRequest, update: GatewayRefundUpdate): Promise<void> {
        this.deps.logger.error(
            {
                refundRequestId: refund.id,
                orderId: refund.orderId,
                gatewayRefundId: update.gatewayRefundId,
                gatewayStatus: update.status,
                failureReason: update.failureReason,
                workflowStatus: refund.status,
            },
            'provider refund FAILED — the buyer was not paid back; manual action required',
        );
        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.REFUND_PROCESS,
            actor: { type: 'SYSTEM', id: null },
            result: 'FAILURE',
            resource: { type: 'RefundRequest', id: refund.id },
            beforeState: { gatewayStatus: refund.gatewayStatus },
            afterState: {
                gatewayStatus: update.status,
                gatewayRefundId: update.gatewayRefundId,
                failureReason: update.failureReason,
                workflowStatus: refund.status,
            },
            correlationId: update.correlationId,
        });
        await this.deps.eventBus.publish(PAYMENT_EVENTS.REFUND_FAILED, {
            refundRequestId: refund.id,
            orderId: refund.orderId,
            amount: refund.amount.toFixed(2),
            currency: refund.currency,
            gatewayRefundId: update.gatewayRefundId,
            gatewayStatus: update.status,
            failureReason: update.failureReason,
        });
    }

    private async matchProviderIssuedRefund(update: GatewayRefundUpdate): Promise<void> {
        if (update.status === 'FAILED' || update.status === 'CANCELED') {
            this.deps.logger.warn(
                { gatewayRefundId: update.gatewayRefundId, gatewayStatus: update.status },
                'provider reported a failed refund this platform has no record of',
            );
            return;
        }

        let payment = null;
        for (const ref of update.paymentRefs) {
            payment = await this.deps.payments.findByGatewayRef(ref);
            if (payment) break;
        }
        if (!payment) {
            this.deps.logger.info(
                { gatewayRefundId: update.gatewayRefundId, paymentRefs: update.paymentRefs },
                'refund webhook for a charge this platform does not know',
            );
            return;
        }

        const candidate = await this.deps.refunds.findApprovedUnissuedForOrder(payment.orderId);
        const amountMatches =
            candidate !== null &&
            (update.amountMinor === null ||
                update.amountMinor === toMinorUnits(candidate.amount.toFixed(2), candidate.currency));

        if (candidate?.approvedById && amountMatches) {
            const access: PaymentAccess = {
                userId: candidate.approvedById,
                scope: PaymentScope.GLOBAL,
                organizationIds: null,
                canManage: false,
                canConfigure: false,
                canRefund: true,
            };
            try {
                await this.process(
                    candidate.id,
                    { gatewayRefundId: update.gatewayRefundId, processedAt: update.occurredAt },
                    access,
                    { issuedVia: 'PROVIDER_DASHBOARD' },
                );
            } catch (error) {
                // An operator pressed Process with the same id at the same
                // moment; theirs won, and the status below still applies.
                if (!(error instanceof AppError && error.statusCode === 409)) throw error;
            }
            await this.deps.refunds.setGatewayStatus({
                id: candidate.id,
                status: update.status,
                failureReason: null,
                at: update.occurredAt,
            });
            this.deps.logger.info(
                { refundRequestId: candidate.id, gatewayRefundId: update.gatewayRefundId },
                'refund issued in the provider dashboard — processed against the approved request',
            );
            return;
        }

        if (update.eventType !== 'refund.created') return; // alert once, not on every update
        const reason = candidate ? 'AMOUNT_MISMATCH' : 'NO_APPROVED_REFUND';
        this.deps.logger.warn(
            {
                orderId: payment.orderId,
                gatewayRefundId: update.gatewayRefundId,
                amountMinor: update.amountMinor,
                approvedRefundId: candidate?.id ?? null,
                reason,
            },
            'refund issued at the provider with no matching approved refund — review',
        );
        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.ORDER_REFUND,
            actor: { type: 'SYSTEM', id: null },
            result: 'FAILURE',
            resource: { type: 'Order', id: payment.orderId },
            afterState: {
                gatewayRefundId: update.gatewayRefundId,
                amountMinor: update.amountMinor,
                reason,
                approvedRefundId: candidate?.id ?? null,
            },
            correlationId: update.correlationId,
        });
        await this.deps.eventBus.publish(PAYMENT_EVENTS.REFUND_UNMATCHED, {
            orderId: payment.orderId,
            gatewayRefundId: update.gatewayRefundId,
            amountMinor: update.amountMinor,
            reason,
        });
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    async list(
        query: ListRefundsQuery,
        access: PaymentAccess,
    ): Promise<{ page: number; limit: number; total: number; items: RefundView[] }> {
        const { total, items } = await this.deps.refunds.list({
            ...query,
            scopeFilter: this.scopeFilter(access),
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => this.toView(row, access)),
        };
    }

    async getById(id: string, access: PaymentAccess): Promise<RefundView> {
        return this.toView(await this.requireInScope(id, access), access);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private scopeFilter(access: PaymentAccess): Prisma.RefundRequestWhereInput {
        if (access.scope === PaymentScope.GLOBAL) return {};
        if (access.scope === PaymentScope.ORGANIZATION) {
            return { order: { organizationId: { in: access.organizationIds ?? [] } } };
        }
        // A buyer sees their own refunds — the requests they raised, on their
        // own orders. Not the workflow, which is operator-only by capability.
        return { order: { buyerId: access.userId } };
    }

    private async requireInScope(id: string, access: PaymentAccess): Promise<RefundRequest> {
        const { items } = await this.deps.refunds.list({
            page: 1,
            limit: 1,
            scopeFilter: { AND: [this.scopeFilter(access), { id }] },
            skip: 0,
            take: 1,
        });
        const refund = items[0];
        if (!refund) {
            throw AppError.notFound('Refund not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }
        return refund;
    }

    private toView(row: RefundRequest, access: PaymentAccess): RefundView {
        return {
            id: row.id,
            orderId: row.orderId,
            requestedById: row.requestedById,
            reason: row.reason,
            reasonCode: row.reasonCode,
            status: row.status,
            amount: row.amount.toFixed(2),
            currency: row.currency,
            physicalReturnRequired: row.physicalReturnRequired,
            physicalReturnConfirmedAt: row.physicalReturnConfirmedAt?.toISOString() ?? null,
            nfcTagCondition: row.nfcTagCondition,
            approvedById: row.approvedById,
            approvedAt: row.approvedAt?.toISOString() ?? null,
            rejectionReason: row.rejectionReason,
            gatewayRefundId: row.gatewayRefundId,
            gatewayStatus: row.gatewayStatus,
            gatewayFailureReason: row.gatewayFailureReason,
            gatewayStatusAt: row.gatewayStatusAt?.toISOString() ?? null,
            processedAt: row.processedAt?.toISOString() ?? null,
            claimRevokedAt: row.claimRevokedAt?.toISOString() ?? null,
            resaleBlockedUntil: row.resaleBlockedUntil?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            allowedTransitions: REFUND_TRANSITIONS[row.status],
            allowedActions: refundActions(row, access.canRefund),
        };
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_ERROR_CODES,
    PAYMENT_EVENTS,
} from '../constants/payments.constant';
import type { IPaymentGateway } from '../domain/interfaces/payment-gateway.interface';
import type { IOrderLedger } from '../domain/interfaces/order-ledger.interface';
import type { GatewayConfigRepository } from '../repository/gateway-config.repository';
import type { PaymentRepository } from '../repository/payment.repository';
import type { CheckoutDto, CheckoutView } from '../dto/payments.dto';

export interface CheckoutServiceDeps {
    orders: IOrderLedger;
    payments: PaymentRepository;
    gatewayConfigs: GatewayConfigRepository;
    /** Optional: without one, the charge is completed by the provider's flow. */
    gateway?: IPaymentGateway | undefined;
    eventBus: IEventBus;
    logger: Logger;
    holdSeconds: number;
}

/**
 * Checkout: the moment an order, a stock hold and a charge attempt come into
 * existence together.
 *
 * It lives in payments rather than orders because the dependency has to run
 * one way and money is the thing that starts the sequence — orders implements
 * `IOrderLedger` and knows nothing about gateways. See
 * docs/finance/module-boundaries.md.
 *
 * What this method deliberately does **not** do is decide that the buyer has
 * paid. It records intent: an order awaiting payment, a unit held for a
 * quarter of an hour, a PENDING transaction with an idempotency key. The only
 * thing that turns any of that into a sale is a verified webhook.
 */
export class CheckoutService {
    constructor(private readonly deps: CheckoutServiceDeps) { }

    async checkout(dto: CheckoutDto, buyerId: string): Promise<CheckoutView> {
        // 1. Order + stock hold, in one transaction inside the orders module.
        //    It throws OUT_OF_STOCK / NOT_PURCHASABLE / NO_PRICE itself — those
        //    are the buyer's answers, and orders is what knows them.
        const placed = await this.deps.orders.placeOrder({
            buyerId,
            productId: dto.productId,
            variantId: dto.variantId ?? null,
            marketId: dto.marketId ?? null,
            quantity: dto.quantity,
            holdSeconds: this.deps.holdSeconds,
            termsAccepted: dto.termsAccepted,
            shippingAddressId: dto.shippingAddressId ?? null,
            billingAddressId: dto.billingAddressId ?? null,
        });

        // 2. Which gateway credentials apply to this sale.
        const config = await this.deps.gatewayConfigs.resolve({
            gateway: dto.gateway,
            organizationId: placed.organizationId,
        });
        if (!config) {
            throw AppError.badRequest(
                'No active payment configuration exists for this drop.',
                PAYMENTS_ERROR_CODES.NO_GATEWAY,
                { gateway: dto.gateway },
            );
        }

        // 3. The charge attempt. The idempotency key is derived from the order,
        //    not random: a client retrying the same checkout must land on the
        //    same transaction, and only the order identifies "the same
        //    checkout" across a retry that lost its response.
        const idempotencyKey = `order:${placed.orderId}:attempt:1`;
        const transactionId = randomUUID();
        const now = new Date();

        const { transaction, created } = await this.deps.payments.createOrGet({
            id: transactionId,
            orderId: placed.orderId,
            gateway: dto.gateway,
            status: 'INITIATED',
            idempotencyKey,
            amount: new Prisma.Decimal(placed.amount),
            currency: placed.currency as never,
            needsReview: false,
            createdAt: now,
            updatedAt: now,
        });

        if (!created) {
            this.deps.logger.info(
                { orderId: placed.orderId, transactionId: transaction.id },
                'checkout retried — returning the existing charge attempt',
            );
        }

        // 4. Ask the provider to create the charge, if an adapter is wired.
        //    Without one the client completes payment through the provider's
        //    own hosted flow and the webhook is what settles the order.
        let gatewayRef: string | null = transaction.gatewayRef;
        let clientToken: string | null = null;

        if (created && this.deps.gateway) {
            const charge = await this.deps.gateway.createCharge({
                orderId: placed.orderId,
                paymentTransactionId: transaction.id,
                amount: placed.amount,
                currency: placed.currency,
                idempotencyKey,
                buyerId,
                credentialsRef: config.credentialsRef,
                metadata: { orderId: placed.orderId, skuId: placed.skuId },
            });
            gatewayRef = charge.gatewayRef;
            clientToken = charge.clientToken;

            await this.deps.payments.transition({
                id: transaction.id,
                from: 'INITIATED',
                data: { status: 'PENDING', gatewayRef: charge.gatewayRef },
            });
        }

        await this.deps.eventBus.publish(PAYMENT_EVENTS.CHECKOUT_STARTED, {
            orderId: placed.orderId,
            paymentTransactionId: transaction.id,
            buyerId,
            skuId: placed.skuId,
            amount: placed.amount,
            currency: placed.currency,
        });

        this.deps.logger.info(
            {
                orderId: placed.orderId,
                skuId: placed.skuId,
                transactionId: transaction.id,
                amount: placed.amount,
                currency: placed.currency,
            },
            'checkout started',
        );

        return {
            orderId: placed.orderId,
            paymentTransactionId: transaction.id,
            skuId: placed.skuId,
            reservationId: placed.reservationId,
            reservationExpiresAt: placed.expiresAt,
            amount: placed.amount,
            currency: placed.currency,
            gateway: dto.gateway,
            status: this.deps.gateway && created ? 'PENDING' : transaction.status,
            clientToken,
            gatewayRef,
        };
    }
}

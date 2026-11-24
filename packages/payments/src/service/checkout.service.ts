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
import { gatewayFailure } from '../domain/gateway-error';
import type { IOrderLedger } from '../domain/interfaces/order-ledger.interface';
import type { IAddressBook, ITaxEstimator } from '../domain/interfaces/checkout-support.interface';
import type { GatewayConfigRepository } from '../repository/gateway-config.repository';
import type { PaymentRepository } from '../repository/payment.repository';
import type {
    CheckoutDto,
    CheckoutQuoteDto,
    CheckoutQuoteView,
    CheckoutView,
} from '../dto/payments.dto';

export interface CheckoutServiceDeps {
    orders: IOrderLedger;
    payments: PaymentRepository;
    gatewayConfigs: GatewayConfigRepository;
    /** Optional: without one, the charge is completed by the provider's flow. */
    gateway?: IPaymentGateway | undefined;
    eventBus: IEventBus;
    logger: Logger;
    holdSeconds: number;
    /**
     * The buyer's address book (users). Without it, address ids go to the order
     * as given and are only checked for ownership there; production wires it.
     */
    addresses?: IAddressBook | undefined;
    /**
     * Tax arithmetic (tax). Without it the quote shows no tax and checkout never
     * asks for a billing address; production wires it.
     */
    tax?: ITaxEstimator | undefined;
}

/** Hitbox charges no shipping today; the quote says so explicitly. */
const NO_SHIPPING = '0.00';

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
        // 0. A retry of a checkout whose response was lost (timeout, app
        //    killed, double tap) must not place a second order and hold a
        //    second unit. If this buyer already has an unpaid order for this
        //    drop with a live hold, hand that one back — same order, same
        //    charge. Once the hold lapses, a new checkout starts fresh.
        const openOrderId = await this.deps.orders.findOpenCheckout({
            buyerId,
            productId: dto.productId,
            variantId: dto.variantId ?? null,
        });
        if (openOrderId) {
            this.deps.logger.info(
                { orderId: openOrderId, buyerId },
                'checkout repeated while an order is open — resuming it',
            );
            return this.resume(openOrderId, buyerId);
        }

        // 0b. Addresses. The same check the quote runs: an id that is not the
        //     buyer's is ignored, an archived one is refused. A taxed sale with
        //     no billing address is refused here, *before* any stock is held,
        //     because the billing country is what picks the tax on the invoice
        //     and the currency fallback is only a guess.
        const addresses = await this.resolveAddresses(dto, buyerId);
        await this.requireBillingWhenTaxed(dto, addresses.billingId !== null);

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
            shippingAddressId: addresses.shippingId,
            billingAddressId: addresses.billingId,
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
        //
        //    Also on a retry while the charge is still open: the idempotency
        //    key makes the provider hand back the same intent, so a client that
        //    lost the first response still gets its client token, and a first
        //    attempt that failed at the provider is simply made again.
        let gatewayRef: string | null = transaction.gatewayRef;
        let clientToken: string | null = null;
        let status = transaction.status;

        if (this.deps.gateway && (status === 'INITIATED' || status === 'PENDING')) {
            const charge = await this.deps.gateway
                .createCharge({
                    orderId: placed.orderId,
                    paymentTransactionId: transaction.id,
                    amount: placed.amount,
                    currency: placed.currency,
                    idempotencyKey,
                    buyerId,
                    credentialsRef: config.credentialsRef,
                    metadata: { orderId: placed.orderId, skuId: placed.skuId },
                })
                .catch((error: unknown) => gatewayFailure(error, 'start this payment'));
            gatewayRef = charge.gatewayRef;
            clientToken = charge.clientToken;

            if (status === 'INITIATED') {
                await this.deps.payments.transition({
                    id: transaction.id,
                    from: 'INITIATED',
                    data: { status: 'PENDING', gatewayRef: charge.gatewayRef },
                });
                status = 'PENDING';
            }
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
            status,
            clientToken,
            gatewayRef,
        };
    }

    /**
     * What the buyer will be charged, before they pay. No side effects: no
     * order, no stock hold, no Stripe call.
     *
     * Prices are tax-inclusive, so `totalAmount` is the sticker price (plus
     * shipping, which is zero) and the tax is the part of it that is tax. The
     * split comes from the tax module's own invoice arithmetic, and checkout
     * charges `order.amount`, which is the same `unitPrice`: so the quote, the
     * charge and the invoice total are the same number by construction.
     */
    async quote(dto: CheckoutQuoteDto, buyerId: string): Promise<CheckoutQuoteView> {
        const addresses = await this.resolveAddresses(dto, buyerId);
        const sale = await this.deps.orders.quoteSale({
            productId: dto.productId,
            variantId: dto.variantId ?? null,
            marketId: dto.marketId ?? null,
            buyerId,
            shippingAddressId: addresses.shippingId,
            billingAddressId: addresses.billingId,
        });

        const estimate = this.deps.tax
            ? await this.deps.tax.estimate({
                productId: sale.productId,
                countryCode: addresses.billing?.countryCode ?? null,
                stateCode: addresses.billing?.state ?? null,
                currency: sale.currency,
                unitPrice: sale.unitPrice,
            })
            : null;

        const billingAddressRequired =
            addresses.billing === null && (await this.isTaxedWithoutAddress(sale));

        return {
            productId: sale.productId,
            variantId: sale.variantId,
            marketId: sale.marketId,
            currency: sale.currency,
            unitPrice: sale.unitPrice,
            subtotal: estimate?.subtotal ?? sale.unitPrice,
            taxType: estimate?.taxType ?? null,
            taxRate: estimate?.taxRate ?? '0.000',
            taxAmount: estimate?.taxAmount ?? '0.00',
            shippingAmount: NO_SHIPPING,
            totalAmount: new Prisma.Decimal(sale.unitPrice).plus(NO_SHIPPING).toFixed(2),
            availability: sale.availability,
            unavailableReason: sale.unavailableReason,
            billingAddressRequired,
        };
    }

    /** Runs the ownership check once and keeps only the ids that survive it. */
    private async resolveAddresses(
        dto: { shippingAddressId?: string | undefined; billingAddressId?: string | undefined },
        buyerId: string,
    ): Promise<{
        shippingId: string | null;
        billingId: string | null;
        billing: { id: string; countryCode: string; state: string | null } | null;
    }> {
        if (!this.deps.addresses) {
            return {
                shippingId: dto.shippingAddressId ?? null,
                billingId: dto.billingAddressId ?? null,
                billing: null,
            };
        }
        const { shipping, billing } = await this.deps.addresses.resolveForCheckout(buyerId, {
            shippingAddressId: dto.shippingAddressId ?? null,
            billingAddressId: dto.billingAddressId ?? null,
        });
        return { shippingId: shipping?.id ?? null, billingId: billing?.id ?? null, billing };
    }

    /**
     * Refuses a checkout that would be taxed but names no billing country.
     * Only fires on a drop that is actually buyable: sold-out and closed drops
     * fall through so the buyer gets the real reason from `placeOrder`.
     */
    private async requireBillingWhenTaxed(
        dto: CheckoutDto,
        hasBilling: boolean,
    ): Promise<void> {
        if (hasBilling || !this.deps.tax) return;
        const sale = await this.deps.orders.quoteSale({
            productId: dto.productId,
            variantId: dto.variantId ?? null,
            marketId: dto.marketId ?? null,
        });
        if (sale.availability !== 'IN_STOCK') return;
        if (!(await this.isTaxedWithoutAddress(sale))) return;

        throw AppError.badRequest(
            'Add a billing address: the tax on this purchase depends on where you are billed.',
            PAYMENTS_ERROR_CODES.BILLING_ADDRESS_REQUIRED,
            { currency: sale.currency },
        );
    }

    /** Would this sale be taxed in the currency's fallback country? Free drops never are. */
    private async isTaxedWithoutAddress(sale: {
        productId: string;
        currency: string;
        unitPrice: string;
    }): Promise<boolean> {
        if (!this.deps.tax || !new Prisma.Decimal(sale.unitPrice).gt(0)) return false;
        return this.deps.tax.taxedByDefault({ productId: sale.productId, currency: sale.currency });
    }

    /**
     * Back to the payment screen for an order the buyer already placed — they
     * closed the tab, the app was killed, the card was declined and they want
     * to try another. Same order, same held unit, same charge: the original
     * idempotency key makes the provider hand back the *same* intent, so this
     * can never create a second charge. docs/orders/buyer-orders-api.md.
     *
     * Only while the order is unpaid and its hold is live; after that the
     * piece may have gone to someone else and the buyer starts a new checkout.
     */
    async resume(orderId: string, buyerId: string): Promise<CheckoutView> {
        const order = await this.deps.orders.findOrderSummary(orderId);
        if (!order || order.buyerId !== buyerId) {
            throw AppError.notFound('Order not found.', PAYMENTS_ERROR_CODES.NOT_FOUND);
        }
        if (order.status !== 'PENDING_PAYMENT') {
            throw AppError.conflict(
                order.status === 'CANCELLED'
                    ? 'This order was cancelled. Start a new checkout.'
                    : 'This order has already been paid.',
                PAYMENTS_ERROR_CODES.ORDER_NOT_PAYABLE,
                { status: order.status },
            );
        }
        const hold = await this.deps.orders.findLiveHold(orderId);
        if (!hold) {
            throw AppError.conflict(
                'The time to pay for this order has run out and the piece has been released. Start a new checkout.',
                PAYMENTS_ERROR_CODES.RESERVATION_EXPIRED,
            );
        }

        const transaction = (await this.deps.payments.findByOrder(orderId))
            .find((t) => t.status === 'INITIATED' || t.status === 'PENDING');
        if (!transaction) {
            throw AppError.conflict(
                'This order has no open payment attempt. Start a new checkout.',
                PAYMENTS_ERROR_CODES.ORDER_NOT_PAYABLE,
            );
        }

        let clientToken: string | null = null;
        let gatewayRef = transaction.gatewayRef;
        let status = transaction.status;
        if (this.deps.gateway) {
            const config = await this.deps.gatewayConfigs.resolve({
                gateway: transaction.gateway,
                organizationId: order.organizationId,
            });
            if (!config) {
                throw AppError.badRequest(
                    'No active payment configuration exists for this drop.',
                    PAYMENTS_ERROR_CODES.NO_GATEWAY,
                    { gateway: transaction.gateway },
                );
            }
            const charge = await this.deps.gateway
                .createCharge({
                    orderId,
                    paymentTransactionId: transaction.id,
                    amount: order.amount,
                    currency: order.currency,
                    idempotencyKey: transaction.idempotencyKey,
                    buyerId,
                    credentialsRef: config.credentialsRef,
                    metadata: { orderId, skuId: hold.skuId },
                })
                .catch((error: unknown) => gatewayFailure(error, 'resume this payment'));
            clientToken = charge.clientToken;
            gatewayRef = charge.gatewayRef;
            if (status === 'INITIATED') {
                await this.deps.payments.transition({
                    id: transaction.id,
                    from: 'INITIATED',
                    data: { status: 'PENDING', gatewayRef: charge.gatewayRef },
                });
                status = 'PENDING';
            }
        }

        this.deps.logger.info({ orderId, transactionId: transaction.id }, 'checkout resumed');
        return {
            orderId,
            paymentTransactionId: transaction.id,
            skuId: hold.skuId,
            reservationId: hold.reservationId,
            reservationExpiresAt: hold.expiresAt.toISOString(),
            amount: order.amount,
            currency: order.currency,
            gateway: transaction.gateway,
            status,
            clientToken,
            gatewayRef,
        };
    }
}

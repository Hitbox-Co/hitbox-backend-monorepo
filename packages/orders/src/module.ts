import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    ORDER_CREATE_CAPABILITY,
    ORDER_EVENTS,
    ORDER_READ_CAPABILITY,
    ORDER_WRITE_CAPABILITY,
    ORDERS_MODULE,
} from './constants/orders.constant';
import { OrderShipmentController } from './controller/order-shipment.controller';
import type { OrderBuyerResolver } from './controller/order-shipment.controller';
import type { IOrdersAuditRecorder } from './domain/interfaces/audit-recorder.port';
import { OrderShipmentRepository } from './repository/order-shipment.repository';
import { OrderShipmentService } from './service/order-shipment.service';
import { BuyerOrderController } from './controller/buyer-order.controller';
import { BuyerOrderRepository } from './repository/buyer-order.repository';
import { BuyerOrderService } from './service/buyer-order.service';
import type { IMediaUrlResolver } from './domain/interfaces/media-url-resolver.interface';
import { OrderFulfilmentController } from './controller/order-fulfilment.controller';
import { OrderFulfilmentRepository } from './repository/order-fulfilment.repository';
import { OrderFulfilmentService } from './service/order-fulfilment.service';
import { OrderController } from './controller/order.controller';
import type { OrderCallerResolver } from './controller/order.controller';
import {
    OrderLedgerAdapter,
    OrderInvoicingAdapter,
    OrderRevenueAdapter,
} from './domain/order-ledger.adapter';
import { OrderRepository } from './repository/order.repository';
import { OrderWriteRepository } from './repository/order-write.repository';
import { OrderService } from './service/order.service';
import { CheckoutSweepService } from './service/checkout-sweep.service';
import type { CheckoutSweepResult } from './service/checkout-sweep.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface OrdersPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface OrdersModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: OrdersPermissionGuard;
    resolveCaller: OrderCallerResolver;
    /**
     * How long an unpaid order is kept after its stock hold expires, so a
     * late card payment can still settle. Default 1800 (30 min).
     */
    unpaidOrderGraceSeconds?: number;
    /** Admin status changes and tracking edits are audited through this. */
    audit: IOrdersAuditRecorder;
    /** The signed-in buyer, for the `/orders` buyer routes. */
    resolveBuyer: OrderBuyerResolver;
    /** Product images on the buyer's order screens. Optional: without it, `imageUrl` is null. */
    mediaUrls?: IMediaUrlResolver | undefined;
}

/** The claim event orders links back to the order. Matches @hitbox/claims. */
interface ClaimedEventPayload {
    claimId: string;
    skuId: string;
    productId: string;
    userId: string;
}

export interface OrdersModule {
    /** Mounted at `/admin/orders`. */
    createRouter(requireAuth: RequestHandler): Router;
    /** Mounted at `/orders`: the buyer's own orders (docs/orders/buyer-orders-api.md). */
    createBuyerRouter(requireAuth: RequestHandler): Router;
    /**
     * Payments' `IOrderLedger`: place an order, settle it, cancel it, refund
     * it, sweep expired stock holds. Checkout lives in payments because the
     * dependency has to run one way and money is what starts the sequence —
     * see docs/finance/module-boundaries.md.
     */
    ledger: OrderLedgerAdapter;
    /**
     * Finance's `IOrderRevenueSource`: what this unit sold for and what it
     * cost, which is everything a royalty accrual needs from an order.
     */
    revenue: OrderRevenueAdapter;
    /**
     * Tax's `IInvoiceableOrderSource`: who bought what, at what price, billed
     * where — everything the customer invoice prints.
     */
    invoicing: OrderInvoicingAdapter;
    /**
     * The scheduled checkout clean-up: release expired stock holds, then
     * cancel orders left unpaid past the grace period. Run by the server's
     * timer and by `pnpm jobs:checkout-sweep` (docs/orders/checkout-sweep.md).
     */
    runCheckoutSweep(now?: Date): Promise<CheckoutSweepResult>;
}

export function createOrdersModule(deps: OrdersModuleDeps): OrdersModule {
    const logger = createModuleLogger(ORDERS_MODULE);
    const orders = new OrderRepository(deps.prisma);
    const writes = new OrderWriteRepository(deps.prisma);
    const service = new OrderService({ orders, writes, audit: deps.audit, eventBus: deps.eventBus, logger });
    const shipping = new OrderShipmentController(
        new OrderShipmentService({
            shipments: new OrderShipmentRepository(deps.prisma),
            audit: deps.audit,
            eventBus: deps.eventBus,
            logger,
        }),
        service,
        deps.resolveCaller,
        deps.resolveBuyer,
    );
    const buyerOrders = new BuyerOrderController(
        new BuyerOrderService({
            orders: new BuyerOrderRepository(deps.prisma),
            writes,
            mediaUrls: deps.mediaUrls,
            eventBus: deps.eventBus,
            logger,
        }),
        deps.resolveBuyer,
    );
    const checkoutSweep = new CheckoutSweepService({
        writes,
        eventBus: deps.eventBus,
        logger,
        graceSeconds: deps.unpaidOrderGraceSeconds ?? 1800,
    });
    const controller = new OrderController(service, deps.resolveCaller);
    const fulfilment = new OrderFulfilmentController(
        new OrderFulfilmentService({
            fulfilment: new OrderFulfilmentRepository(deps.prisma),
            eventBus: deps.eventBus,
            logger,
        }),
        deps.resolveCaller,
    );

    /**
     * Payment and ownership are decoupled, so the order needs telling when its
     * unit is finally claimed. Orders writes its own table here rather than
     * letting claims or finance reach into it — and the write is guarded on
     * `claimId: null`, so a redelivered event cannot overwrite the first claim.
     *
     * The tap is also proof of delivery: a SHIPPED order whose unit the buyer
     * just tapped becomes DELIVERED (docs/orders/order-history-and-shipments.md).
     */
    deps.eventBus.subscribe<ClaimedEventPayload>(
        'claims.product.claimed',
        async (payload) => {
            try {
                const orderId = await writes.linkClaim({
                    skuId: payload.skuId,
                    claimId: payload.claimId,
                    claimedAt: new Date(),
                });
                if (orderId) {
                    logger.info(
                        { orderId, claimId: payload.claimId, skuId: payload.skuId },
                        'order linked to the claim that took ownership of its unit',
                    );
                    const claimedAt = new Date();
                    const delivered = await writes.deliverOnClaim({
                        orderId,
                        claimId: payload.claimId,
                        claimerId: payload.userId,
                        claimedAt,
                    });
                    if (delivered) {
                        await deps.eventBus.publish(ORDER_EVENTS.STATUS_CHANGED, {
                            orderId,
                            from: 'SHIPPED',
                            to: 'DELIVERED',
                            actorId: payload.userId,
                            reason: 'Buyer tapped the NFC tag',
                        });
                        logger.info({ orderId, claimId: payload.claimId }, 'order delivered on NFC claim');
                    }
                }
            } catch (error) {
                logger.error(
                    { err: error, claimId: payload.claimId, skuId: payload.skuId },
                    'failed to link a claim to its order',
                );
            }
        },
    );

    return {
        ledger: new OrderLedgerAdapter(writes),
        revenue: new OrderRevenueAdapter(writes),
        invoicing: new OrderInvoicingAdapter(writes),
        runCheckoutSweep: (now) => checkoutSweep.run(now),

        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            router.get(
                '/',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                controller.list,
            );

            // ── Packing: scan-to-assign (docs/orders/order-unit-assignment-api.md)
            // Static paths are mounted before '/:orderId' so they are not read
            // as an order id. Same capabilities and organization scoping as
            // shipping: whoever may ship an order may pack it.
            router.get(
                '/fulfilment-queue',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                fulfilment.queue,
            );
            router.post(
                '/assign-by-scan',
                deps.guard.requirePermission(ORDER_WRITE_CAPABILITY),
                fulfilment.assignByScan,
            );
            router.get(
                '/:orderId/unit',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                fulfilment.get,
            );
            router.post(
                '/:orderId/unit',
                deps.guard.requirePermission(ORDER_WRITE_CAPABILITY),
                fulfilment.assign,
            );
            router.get(
                '/:orderId',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                controller.getById,
            );

            // ── Shipping (docs/orders/order-history-and-shipments.md)
            // Recording the shipment IS shipping: PROCESSING → SHIPPED with the
            // carrier and tracking number, in one transaction.
            router.post(
                '/:orderId/shipment',
                deps.guard.requirePermission(ORDER_WRITE_CAPABILITY),
                shipping.record,
            );
            router.put(
                '/:orderId/shipment',
                deps.guard.requirePermission(ORDER_WRITE_CAPABILITY),
                shipping.replace,
            );

            // Fulfilment is an operator action, not a platform-wide one: an
            // Order Manager scoped to an organization should be able to ship
            // that organization's orders. The service re-checks the order's
            // own organization after loading it.
            router.patch(
                '/:orderId/status',
                deps.guard.requirePermission(ORDER_WRITE_CAPABILITY),
                controller.changeStatus,
            );

            return router;
        },

        createBuyerRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            // Any scope of order:read / order:create; every service call is
            // keyed on the caller's own buyer id, so another person's order is
            // a 404 (docs/orders/buyer-orders-api.md).
            const read = deps.guard.requirePermission(ORDER_READ_CAPABILITY);
            router.get('/', read, buyerOrders.list);
            router.get('/:orderId', read, buyerOrders.get);
            router.get('/:orderId/tracking', read, shipping.buyerTracking);
            router.post(
                '/:orderId/cancel',
                deps.guard.requirePermission(ORDER_CREATE_CAPABILITY),
                buyerOrders.cancel,
            );
            return router;
        },
    };
}

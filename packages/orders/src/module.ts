import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    ORDER_READ_CAPABILITY,
    ORDER_WRITE_CAPABILITY,
    ORDERS_MODULE,
} from './constants/orders.constant';
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
}

/** The claim event orders links back to the order. Matches @hitbox/claims. */
interface ClaimedEventPayload {
    claimId: string;
    skuId: string;
    productId: string;
    userId: string;
}

export interface OrdersModule {
    createRouter(requireAuth: RequestHandler): Router;
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
}

export function createOrdersModule(deps: OrdersModuleDeps): OrdersModule {
    const logger = createModuleLogger(ORDERS_MODULE);
    const orders = new OrderRepository(deps.prisma);
    const writes = new OrderWriteRepository(deps.prisma);
    const service = new OrderService({ orders, eventBus: deps.eventBus, logger });
    const controller = new OrderController(service, deps.resolveCaller);

    /**
     * Payment and ownership are decoupled, so the order needs telling when its
     * unit is finally claimed. Orders writes its own table here rather than
     * letting claims or finance reach into it — and the write is guarded on
     * `claimId: null`, so a redelivered event cannot overwrite the first claim.
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

        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            router.get(
                '/',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                controller.list,
            );
            router.get(
                '/:orderId',
                deps.guard.requirePermission(ORDER_READ_CAPABILITY),
                controller.getById,
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
    };
}

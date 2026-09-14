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
import { OrderRepository } from './repository/order.repository';
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

export interface OrdersModule {
    createRouter(requireAuth: RequestHandler): Router;
}

export function createOrdersModule(deps: OrdersModuleDeps): OrdersModule {
    const logger = createModuleLogger(ORDERS_MODULE);
    const orders = new OrderRepository(deps.prisma);
    const service = new OrderService({ orders, eventBus: deps.eventBus, logger });
    const controller = new OrderController(service, deps.resolveCaller);

    return {
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

import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { recordShipmentSchema, replaceShipmentSchema } from '../dto/order-shipment.dto';
import type { OrderService } from '../service/order.service';
import type { OrderShipmentService } from '../service/order-shipment.service';
import type { OrderCallerResolver } from './order.controller';

/** The signed-in buyer's user id. Supplied by bootstrap. */
export type OrderBuyerResolver = (req: Request) => string;

/** docs/orders/order-history-and-shipments.md */
export class OrderShipmentController {
    constructor(
        private readonly shipments: OrderShipmentService,
        private readonly orders: OrderService,
        private readonly resolveCaller: OrderCallerResolver,
        private readonly resolveBuyer: OrderBuyerResolver,
    ) { }

    /** POST /admin/orders/:orderId/shipment — ships the order. Returns the refreshed order detail. */
    record: RequestHandler = asyncHandler(async (req, res) => {
        const dto = recordShipmentSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        const orderId = req.params.orderId as string;
        await this.shipments.record(orderId, dto, caller);
        res.status(201).json({ data: await this.orders.getById(orderId, caller) });
    });

    /** PUT /admin/orders/:orderId/shipment — corrects the tracking (voids + replaces). */
    replace: RequestHandler = asyncHandler(async (req, res) => {
        const dto = replaceShipmentSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        const orderId = req.params.orderId as string;
        await this.shipments.replace(orderId, dto, caller);
        res.json({ data: await this.orders.getById(orderId, caller) });
    });

    /** GET /orders/:orderId/tracking — the buyer's own order. */
    buyerTracking: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.shipments.buyerTracking(req.params.orderId as string, this.resolveBuyer(req)),
        });
    });
}

import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { cancelBuyerOrderSchema, listBuyerOrdersQuerySchema } from '../dto/buyer-order.dto';
import type { BuyerOrderService } from '../service/buyer-order.service';
import type { OrderBuyerResolver } from './order-shipment.controller';

/** "My orders" — docs/orders/buyer-orders-api.md. */
export class BuyerOrderController {
    constructor(
        private readonly orders: BuyerOrderService,
        private readonly resolveBuyer: OrderBuyerResolver,
    ) { }

    /** GET /orders */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listBuyerOrdersQuerySchema.parse(req.query);
        res.json(await this.orders.list(this.resolveBuyer(req), query));
    });

    /** GET /orders/:orderId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.orders.get(this.resolveBuyer(req), req.params.orderId as string) });
    });

    /** POST /orders/:orderId/cancel */
    cancel: RequestHandler = asyncHandler(async (req, res) => {
        const dto = cancelBuyerOrderSchema.parse(req.body ?? {});
        res.json({ data: await this.orders.cancel(this.resolveBuyer(req), req.params.orderId as string, dto) });
    });
}

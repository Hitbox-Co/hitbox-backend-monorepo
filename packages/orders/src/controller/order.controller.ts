import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { changeOrderStatusSchema, listOrdersQuerySchema } from '../dto/order.dto';
import type { OrderService, OrderView } from '../service/order.service';

/**
 * Resolves the caller's identity and what they may see. Supplied by bootstrap
 * so this module never imports the authorization one.
 */
export type OrderCallerResolver = (req: Request) => Promise<{ userId: string } & OrderView>;

export class OrderController {
    constructor(
        private readonly service: OrderService,
        private readonly resolveCaller: OrderCallerResolver,
    ) { }

    /** GET /admin/orders */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listOrdersQuerySchema.parse(req.query);
        const caller = await this.resolveCaller(req);
        res.json(await this.service.list(query, caller));
    });

    /** GET /admin/orders/:orderId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        const caller = await this.resolveCaller(req);
        res.json({ data: await this.service.getById(req.params.orderId as string, caller) });
    });

    /** PATCH /admin/orders/:orderId/status */
    changeStatus: RequestHandler = asyncHandler(async (req, res) => {
        const dto = changeOrderStatusSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.json({
            data: await this.service.changeStatus({
                id: req.params.orderId as string,
                dto,
                view: caller,
                actorId: caller.userId,
            }),
        });
    });
}

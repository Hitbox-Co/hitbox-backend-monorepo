import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    assignByScanSchema,
    assignUnitSchema,
    fulfilmentQueueQuerySchema,
    unitCandidatesQuerySchema,
} from '../dto/order-fulfilment.dto';
import type { OrderCallerResolver } from './order.controller';
import type { OrderFulfilmentService } from '../service/order-fulfilment.service';

/** HTTP for scan-to-assign at packing. Parse, delegate, respond. */
export class OrderFulfilmentController {
    constructor(
        private readonly service: OrderFulfilmentService,
        private readonly resolveCaller: OrderCallerResolver,
    ) { }

    /** GET /admin/orders/fulfilment-queue */
    queue: RequestHandler = asyncHandler(async (req, res) => {
        const query = fulfilmentQueueQuerySchema.parse(req.query);
        const caller = await this.resolveCaller(req);
        res.json(await this.service.queue(query, caller));
    });

    /** GET /admin/orders/:orderId/unit */
    get: RequestHandler = asyncHandler(async (req, res) => {
        const caller = await this.resolveCaller(req);
        res.json({ data: await this.service.get(req.params.orderId as string, caller) });
    });

    /** GET /admin/orders/:orderId/unit/candidates */
    candidates: RequestHandler = asyncHandler(async (req, res) => {
        const query = unitCandidatesQuerySchema.parse(req.query);
        const caller = await this.resolveCaller(req);
        res.json(await this.service.candidates(req.params.orderId as string, query, caller));
    });

    /** POST /admin/orders/:orderId/unit */
    assign: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignUnitSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.json({ data: await this.service.assign(req.params.orderId as string, dto, caller) });
    });

    /** POST /admin/orders/assign-by-scan */
    assignByScan: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignByScanSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.json({ data: await this.service.assignByScan(dto, caller) });
    });
}

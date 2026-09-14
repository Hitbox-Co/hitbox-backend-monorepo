import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    createMarketSchema,
    listMarketsQuerySchema,
    updateMarketSchema,
} from '../dto/market.dto';
import type { MarketService } from '../service/market.service';

export class MarketController {
    constructor(private readonly service: MarketService) { }

    /** GET /admin/markets */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.list(listMarketsQuerySchema.parse(req.query)));
    });

    /** GET /admin/markets/:marketId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getById(req.params.marketId as string) });
    });

    /** POST /admin/markets */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createMarketSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(dto) });
    });

    /** PATCH /admin/markets/:marketId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateMarketSchema.parse(req.body);
        res.json({ data: await this.service.update(req.params.marketId as string, dto) });
    });

    /** DELETE /admin/markets/:marketId — soft archive */
    archive: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.archive(req.params.marketId as string) });
    });
}

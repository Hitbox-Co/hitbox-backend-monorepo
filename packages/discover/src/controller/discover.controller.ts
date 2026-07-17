import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { discoverProductsQuerySchema } from '../dto/discover.dto';
import type { DiscoverService } from '../service/discover.service';

export class DiscoverController {
    constructor(private readonly service: DiscoverService) { }

    /** GET /discover — the full home feed in one round-trip. */
    getFeed: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: await this.service.getFeed() });
    });

    /** GET /discover/products — paginated section list / search. */
    listProducts: RequestHandler = asyncHandler(async (req, res) => {
        const query = discoverProductsQuerySchema.parse(req.query);
        const { items, total } = await this.service.listProducts(query);
        res.json({
            data: items,
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        });
    });
}

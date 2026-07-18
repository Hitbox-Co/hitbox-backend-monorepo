import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { marketplaceListingsQuerySchema } from '../dto/marketplace.dto';
import type { MarketplaceService } from '../service/marketplace.service';

export class MarketplaceController {
    constructor(private readonly service: MarketplaceService) { }

    /** GET /marketplace — the full screen feed in one round-trip. */
    getFeed: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: await this.service.getFeed() });
    });

    /** GET /marketplace/listings — category tabs / search / sort, paginated. */
    listListings: RequestHandler = asyncHandler(async (req, res) => {
        const query = marketplaceListingsQuerySchema.parse(req.query);
        const { items, total } = await this.service.listListings(query);
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

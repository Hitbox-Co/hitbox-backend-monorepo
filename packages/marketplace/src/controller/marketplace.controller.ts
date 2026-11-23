import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { marketplaceFeedQuerySchema, marketplaceListingsQuerySchema } from '../dto/marketplace.dto';
import type { MarketplaceService } from '../service/marketplace.service';

/**
 * The signed-in account, if the optional-auth middleware found one. Read
 * structurally so this module does not depend on the auth package.
 */
function viewerIdOf(req: Request): string | undefined {
    return (req as Request & { auth?: { accountId?: string } }).auth?.accountId;
}

export class MarketplaceController {
    constructor(private readonly service: MarketplaceService) { }

    /** GET /marketplace — the full screen feed in one round-trip. */
    getFeed: RequestHandler = asyncHandler(async (req, res) => {
        const query = marketplaceFeedQuerySchema.parse(req.query);
        res.json({ data: await this.service.getFeed({ ...query, viewerId: viewerIdOf(req) }) });
    });

    /** GET /marketplace/listings — category tabs / search / sort, paginated. */
    listListings: RequestHandler = asyncHandler(async (req, res) => {
        const { featured, ...query } = marketplaceListingsQuerySchema.parse(req.query);
        const { items, total } = await this.service.listListings({
            ...query,
            featuredOnly: featured,
            viewerId: viewerIdOf(req),
        });
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

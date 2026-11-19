import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    discoverCreatorsQuerySchema,
    discoverFeedQuerySchema,
    discoverProductsQuerySchema,
} from '../dto/discover.dto';
import type { DiscoverService } from '../service/discover.service';

/**
 * The signed-in account, if the optional-auth middleware found one. Read
 * structurally so this module does not depend on the auth package.
 */
function viewerIdOf(req: Request): string | undefined {
    return (req as Request & { auth?: { accountId?: string } }).auth?.accountId;
}

function pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export class DiscoverController {
    constructor(private readonly service: DiscoverService) { }

    /** GET /discover — the full home feed in one round-trip. */
    getFeed: RequestHandler = asyncHandler(async (req, res) => {
        const query = discoverFeedQuerySchema.parse(req.query);
        res.json({ data: await this.service.getFeed({ ...query, viewerId: viewerIdOf(req) }) });
    });

    /** GET /discover/products — paginated section list / search. */
    listProducts: RequestHandler = asyncHandler(async (req, res) => {
        const query = discoverProductsQuerySchema.parse(req.query);
        const { items, total } = await this.service.listProducts({
            ...query,
            viewerId: viewerIdOf(req),
        });
        res.json({ data: items, meta: pageMeta(query.page, query.limit, total) });
    });

    /** GET /discover/creators — paginated "Meet the creators". */
    listCreators: RequestHandler = asyncHandler(async (req, res) => {
        const query = discoverCreatorsQuerySchema.parse(req.query);
        const { items, total } = await this.service.listCreators(query);
        res.json({ data: items, meta: pageMeta(query.page, query.limit, total) });
    });
}

import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { searchQuerySchema } from '../dto/search.dto';
import type { SearchService } from '../service/search.service';

/** The signed-in account, if the optional-auth middleware found one. */
function viewerIdOf(req: Request): string | undefined {
    return (req as Request & { auth?: { accountId?: string } }).auth?.accountId;
}

export class SearchController {
    constructor(private readonly service: SearchService) { }

    /** GET /search — products, artists and collectors in one call. */
    search: RequestHandler = asyncHandler(async (req, res) => {
        const query = searchQuerySchema.parse(req.query);
        const result = await this.service.search({ ...query, viewerId: viewerIdOf(req) });

        // `all` is an overview with no pages; a single type is a paginated list.
        if (result.type === 'all') {
            res.json({ data: result });
            return;
        }
        const total = result[result.type]?.total ?? 0;
        res.json({
            data: result,
            meta: {
                page: result.page,
                limit: result.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / result.limit)),
            },
        });
    });
}

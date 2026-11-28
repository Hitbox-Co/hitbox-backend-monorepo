import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    artistCollectionsQuerySchema,
    artistIdParamSchema,
    collectionDetailQuerySchema,
    collectionIdParamSchema,
} from '../dto/collection-progress.dto';
import type { CollectionProgressService } from '../service/collection-progress.service';

/** The signed-in account, if the optional-auth middleware found one. */
function viewerIdOf(req: Request): string | undefined {
    return (req as Request & { auth?: { accountId?: string } }).auth?.accountId;
}

export class CollectionProgressController {
    constructor(private readonly service: CollectionProgressService) { }

    /** GET /collections/artist/:artistId — an artist's collections with my progress. */
    listForArtist: RequestHandler = asyncHandler(async (req, res) => {
        const { artistId } = artistIdParamSchema.parse(req.params);
        const query = artistCollectionsQuerySchema.parse(req.query);
        const { artist, items, total } = await this.service.listForArtist(artistId, query, viewerIdOf(req));
        res.json({
            data: { artist, items },
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        });
    });

    /** GET /collections/:collectionId/progress — every drop in the set, owned or missing. */
    detail: RequestHandler = asyncHandler(async (req, res) => {
        const { collectionId } = collectionIdParamSchema.parse(req.params);
        const query = collectionDetailQuerySchema.parse(req.query);
        res.json({ data: await this.service.getDetail(collectionId, query, viewerIdOf(req)) });
    });
}

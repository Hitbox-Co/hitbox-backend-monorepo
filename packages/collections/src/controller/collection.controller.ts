import type { RequestHandler } from 'express';
import type { AuthContext } from '@hitbox/auth';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    listCollectionQuerySchema,
    updateVisibilitySchema,
} from '../dto/collection.dto';
import type { CollectionService } from '../service/collection.service';

function paginationMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export class CollectionController {
    constructor(private readonly service: CollectionService) { }

    /** GET /collections/me 🔒 */
    listMine: RequestHandler = asyncHandler(async (req, res) => {
        const auth: AuthContext | undefined = req.auth;
        if (!auth) throw AppError.unauthorized();
        const query = listCollectionQuerySchema.parse(req.query);
        const { items, total } = await this.service.listMine(auth.accountId, query);
        res.json({ data: items, meta: paginationMeta(query.page, query.limit, total) });
    });

    /** PATCH /collections/me/:productId 🔒 */
    setVisibility: RequestHandler = asyncHandler(async (req, res) => {
        const auth = req.auth;
        if (!auth) throw AppError.unauthorized();
        const { visibility } = updateVisibilitySchema.parse(req.body);
        const item = await this.service.setVisibility(
            auth.accountId,
            req.params.productId as string,
            visibility,
        );
        res.json({ data: item });
    });

    /** GET /collections/user/:userId — public showcase, no auth */
    listPublicByUser: RequestHandler = asyncHandler(async (req, res) => {
        const query = listCollectionQuerySchema.parse(req.query);
        const { items, total } = await this.service.listPublicByUser(
            req.params.userId as string,
            query,
        );
        res.json({ data: items, meta: paginationMeta(query.page, query.limit, total) });
    });
}

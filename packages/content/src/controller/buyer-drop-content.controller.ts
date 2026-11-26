import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '@hitbox/shared';
import type { DropContentAccessService } from '../service/drop-content-access.service';
import type { ContentUserIdResolver } from './buyer-reward.controller';

const uuid = z.string().uuid();

/** HTTP for /api/v1/rewards/drops and /api/v1/rewards/units — a buyer's drop content. Parse, delegate, respond. */
export class BuyerDropContentController {
    constructor(
        private readonly access: DropContentAccessService,
        private readonly resolveUserId: ContentUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    /** GET /rewards/drops/:dropId */
    forDrop: RequestHandler = asyncHandler(async (req, res) => {
        const dropId = uuid.parse(req.params.dropId);
        res.json({ data: await this.access.forDrop(this.userId(req), dropId) });
    });

    /** GET /rewards/units/:skuId */
    forUnit: RequestHandler = asyncHandler(async (req, res) => {
        const skuId = uuid.parse(req.params.skuId);
        res.json({ data: await this.access.forUnit(this.userId(req), skuId) });
    });
}

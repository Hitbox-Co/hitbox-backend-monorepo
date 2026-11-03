import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '@hitbox/shared';
import type { RewardUnlockService } from '../service/reward-unlock.service';

/** The signed-in account id (`req => req.auth?.accountId`). Supplied by bootstrap. */
export type ContentUserIdResolver = (req: Request) => string | undefined;

const uuid = z.string().uuid();

/** HTTP for /api/v1/rewards — a buyer's collection rewards. Parse, delegate, respond. */
export class BuyerRewardController {
    constructor(
        private readonly unlocks: RewardUnlockService,
        private readonly resolveUserId: ContentUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    /** GET /rewards */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.unlocks.listMine(this.userId(req)) });
    });

    /** GET /rewards/collections/:collectionId */
    teaser: RequestHandler = asyncHandler(async (req, res) => {
        const collectionId = uuid.parse(req.params.collectionId);
        res.json({ data: await this.unlocks.teaser(this.userId(req), collectionId) });
    });

    /** GET /rewards/:rewardId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        const rewardId = uuid.parse(req.params.rewardId);
        res.json({ data: await this.unlocks.getMine(this.userId(req), rewardId) });
    });
}

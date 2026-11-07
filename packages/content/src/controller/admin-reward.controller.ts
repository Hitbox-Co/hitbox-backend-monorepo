import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '@hitbox/shared';
import { ADMIN_REWARDS_DEFAULT_LIMIT, ADMIN_REWARDS_MAX_LIMIT } from '../constants/content.constant';
import type { AdminRewardService, ModerationAction } from '../service/admin-reward.service';

/**
 * Request schemas for /api/v1/admin/rewards. docs/content/admin-rewards-api.md.
 */
const page = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(ADMIN_REWARDS_MAX_LIMIT).default(ADMIN_REWARDS_DEFAULT_LIMIT),
};

export const adminListRewardsQuerySchema = z
    .object({
        artistId: z.string().uuid().optional(),
        collectionId: z.string().uuid().optional(),
        /** LOCKED: switched off or removed by HitBox. */
        status: z.enum(['ON', 'OFF', 'REMOVED', 'LOCKED']).optional(),
        /** Reward, collection or artist name. */
        q: z.string().trim().min(1).max(100).optional(),
        ...page,
    })
    .strict();

export const adminRewardUnlocksQuerySchema = z
    .object({
        status: z.enum(['LIVE', 'ENDED']).optional(),
        ...page,
    })
    .strict();

const reason = z.string().trim().min(1).max(500);

/** switch-off / remove: the artist sees the reason, so it is required. */
export const moderationTakedownSchema = z.object({ reason }).strict();
/** switch-on / restore: optional note. */
export const moderationLiftSchema = z.object({ reason: reason.optional() }).strict();

const uuid = z.string().uuid();

type AuthorizedRequest = Request & { authz?: { userId: string; roleName?: string } };

/** HTTP for staff reward monitoring and moderation. Parse, delegate, respond. */
export class AdminRewardController {
    constructor(private readonly service: AdminRewardService) { }

    private id(req: Request): string {
        return uuid.parse(req.params.rewardId);
    }

    /** GET /admin/rewards */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.list(adminListRewardsQuerySchema.parse(req.query)));
    });

    /** GET /admin/rewards/summary */
    summary: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: await this.service.summary() });
    });

    /** GET /admin/rewards/:rewardId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.get(this.id(req)) });
    });

    /** GET /admin/rewards/:rewardId/unlocks */
    unlocks: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.unlocks(this.id(req), adminRewardUnlocksQuerySchema.parse(req.query)));
    });

    /** POST /admin/rewards/:rewardId/{switch-off|switch-on|remove|restore} */
    moderate(action: ModerationAction): RequestHandler {
        const schema = action === 'switch-off' || action === 'remove' ? moderationTakedownSchema : moderationLiftSchema;
        return asyncHandler(async (req, res) => {
            const dto = schema.parse(req.body ?? {});
            const authz = (req as AuthorizedRequest).authz;
            if (!authz?.userId) throw AppError.unauthorized('Sign in first.');
            res.json({
                data: await this.service.moderate(this.id(req), action, dto.reason, {
                    userId: authz.userId,
                    roleName: authz.roleName ?? null,
                }),
            });
        });
    }
}

import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '@hitbox/shared';
import { ADMIN_REWARDS_MAX_LIMIT, MAX_SERIALS_PER_TIER } from '../constants/content.constant';
import type { AdminActor, AdminDropContentService } from '../service/admin-drop-content.service';

const uuid = z.string().uuid();
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const adminDropUnitsQuerySchema = z
    .object({
        /** true → claimed/owned units only; false → still selectable ones only. */
        claimed: flag.optional(),
        variantId: uuid.optional(),
        serialFrom: z.coerce.number().int().min(1).optional(),
        serialTo: z.coerce.number().int().min(1).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(ADMIN_REWARDS_MAX_LIMIT).default(50),
    })
    .strict();

export const exclusiveUnitsBodySchema = z
    .object({ skuIds: z.array(uuid).min(1).max(MAX_SERIALS_PER_TIER) })
    .strict();

type AuthorizedRequest = Request & { authz?: { userId: string; roleName?: string } };

/** HitBox staff choosing which SKUs open a drop's exclusive content. */
export class AdminDropContentController {
    constructor(private readonly service: AdminDropContentService) { }

    /** GET /admin/rewards/drops/:dropId/content */
    tiers: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.tiers(this.param(req, 'dropId')) });
    });

    /** GET /admin/rewards/drops/:dropId/units */
    units: RequestHandler = asyncHandler(async (req, res) => {
        res.json(
            await this.service.units(this.param(req, 'dropId'), adminDropUnitsQuerySchema.parse(req.query)),
        );
    });

    /** POST /admin/rewards/drops/:dropId/content/:bundleId/units */
    addUnits: RequestHandler = asyncHandler(async (req, res) => {
        const { skuIds } = exclusiveUnitsBodySchema.parse(req.body);
        res.json({
            data: await this.service.addUnits(
                this.actor(req),
                this.param(req, 'dropId'),
                this.param(req, 'bundleId'),
                skuIds,
            ),
        });
    });

    /** POST /admin/rewards/drops/:dropId/content/:bundleId/units/remove */
    removeUnits: RequestHandler = asyncHandler(async (req, res) => {
        const { skuIds } = exclusiveUnitsBodySchema.parse(req.body);
        res.json({
            data: await this.service.removeUnits(
                this.actor(req),
                this.param(req, 'dropId'),
                this.param(req, 'bundleId'),
                skuIds,
            ),
        });
    });

    private actor(req: Request): AdminActor {
        const authz = (req as AuthorizedRequest).authz;
        if (!authz?.userId) throw AppError.unauthorized('Sign in first.');
        return { userId: authz.userId, roleName: authz.roleName ?? null };
    }

    private param(req: Request, name: string): string {
        return uuid.parse(req.params[name]);
    }
}

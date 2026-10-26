import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import type { ArtistStateAction } from '../constants/artist-admin.constant';
import {
    artistStateActionSchema,
    artistStatsQuerySchema,
    artistSummaryQuerySchema,
    staffUpdateArtistSchema,
} from '../dto/artist-admin.dto';
import type { ArtistAdminService, StaffActor, StaffViewer } from '../service/artist-admin.service';

/** "May this caller see money?" — supplied by bootstrap. */
export type MoneyVisibilityResolver = (req: Request) => Promise<boolean>;

/** What the permission guard leaves on the request (structural, not imported). */
type AuthorizedRequest = Request & { authz?: { userId: string; roleName?: string } };

/** HTTP for the staff artist screens under /api/v1/admin/artists. */
export class ArtistAdminController {
    constructor(
        private readonly service: ArtistAdminService,
        private readonly canSeeMoney: MoneyVisibilityResolver,
    ) { }

    private id(req: Request): string {
        return req.params.artistId as string;
    }

    private actor(req: Request): StaffActor {
        const authz = (req as AuthorizedRequest).authz;
        if (!authz?.userId) throw AppError.unauthorized('Sign in first.');
        return { userId: authz.userId, roleName: authz.roleName ?? null };
    }

    private async viewer(req: Request): Promise<StaffViewer> {
        return { canSeeMoney: await this.canSeeMoney(req) };
    }

    /** GET /admin/artists/summary */
    summary: RequestHandler = asyncHandler(async (req, res) => {
        const query = artistSummaryQuerySchema.parse(req.query);
        res.json({ data: await this.service.summary(query, await this.viewer(req)) });
    });

    /** GET /admin/artists/:artistId/profile */
    profile: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.profile(this.id(req), await this.viewer(req)) });
    });

    /** GET /admin/artists/:artistId/stats */
    stats: RequestHandler = asyncHandler(async (req, res) => {
        const query = artistStatsQuerySchema.parse(req.query);
        res.json({ data: await this.service.stats(this.id(req), query, await this.viewer(req)) });
    });

    /** PATCH /admin/artists/:artistId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = staffUpdateArtistSchema.parse(req.body);
        res.json({
            data: await this.service.update(this.id(req), dto, this.actor(req), await this.viewer(req)),
        });
    });

    /** POST /admin/artists/:artistId/{activate|deactivate|archive|restore|publish|unlist} */
    changeState(action: ArtistStateAction): RequestHandler {
        return asyncHandler(async (req, res) => {
            const dto = artistStateActionSchema.parse(req.body ?? {});
            res.json({
                data: await this.service.changeState(
                    this.id(req), action, dto, this.actor(req), await this.viewer(req),
                ),
            });
        });
    }
}

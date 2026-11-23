import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    artistIdParamSchema,
    followingQuerySchema,
    followListQuerySchema,
    userIdParamSchema,
} from '../dto/follow.dto';
import type { FollowService } from '../service/follow.service';

/** The signed-in account, if any. Read structurally so this module does not depend on auth. */
function viewerIdOf(req: Request): string | null {
    return (req as Request & { auth?: { accountId?: string } }).auth?.accountId ?? null;
}

function requireViewer(req: Request): string {
    const id = viewerIdOf(req);
    if (!id) throw AppError.unauthorized();
    return id;
}

function meta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export class FollowController {
    constructor(private readonly service: FollowService) { }

    /** POST /follows/users/:userId 🔒 */
    followUser: RequestHandler = asyncHandler(async (req, res) => {
        const { userId } = userIdParamSchema.parse(req.params);
        res.json({ data: await this.service.followUser(requireViewer(req), userId) });
    });

    /** DELETE /follows/users/:userId 🔒 */
    unfollowUser: RequestHandler = asyncHandler(async (req, res) => {
        const { userId } = userIdParamSchema.parse(req.params);
        res.json({ data: await this.service.unfollowUser(requireViewer(req), userId) });
    });

    /** POST /follows/artists/:artistId 🔒 */
    followArtist: RequestHandler = asyncHandler(async (req, res) => {
        const { artistId } = artistIdParamSchema.parse(req.params);
        res.json({ data: await this.service.followArtist(requireViewer(req), artistId) });
    });

    /** DELETE /follows/artists/:artistId 🔒 */
    unfollowArtist: RequestHandler = asyncHandler(async (req, res) => {
        const { artistId } = artistIdParamSchema.parse(req.params);
        res.json({ data: await this.service.unfollowArtist(requireViewer(req), artistId) });
    });

    /** GET /follows/users/:userId/followers — optional auth */
    followers: RequestHandler = asyncHandler(async (req, res) => {
        const { userId } = userIdParamSchema.parse(req.params);
        const query = followListQuerySchema.parse(req.query);
        const { items, total } = await this.service.listFollowers(userId, query, viewerIdOf(req));
        res.json({ data: items, meta: meta(query.page, query.limit, total) });
    });

    /** GET /follows/users/:userId/following?type=users|artists — optional auth */
    following: RequestHandler = asyncHandler(async (req, res) => {
        const { userId } = userIdParamSchema.parse(req.params);
        const query = followingQuerySchema.parse(req.query);
        const { items, total } = await this.service.listFollowing(userId, query, viewerIdOf(req));
        res.json({ data: items, meta: meta(query.page, query.limit, total) });
    });
}

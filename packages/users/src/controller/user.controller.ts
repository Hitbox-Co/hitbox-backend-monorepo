import type { RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { updateProfileSchema } from '../dto/user.dto';
import type { UserService } from '../service/user.service';

export class UserController {
    constructor(private readonly service: UserService) { }

    /** GET /users/me */
    me: RequestHandler = asyncHandler(async (req, res) => {
        const auth = req.auth;
        if (!auth) throw AppError.unauthorized();
        res.json({ data: await this.service.getMe(auth.accountId) });
    });

    /** PATCH /users/me */
    updateMe: RequestHandler = asyncHandler(async (req, res) => {
        const auth = req.auth;
        if (!auth) throw AppError.unauthorized();
        const dto = updateProfileSchema.parse(req.body);
        res.json({ data: await this.service.updateProfile(auth.accountId, dto) });
    });

    /** GET /users/:id — public profile */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getPublicById(req.params.id as string) });
    });
}

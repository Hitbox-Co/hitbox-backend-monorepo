import type { RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { updateProfileSchema, userIdParamSchema, handleParamSchema } from '../dto/user.dto';
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

    /** GET /users/:id — anyone's profile; optional auth fills `viewer`. */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        const { id } = userIdParamSchema.parse(req.params);
        res.json({ data: await this.service.getProfile(id, req.auth?.accountId ?? null) });
    });

    /** GET /users/handle/:handle — the same, by handle. */
    getByHandle: RequestHandler = asyncHandler(async (req, res) => {
        const { handle } = handleParamSchema.parse(req.params);
        res.json({ data: await this.service.getProfileByHandle(handle, req.auth?.accountId ?? null) });
    });
}

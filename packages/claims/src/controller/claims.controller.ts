import type { RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
// Pulls in the ambient `Express.Request.auth` augmentation declared by @hitbox/auth.
import type { AuthContext } from '@hitbox/auth';
import { claimBodySchema, tagIdParamSchema } from '../dto/claims.dto';
import type { ClaimsService } from '../service/claims.service';

export class ClaimsController {
    constructor(private readonly service: ClaimsService) { }

    /** GET /verify/:tagId — public authenticity + ownership check. */
    verify: RequestHandler = asyncHandler(async (req, res) => {
        const { tagId } = tagIdParamSchema.parse(req.params);
        res.json({ data: await this.service.verify(tagId) });
    });

    /** GET /ledger/:tagId — public provenance chain. */
    ledger: RequestHandler = asyncHandler(async (req, res) => {
        const { tagId } = tagIdParamSchema.parse(req.params);
        res.json({ data: await this.service.ledger(tagId) });
    });

    /**
     * POST /claims/:tagId — validate (auth). Reads the tag and returns which
     * screen to show + product details. Does NOT claim. 404 if not registered.
     */
    validate: RequestHandler = asyncHandler(async (req, res) => {
        const auth: AuthContext | undefined = req.auth;
        if (!auth) throw AppError.unauthorized();
        const { tagId } = tagIdParamSchema.parse(req.params);
        res.json({ data: await this.service.validate(tagId, auth.accountId) });
    });

    /**
     * POST /claims/:tagId/confirm — perform the claim (auth).
     * 200: `outcome` says whether this call claimed the product or reports the
     * existing owner. Only a missing product 404s.
     */
    confirm: RequestHandler = asyncHandler(async (req, res) => {
        const auth: AuthContext | undefined = req.auth;
        if (!auth) throw AppError.unauthorized();
        const { tagId } = tagIdParamSchema.parse(req.params);
        const body = claimBodySchema.parse(req.body ?? {});
        res.json({ data: await this.service.claim(tagId, auth.accountId, body) });
    });
}

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
        // Recorded on the token so the issuing request can be correlated with
        // the confirm that used it. Absent when the caller sends no header —
        // the column is nullable for exactly that reason.
        const requestId = req.header('x-request-id') ?? null;
        res.json({ data: await this.service.validate(tagId, auth.accountId, requestId) });
    });

    /**
     * POST /claims/:tagId/confirm — perform the claim (auth).
     *
     * 200: `outcome` says whether this call claimed the item, lost a
     *      simultaneous race (`CLAIMED_BY_OTHER_JUST_NOW`), or found it
     *      already claimed.
     * 400: the claim token is missing, malformed, or not this caller's.
     * 409: the token was already used — re-validate and try again.
     * 410: the token expired — likewise.
     * 404: no item carries this tag.
     */
    confirm: RequestHandler = asyncHandler(async (req, res) => {
        const auth: AuthContext | undefined = req.auth;
        if (!auth) throw AppError.unauthorized();
        const { tagId } = tagIdParamSchema.parse(req.params);
        const body = claimBodySchema.parse(req.body ?? {});
        res.json({ data: await this.service.claim(tagId, auth.accountId, body) });
    });
}

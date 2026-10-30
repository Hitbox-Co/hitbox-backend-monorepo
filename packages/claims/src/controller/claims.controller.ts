import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
// Pulls in the ambient `Express.Request.auth` augmentation declared by @hitbox/auth.
import type { AuthContext } from '@hitbox/auth';
import {
    claimBodySchema,
    claimTapBodySchema,
    tagIdParamSchema,
    verifyTapQuerySchema,
} from '../dto/claims.dto';
import type { ClaimsService } from '../service/claims.service';

export class ClaimsController {
    constructor(private readonly service: ClaimsService) { }

    /**
     * GET /verify?b=&e=&c= — public authenticity check from a tap URL.
     * Never claims. `no-store`: every tap URL is single-use, so a cached answer
     * would be wrong the moment it was served twice.
     */
    verifyTap: RequestHandler = asyncHandler(async (req, res) => {
        const query = verifyTapQuerySchema.parse(req.query);
        const data = await this.service.verifyByTap(query, requestIdOf(req));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ data });
    });

    /**
     * POST /claim — claim an item with the tap URL's own b/e/c (auth). The
     * claimer is always the signed-in user. A tap that does not authenticate is
     * HTTP 200 `{ verified: false, outcome: "NOT_VERIFIED" }` whatever the cause.
     */
    claimTap: RequestHandler = asyncHandler(async (req, res) => {
        const auth: AuthContext | undefined = req.auth;
        if (!auth) throw AppError.unauthorized();
        const body = claimTapBodySchema.parse(req.body ?? {});
        const data = await this.service.claimByTap(auth.accountId, body, requestIdOf(req));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ data });
    });

    /** GET /verify/:tagId — public authenticity + ownership check. DEPRECATED. */
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

/**
 * Correlates a tap with its NfcVerification row. Taken from the correlation
 * middleware, never from a client header: a caller-chosen id would let anyone
 * write arbitrary text into the verification log.
 */
function requestIdOf(req: Request): string {
    return (req as Request & { correlationId?: string }).correlationId ?? randomUUID();
}

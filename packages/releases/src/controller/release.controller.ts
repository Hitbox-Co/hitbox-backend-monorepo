import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    decideReleaseApprovalSchema,
    listReleaseApprovalsQuerySchema,
    submitForReviewSchema,
    updateReleaseApprovalSchema,
} from '../dto/release.dto';
import type { ReleaseService, ReleaseView } from '../service/release.service';

export type ReleaseCallerResolver = (req: Request) => Promise<{ userId: string } & ReleaseView>;

export class ReleaseController {
    constructor(
        private readonly service: ReleaseService,
        private readonly resolveCaller: ReleaseCallerResolver,
    ) { }

    /** GET /admin/releases */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listReleaseApprovalsQuerySchema.parse(req.query);
        const caller = await this.resolveCaller(req);
        res.json(await this.service.list(query, caller));
    });

    /** GET /admin/releases/:approvalId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        const caller = await this.resolveCaller(req);
        res.json({ data: await this.service.getById(req.params.approvalId as string, caller) });
    });

    /** POST /admin/releases — open a review at version N+1 */
    submit: RequestHandler = asyncHandler(async (req, res) => {
        const dto = submitForReviewSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.status(201).json({ data: await this.service.submitForReview(dto, caller.userId) });
    });

    /** PATCH /admin/releases/:approvalId — amend an undecided review */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateReleaseApprovalSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.json({
            data: await this.service.update(req.params.approvalId as string, dto, caller),
        });
    });

    /** POST /admin/releases/:approvalId/decision — approve or reject */
    decide: RequestHandler = asyncHandler(async (req, res) => {
        const dto = decideReleaseApprovalSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.json({
            data: await this.service.decide({
                id: req.params.approvalId as string,
                dto,
                view: caller,
                actorId: caller.userId,
            }),
        });
    });
}

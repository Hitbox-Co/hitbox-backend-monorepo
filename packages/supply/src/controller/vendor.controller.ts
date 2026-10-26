import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { buildSupplyAccess } from '../domain/supply-access';
import {
    assignVendorDropSchema,
    inviteVendorMemberSchema,
    listVendorMembersQuerySchema,
    registerTagsSchema,
    revokeVendorMemberSchema,
    updateVendorAllotmentSchema,
    patchVendorAllotmentSchema,
    vendorCreateBatchSchema,
    vendorListBatchesQuerySchema,
} from '../dto/supply.dto';
import type { SupplyMutationContext } from '../service/supply.service';
import type { VendorAdminService } from '../service/vendor-admin.service';
import type { VendorPortalService } from '../service/vendor-portal.service';
import type { SupplyPrincipalResolver } from './supply.controller';

/** The caller's own account id, as the auth middleware set it. */
export type VendorUserIdResolver = (req: Request) => string | undefined;

function correlationOf(req: Request): string {
    return (req as Request & { correlationId?: string }).correlationId ?? randomUUID();
}

/** HitBox staff administering vendor members and drop assignments. */
export class VendorAdminController {
    constructor(
        private readonly service: VendorAdminService,
        private readonly resolvePrincipal: SupplyPrincipalResolver,
    ) { }

    /** GET /admin/supply/vendors/:vendorId/members */
    listMembers: RequestHandler = asyncHandler(async (req, res) => {
        const { context } = await this.mutation(req);
        res.json(
            await this.service.listMembers(
                context,
                req.params.vendorId as string,
                listVendorMembersQuerySchema.parse(req.query),
            ),
        );
    });

    /** POST /admin/supply/vendors/:vendorId/members */
    inviteMember: RequestHandler = asyncHandler(async (req, res) => {
        const dto = inviteVendorMemberSchema.parse(req.body ?? {});
        const { context, permissions } = await this.mutation(req);
        const result = await this.service.inviteMember(
            context,
            permissions,
            req.params.vendorId as string,
            dto,
        );
        res.status(201).json({ data: result });
    });

    /** POST /admin/supply/vendors/:vendorId/members/:memberId/revoke */
    revokeMember: RequestHandler = asyncHandler(async (req, res) => {
        const dto = revokeVendorMemberSchema.parse(req.body);
        const { context } = await this.mutation(req);
        res.json({
            data: await this.service.revokeMember(
                context,
                req.params.vendorId as string,
                req.params.memberId as string,
                dto,
            ),
        });
    });

    /** GET /admin/supply/vendors/:vendorId/drops */
    listDrops: RequestHandler = asyncHandler(async (req, res) => {
        const { context } = await this.mutation(req);
        res.json(await this.service.listDrops(context, req.params.vendorId as string));
    });

    /** POST /admin/supply/vendors/:vendorId/drops */
    assignDrop: RequestHandler = asyncHandler(async (req, res) => {
        const dto = assignVendorDropSchema.parse(req.body);
        const { context } = await this.mutation(req);
        res.status(201).json({
            data: await this.service.assignDrop(context, req.params.vendorId as string, dto),
        });
    });

    /** PUT /admin/supply/vendors/:vendorId/drops/:dropId/allotment */
    updateAllotment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateVendorAllotmentSchema.parse(req.body);
        const { context } = await this.mutation(req);
        res.json({
            data: await this.service.updateAllotment(
                context,
                req.params.vendorId as string,
                req.params.dropId as string,
                dto,
            ),
        });
    });

    /** PATCH /admin/supply/vendors/:vendorId/drops/:dropId/allotment */
    patchAllotment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = patchVendorAllotmentSchema.parse(req.body);
        const { context } = await this.mutation(req);
        res.json({
            data: await this.service.patchAllotment(
                context,
                req.params.vendorId as string,
                req.params.dropId as string,
                dto,
            ),
        });
    });

    /** DELETE /admin/supply/vendors/:vendorId/drops/:dropId */
    unassignDrop: RequestHandler = asyncHandler(async (req, res) => {
        const { context } = await this.mutation(req);
        await this.service.unassignDrop(
            context,
            req.params.vendorId as string,
            req.params.dropId as string,
        );
        res.status(204).end();
    });

    private async mutation(
        req: Request,
    ): Promise<{ context: SupplyMutationContext; permissions: string[] }> {
        const principal = await this.resolvePrincipal(req);
        return {
            context: { access: buildSupplyAccess(principal), correlationId: correlationOf(req) },
            permissions: principal.permissions,
        };
    }
}

/** The vendor portal — a vendor's own staff, mounted at /api/v1/vendor. */
export class VendorPortalController {
    constructor(
        private readonly service: VendorPortalService,
        private readonly resolveUserId: VendorUserIdResolver,
    ) { }

    /** GET /vendor/me */
    me: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.me(this.userId(req)) });
    });

    /** GET /vendor/drops */
    listDrops: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.listDrops(this.userId(req)));
    });

    /** GET /vendor/batches */
    listBatches: RequestHandler = asyncHandler(async (req, res) => {
        res.json(
            await this.service.listBatches(
                this.userId(req),
                vendorListBatchesQuerySchema.parse(req.query),
            ),
        );
    });

    /** GET /vendor/batches/:batchId */
    getBatch: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getBatch(this.userId(req), req.params.batchId as string),
        });
    });

    /** POST /vendor/batches */
    createBatch: RequestHandler = asyncHandler(async (req, res) => {
        const dto = vendorCreateBatchSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.createBatch(this.userId(req), correlationOf(req), dto),
        });
    });

    /** POST /vendor/batches/:batchId/tags */
    registerTags: RequestHandler = asyncHandler(async (req, res) => {
        const dto = registerTagsSchema.parse(req.body);
        res.json({
            data: await this.service.registerTags(
                this.userId(req),
                correlationOf(req),
                req.params.batchId as string,
                dto,
            ),
        });
    });

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in to use the vendor portal.');
        return id;
    }
}

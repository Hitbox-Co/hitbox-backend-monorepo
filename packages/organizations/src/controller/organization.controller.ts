import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { listOrganizationsQuerySchema } from '../dto/organization.dto';
import type { OrganizationService } from '../service/organization.service';

export class OrganizationController {
    constructor(private readonly service: OrganizationService) { }

    /** GET /admin/organizations */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.list(listOrganizationsQuerySchema.parse(req.query)));
    });

    /** GET /admin/organizations/:organizationId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getById(req.params.organizationId as string),
        });
    });
}

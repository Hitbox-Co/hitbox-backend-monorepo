import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { OrganizationStatus } from '@hitbox/database';
import { AUTHZ_ERROR_CODES } from '../constants/authz.constant';
import {
    addMemberSchema,
    createOrganizationSchema,
    updateOrganizationSchema,
} from '../dto/authz.dto';
import type { AuthzContext } from '../types/authz.types';
import type { OrganizationService } from '../service/organization.service';

function contextOf(req: Request): AuthzContext {
    const context = req.authz;
    if (!context) {
        throw AppError.unauthorized(
            'Authentication required',
            AUTHZ_ERROR_CODES.MISSING_AUTH_CONTEXT,
        );
    }
    return context;
}

function requestContext(req: Request) {
    return {
        surface: req.authz?.surface ?? null,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
        requestId: req.header('x-request-id') ?? null,
    };
}

export class OrganizationController {
    constructor(private readonly service: OrganizationService) { }

    /** POST /organizations — platform operators only (organization:create:any). */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createOrganizationSchema.parse(req.body);
        const { principal } = contextOf(req);
        const organization = await this.service.create(principal, dto, requestContext(req));
        res.status(201).json({ data: organization });
    });

    /** GET /organizations/:organizationId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getById(req.params.organizationId as string) });
    });

    /** PATCH /organizations/:organizationId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateOrganizationSchema.parse(req.body);
        const { principal } = contextOf(req);
        const organization = await this.service.update(
            principal,
            req.params.organizationId as string,
            {
                ...(dto.name === undefined ? {} : { name: dto.name }),
                ...(dto.status === undefined
                    ? {}
                    : { status: dto.status as OrganizationStatus }),
            },
            requestContext(req),
        );
        res.json({ data: organization });
    });

    /** DELETE /organizations/:organizationId — soft delete. */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        const { principal } = contextOf(req);
        await this.service.remove(
            principal,
            req.params.organizationId as string,
            requestContext(req),
        );
        res.status(204).send();
    });

    /** GET /organizations/:organizationId/members */
    listMembers: RequestHandler = asyncHandler(async (req, res) => {
        const members = await this.service.listMembers(req.params.organizationId as string);
        res.json({
            data: members.map((member) => ({
                userId: member.userId,
                status: member.status,
                joinedAt: member.createdAt,
                email: member.user.email,
                username: member.user.username,
                firstName: member.user.firstName,
                lastName: member.user.lastName,
            })),
        });
    });

    /** POST /organizations/:organizationId/members */
    addMember: RequestHandler = asyncHandler(async (req, res) => {
        const dto = addMemberSchema.parse(req.body);
        const { principal } = contextOf(req);
        const result = await this.service.addMember(
            principal,
            req.params.organizationId as string,
            dto.email,
            requestContext(req),
        );
        res.status(201).json({ data: result });
    });

    /** DELETE /organizations/:organizationId/members/:userId */
    removeMember: RequestHandler = asyncHandler(async (req, res) => {
        const { principal } = contextOf(req);
        await this.service.removeMember(
            principal,
            req.params.organizationId as string,
            req.params.userId as string,
            requestContext(req),
        );
        res.status(204).send();
    });
}

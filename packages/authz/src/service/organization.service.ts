import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { MembershipStatus, OrganizationStatus } from '@hitbox/database';
import type { Organization } from '@hitbox/database';
import { AUTHZ_ERROR_CODES, AUTHZ_EVENTS } from '../constants/authz.constant';
import { AuditActorType, AuditResult } from '../domain/enums/audit.enum';
import { RESOURCES } from '../domain/catalog/resources';
import type { AuthzPrincipal } from '../domain/interfaces/principal.interface';
import type { IUserDirectory } from '../domain/interfaces/user-directory.interface';
import type { OrganizationRepository } from '../repository/organization.repository';
import type { AuthorizationService } from './authorization.service';
import type { AuditService } from './audit.service';
import type { RequestContext } from './role-assignment.service';

interface OrganizationServiceDeps {
    repository: OrganizationRepository;
    authorization: AuthorizationService;
    audit: AuditService;
    users: IUserDirectory;
    eventBus: IEventBus;
    logger: Logger;
}

/**
 * Tenant lifecycle and membership. Route-level middleware has already checked
 * the capability by the time these methods run; what lives here is the
 * behaviour that must not be forgotten — cache invalidation on every membership
 * change, and an audit record for every lifecycle event.
 */
export class OrganizationService {
    constructor(private readonly deps: OrganizationServiceDeps) { }

    async getById(organizationId: string): Promise<Organization> {
        const organization = await this.deps.repository.findById(organizationId);
        if (!organization) {
            throw AppError.notFound(
                'Organization not found',
                AUTHZ_ERROR_CODES.ORGANIZATION_NOT_FOUND,
            );
        }
        return organization;
    }

    /**
     * Resolves and validates the tenant a request claims to act in. Called by
     * the organization-context middleware, so every organization-scoped route
     * shares exactly one definition of "is this a tenant you may act in".
     */
    assertActiveMember(principal: AuthzPrincipal, organizationId: string): void {
        const membership = principal.organizations.find(
            (organization) => organization.id === organizationId,
        );
        if (!membership) {
            // Deliberately the same shape whether the organization does not
            // exist or the caller simply is not in it — do not leak tenant
            // existence to outsiders.
            throw AppError.forbidden(
                'You are not a member of this organization',
                AUTHZ_ERROR_CODES.ORGANIZATION_FORBIDDEN,
            );
        }
    }

    async create(
        actor: AuthzPrincipal,
        input: { slug: string; name: string },
        context?: RequestContext,
    ): Promise<Organization> {
        const existing = await this.deps.repository.findBySlug(input.slug);
        if (existing) {
            throw AppError.conflict(`Organization slug "${input.slug}" is taken`);
        }

        const organization = await this.deps.repository.create(input);

        await this.deps.audit.record({
            actorUserId: actor.userId,
            actorType: AuditActorType.USER,
            action: 'organization:create',
            resource: RESOURCES.ORGANIZATION,
            resourceId: organization.id,
            organizationId: organization.id,
            result: AuditResult.SUCCESS,
            surface: context?.surface ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            metadata: { slug: organization.slug, name: organization.name },
        });

        return organization;
    }

    async update(
        actor: AuthzPrincipal,
        organizationId: string,
        input: { name?: string; status?: OrganizationStatus },
        context?: RequestContext,
    ): Promise<Organization> {
        const before = await this.getById(organizationId);
        const organization = await this.deps.repository.update(organizationId, input);

        await this.deps.audit.record({
            actorUserId: actor.userId,
            actorType: AuditActorType.USER,
            action: 'organization:update',
            resource: RESOURCES.ORGANIZATION,
            resourceId: organizationId,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: context?.surface ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            metadata: {
                before: { name: before.name, status: before.status },
                after: { name: organization.name, status: organization.status },
            },
        });

        // Suspending a tenant must take effect immediately: loadPrincipal drops
        // grants for non-ACTIVE organizations, so every member's snapshot is
        // now wrong.
        if (input.status && input.status !== before.status) {
            await this.invalidateMembers(organizationId);
        }

        return organization;
    }

    async remove(
        actor: AuthzPrincipal,
        organizationId: string,
        context?: RequestContext,
    ): Promise<void> {
        await this.getById(organizationId);
        await this.deps.repository.softDelete(organizationId);
        await this.invalidateMembers(organizationId);

        await this.deps.audit.record({
            actorUserId: actor.userId,
            actorType: AuditActorType.USER,
            action: 'organization:delete',
            resource: RESOURCES.ORGANIZATION,
            resourceId: organizationId,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: context?.surface ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            metadata: { softDeleted: true },
        });
    }

    listMembers(organizationId: string) {
        return this.deps.repository.listMembers(organizationId);
    }

    /** Adds (or re-activates) a member by email. Roles are granted separately. */
    async addMember(
        actor: AuthzPrincipal,
        organizationId: string,
        email: string,
        context?: RequestContext,
    ): Promise<{ userId: string }> {
        await this.getById(organizationId);

        const user = await this.deps.users.findByEmail(email);
        if (!user || user.deleted) {
            throw AppError.notFound('No platform account for that email address');
        }

        await this.deps.repository.upsertMembership({
            userId: user.id,
            organizationId,
            status: MembershipStatus.ACTIVE,
        });
        await this.deps.authorization.invalidate(user.id);

        await this.deps.audit.record({
            actorUserId: actor.userId,
            actorType: AuditActorType.USER,
            action: 'organization-member:invite',
            resource: RESOURCES.ORGANIZATION_MEMBER,
            resourceId: user.id,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: context?.surface ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            metadata: { targetUserId: user.id, email },
        });

        void this.deps.eventBus.publish(AUTHZ_EVENTS.MEMBERSHIP_CHANGED, {
            userId: user.id,
            organizationId,
            status: MembershipStatus.ACTIVE,
        });

        return { userId: user.id };
    }

    /**
     * Removing a member also drops every role they held in that tenant (see the
     * repository transaction) — otherwise re-adding them later would silently
     * restore permissions an administrator believed were gone.
     */
    async removeMember(
        actor: AuthzPrincipal,
        organizationId: string,
        targetUserId: string,
        context?: RequestContext,
    ): Promise<void> {
        const membership = await this.deps.repository.findMembership(targetUserId, organizationId);
        if (!membership) {
            throw AppError.notFound('That user is not a member of this organization');
        }

        await this.deps.repository.removeMembership(targetUserId, organizationId);
        await this.deps.authorization.invalidate(targetUserId);

        await this.deps.audit.record({
            actorUserId: actor.userId,
            actorType: AuditActorType.USER,
            action: 'organization-member:delete',
            resource: RESOURCES.ORGANIZATION_MEMBER,
            resourceId: targetUserId,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: context?.surface ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            metadata: { targetUserId, rolesRevoked: true },
        });

        void this.deps.eventBus.publish(AUTHZ_EVENTS.MEMBERSHIP_CHANGED, {
            userId: targetUserId,
            organizationId,
            status: 'REMOVED',
        });
    }

    /** Every member's cached snapshot is stale after a tenant-wide change. */
    private async invalidateMembers(organizationId: string): Promise<void> {
        const members = await this.deps.repository.listMembers(organizationId);
        await this.deps.authorization.invalidateMany(members.map((member) => member.userId));
        this.deps.logger.info(
            { organizationId, members: members.length },
            'invalidated permission cache for organization members',
        );
    }
}

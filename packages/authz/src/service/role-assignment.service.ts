import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { AUTHZ_ERROR_CODES, AUTHZ_EVENTS } from '../constants/authz.constant';
import { AuditActorType, AuditResult } from '../domain/enums/audit.enum';
import { PermissionScope, PERMISSION_SCOPE_RANK } from '../domain/enums/permission-scope.enum';
import { RoleKind } from '../domain/enums/role-kind.enum';
import { DEFAULT_PLATFORM_ROLE } from '../domain/catalog/role-catalog';
import { RESOURCES, ACTIONS, READ_ONLY_ACTIONS } from '../domain/catalog/resources';
import { parsePermissionKey } from '../domain/permission-key';
import type { AuthzPrincipal } from '../domain/interfaces/principal.interface';
import type { IUserDirectory } from '../domain/interfaces/user-directory.interface';
import { applicableGrants } from '../domain/policy/scope-policy';
import type { AuthzRepository, RoleSummary } from '../repository/authz.repository';
import type { AuthorizationService } from './authorization.service';
import type { AuditService } from './audit.service';

export interface RequestContext {
    surface?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
}

export interface AssignRoleInput {
    /** The administrator performing the grant. */
    actor: AuthzPrincipal;
    targetUserId: string;
    roleKey: string;
    /** Required for ORGANIZATION roles, must be null for PLATFORM roles. */
    organizationId: string | null;
    expiresAt?: Date | null;
    context?: RequestContext;
}

export interface RevokeRoleInput {
    actor: AuthzPrincipal;
    targetUserId: string;
    roleKey: string;
    organizationId: string | null;
    context?: RequestContext;
}

interface RoleAssignmentServiceDeps {
    repository: AuthzRepository;
    authorization: AuthorizationService;
    audit: AuditService;
    users: IUserDirectory;
    eventBus: IEventBus;
    logger: Logger;
}

/**
 * ROLE ASSIGNMENT — the most security-sensitive write in the platform, because
 * it is the one operation that can change what every other check decides.
 *
 * Every grant passes six gates, in this order:
 *   1. the role exists and is assignable
 *   2. the target user exists and is not deleted
 *   3. nobody may change their own role assignments (no self-elevation)
 *   4. the role's kind matches the context (platform vs tenant)
 *   5. the actor holds `role:assign` reaching the target context, and
 *      privileged/platform roles additionally require `role:assign:any`
 *   6. no horizontal or vertical escalation: an actor may never hand out a
 *      capability wider than one they hold themselves
 *
 * Then, and only then: write, invalidate the target's cached permissions, and
 * write a durable audit record. The audit write is awaited — a grant we cannot
 * account for is treated as a failed grant.
 */
export class RoleAssignmentService {
    constructor(private readonly deps: RoleAssignmentServiceDeps) { }

    async assign(input: AssignRoleInput): Promise<{ created: boolean }> {
        const role = await this.requireRole(input.roleKey);

        const target = await this.deps.users.findById(input.targetUserId);
        if (!target || target.deleted) {
            throw AppError.notFound('Target user not found', AUTHZ_ERROR_CODES.ROLE_NOT_FOUND);
        }

        this.assertNotSelf(input.actor, input.targetUserId, 'assign');
        const organizationId = this.normalizeContext(role, input.organizationId);
        this.assertActorMayGrant(input.actor, role, organizationId);
        this.assertNoEscalation(input.actor, role, organizationId);

        const result = await this.deps.repository.grantRole({
            userId: input.targetUserId,
            roleId: role.id,
            organizationId,
            grantedById: input.actor.userId,
            expiresAt: input.expiresAt ?? null,
        });

        // The target's cached permissions are now wrong — clear them before
        // returning, so the very next request they make sees the new role.
        await this.deps.authorization.invalidate(input.targetUserId);

        await this.deps.audit.record({
            actorUserId: input.actor.userId,
            actorType: AuditActorType.USER,
            action: 'role:assign',
            resource: RESOURCES.ROLE,
            resourceId: role.id,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: input.context?.surface ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            requestId: input.context?.requestId ?? null,
            metadata: {
                roleKey: role.key,
                roleKind: role.kind,
                isPrivileged: role.isPrivileged,
                targetUserId: input.targetUserId,
                expiresAt: input.expiresAt?.toISOString() ?? null,
                alreadyHeld: !result.created,
                grantedPermissions: role.permissionKeys,
            },
        });

        void this.deps.eventBus.publish(AUTHZ_EVENTS.ROLE_ASSIGNED, {
            userId: input.targetUserId,
            roleKey: role.key,
            organizationId,
            actorUserId: input.actor.userId,
        });

        this.deps.logger.info(
            {
                actorUserId: input.actor.userId,
                targetUserId: input.targetUserId,
                roleKey: role.key,
                organizationId,
            },
            'role assigned',
        );

        return { created: result.created };
    }

    async revoke(input: RevokeRoleInput): Promise<{ removed: number }> {
        const role = await this.requireRole(input.roleKey);

        this.assertNotSelf(input.actor, input.targetUserId, 'revoke');
        const organizationId = this.normalizeContext(role, input.organizationId);
        this.assertActorMayGrant(input.actor, role, organizationId, ACTIONS.REVOKE);

        // Lock-out protection: never let the platform end up with nobody who
        // can administer it. Recovering from that needs direct DB access.
        if (role.key === 'SUPER_ADMIN') {
            const holders = await this.deps.repository.listUserIdsWithRole(role.id);
            if (holders.length <= 1) {
                throw AppError.badRequest(
                    'Cannot revoke the last SUPER_ADMIN — grant the role to another account first',
                    AUTHZ_ERROR_CODES.ROLE_NOT_ASSIGNABLE,
                );
            }
        }

        const removed = await this.deps.repository.revokeRole({
            userId: input.targetUserId,
            roleId: role.id,
            organizationId,
        });

        if (removed === 0) {
            throw AppError.notFound(
                'That user does not hold this role in this context',
                AUTHZ_ERROR_CODES.ASSIGNMENT_NOT_FOUND,
            );
        }

        await this.deps.authorization.invalidate(input.targetUserId);

        await this.deps.audit.record({
            actorUserId: input.actor.userId,
            actorType: AuditActorType.USER,
            action: 'role:revoke',
            resource: RESOURCES.ROLE,
            resourceId: role.id,
            organizationId,
            result: AuditResult.SUCCESS,
            surface: input.context?.surface ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            requestId: input.context?.requestId ?? null,
            metadata: {
                roleKey: role.key,
                targetUserId: input.targetUserId,
                revokedPermissions: role.permissionKeys,
            },
        });

        void this.deps.eventBus.publish(AUTHZ_EVENTS.ROLE_REVOKED, {
            userId: input.targetUserId,
            roleKey: role.key,
            organizationId,
            actorUserId: input.actor.userId,
        });

        return { removed };
    }

    /**
     * SYSTEM path — grants the baseline platform role to a newly provisioned
     * user. Bypasses the actor gates because there is no actor; it can only
     * ever grant DEFAULT_PLATFORM_ROLE, which is hard-coded here rather than
     * taken from the caller. Idempotent: safe under webhook/event replay.
     */
    async ensureDefaultRole(userId: string): Promise<void> {
        const role = await this.deps.repository.findRoleByKey(DEFAULT_PLATFORM_ROLE);
        if (!role) {
            this.deps.logger.error(
                { roleKey: DEFAULT_PLATFORM_ROLE },
                'default platform role missing — run the authz seeder',
            );
            return;
        }

        const result = await this.deps.repository.grantRole({
            userId,
            roleId: role.id,
            organizationId: null,
            grantedById: null,
            expiresAt: null,
        });

        if (!result.created) return;

        await this.deps.authorization.invalidate(userId);
        this.deps.audit.emit({
            actorUserId: null,
            actorType: AuditActorType.SYSTEM,
            action: 'role:assign',
            resource: RESOURCES.ROLE,
            resourceId: role.id,
            result: AuditResult.SUCCESS,
            metadata: { roleKey: role.key, targetUserId: userId, reason: 'default role on provisioning' },
        });
    }

    listForUser(userId: string, organizationId?: string | null) {
        return this.deps.repository.listAssignmentsForUser(userId, organizationId);
    }

    // ------------------------------------------------------------- the gates

    private async requireRole(roleKey: string): Promise<RoleSummary> {
        const role = await this.deps.repository.findRoleByKey(roleKey);
        if (!role) {
            throw AppError.notFound(`Unknown role "${roleKey}"`, AUTHZ_ERROR_CODES.ROLE_NOT_FOUND);
        }
        return role;
    }

    /**
     * Gate 3. Even a SUPER_ADMIN must go through another administrator to
     * change their own grants — that is what makes the audit trail meaningful
     * and stops a compromised session from quietly widening itself.
     */
    private assertNotSelf(actor: AuthzPrincipal, targetUserId: string, verb: string): void {
        if (actor.userId !== targetUserId) return;
        throw AppError.forbidden(
            `You cannot ${verb} your own roles — ask another administrator`,
            AUTHZ_ERROR_CODES.SELF_ASSIGNMENT_BLOCKED,
        );
    }

    /** Gate 4. Platform roles carry no tenant; organization roles require one. */
    private normalizeContext(role: RoleSummary, organizationId: string | null): string | null {
        if (role.kind === RoleKind.PLATFORM) {
            if (organizationId !== null) {
                throw AppError.badRequest(
                    `Role "${role.key}" is a platform role and cannot be scoped to an organization`,
                    AUTHZ_ERROR_CODES.ROLE_NOT_ASSIGNABLE,
                );
            }
            return null;
        }

        if (organizationId === null) {
            throw AppError.badRequest(
                `Role "${role.key}" is an organization role and requires an organization context`,
                AUTHZ_ERROR_CODES.ORGANIZATION_REQUIRED,
            );
        }
        return organizationId;
    }

    /**
     * Gate 5. The actor needs `role:assign` (or `role:revoke`) reaching this
     * context. Privileged and platform-wide roles need it at ANY scope, which
     * an ORG_ADMIN never has — that is the concrete mechanism behind
     * "an organization admin does not become a platform admin".
     */
    private assertActorMayGrant(
        actor: AuthzPrincipal,
        role: RoleSummary,
        organizationId: string | null,
        action: string = ACTIONS.ASSIGN,
    ): void {
        const request = { resource: RESOURCES.ROLE, action, organizationId };

        if (role.isPrivileged || role.kind === RoleKind.PLATFORM) {
            const platformWide = applicableGrants(actor, {
                resource: RESOURCES.ROLE,
                action,
                organizationId: null,
            }).some((grant) => grant.scope === PermissionScope.ANY);

            if (!platformWide) {
                throw AppError.forbidden(
                    `Granting "${role.key}" requires role:${action}:any`,
                    AUTHZ_ERROR_CODES.ESCALATION_BLOCKED,
                );
            }
            return;
        }

        // Organization role: the grant must be authorized *for that tenant*.
        const grants = applicableGrants(actor, request);
        const permitted = grants.some(
            (grant) =>
                grant.scope === PermissionScope.ANY ||
                (grant.scope === PermissionScope.ORGANIZATION &&
                    grant.organizationId !== null &&
                    grant.organizationId === organizationId),
        );

        if (!permitted) {
            throw AppError.forbidden(
                `Missing permission role:${action} in this organization`,
                AUTHZ_ERROR_CODES.PERMISSION_DENIED,
            );
        }
    }

    /**
     * Gate 6. No escalation.
     *
     * For privileged/platform roles we require a strict superset: the actor must
     * already hold every capability the role carries, at least as widely. So
     * only a SUPER_ADMIN can mint a SUPER_ADMIN, and nobody can bootstrap a
     * capability they lack by routing it through a role.
     *
     * For ordinary organization roles the delegation boundary is
     * `role:assign:organization` itself — an ORG_ADMIN is meant to be able to
     * appoint a PRODUCT_MANAGER without personally holding
     * `product:create:organization`. What is still forbidden is handing out a
     * MUTATING platform-wide (`any`) capability, which would escape the tenant.
     */
    private assertNoEscalation(
        actor: AuthzPrincipal,
        role: RoleSummary,
        organizationId: string | null,
    ): void {
        const strictSuperset = role.isPrivileged || role.kind === RoleKind.PLATFORM;

        for (const key of role.permissionKeys) {
            const parsed = parsePermissionKey(key);

            if (strictSuperset) {
                const held = applicableGrants(actor, {
                    resource: parsed.resource,
                    action: parsed.action,
                    organizationId,
                }).some(
                    (grant) =>
                        PERMISSION_SCOPE_RANK[grant.scope] >= PERMISSION_SCOPE_RANK[parsed.scope],
                );

                if (!held) {
                    throw AppError.forbidden(
                        `Cannot grant "${role.key}": it carries "${key}", which you do not hold`,
                        AUTHZ_ERROR_CODES.ESCALATION_BLOCKED,
                    );
                }
                continue;
            }

            const escapesTenant =
                parsed.scope === PermissionScope.ANY &&
                !READ_ONLY_ACTIONS.includes(parsed.action as never);

            if (escapesTenant) {
                const holdsItPlatformWide = applicableGrants(actor, {
                    resource: parsed.resource,
                    action: parsed.action,
                    organizationId: null,
                }).some((grant) => grant.scope === PermissionScope.ANY);

                if (!holdsItPlatformWide) {
                    throw AppError.forbidden(
                        `Cannot grant "${role.key}": it carries platform-wide "${key}"`,
                        AUTHZ_ERROR_CODES.ESCALATION_BLOCKED,
                    );
                }
            }
        }
    }
}

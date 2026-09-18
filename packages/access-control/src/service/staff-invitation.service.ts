import { RoleScopeType } from '@hitbox/database';
import type { StaffInvitation } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    ACCESS_CONTROL_ERROR_CODES,
    ACCESS_CONTROL_EVENTS,
} from '../constants/access-control.constant';
import { assertCanGrantRole } from '../domain/grantable-roles';
import type { IIdentityInvitations } from '../domain/interfaces/identity-invitations.interface';
import type { InviteStaffDto, ListInvitationsQuery } from '../dto/access-control.dto';
import type { StaffInvitationRepository, InvitationWithRole } from '../repository/staff-invitation.repository';
import type { RoleRepository } from '../repository/role.repository';
import type { RoleAssignmentService } from './role-assignment.service';

/** What the caller needs to look up an existing account by email. */
export interface IUserDirectory {
    /** Null when nobody holds this address. Archived users count as absent. */
    findActiveByEmail(email: string): Promise<{ id: string } | null>;
}

export interface StaffInvitationServiceDeps {
    invitations: StaffInvitationRepository;
    roles: RoleRepository;
    assignments: RoleAssignmentService;
    identity: IIdentityInvitations;
    users: IUserDirectory;
    eventBus: IEventBus;
    logger: Logger;
    /** How long an invitation stays claimable. */
    ttlHours: number;
}

export type InviteOutcome = 'ROLE_ASSIGNED' | 'INVITATION_SENT';

export interface InviteResult {
    outcome: InviteOutcome;
    invitation: InvitationResponse;
    /** Set only when the outcome is ROLE_ASSIGNED. */
    assignmentId: string | null;
}

export interface InvitationResponse {
    id: string;
    email: string;
    roleId: string;
    roleName: string;
    roleDisplayName: string;
    scopeType: RoleScopeType;
    organizationId: string | null;
    status: string;
    invitedById: string;
    invitedAt: Date;
    expiresAt: Date;
    acceptedAt: Date | null;
    acceptedUserId: string | null;
    assignmentId: string | null;
    revokedAt: Date | null;
    revokeReason: string | null;
    providerError: string | null;
}

/**
 * Provisioning a member of staff: invite an email address to hold a role.
 *
 * ## The gap this closes
 *
 * A `User` row exists only once Clerk fires `user.created`, which happens when
 * somebody signs up through the consumer app. So before this, making a
 * colleague an administrator meant asking them to register as a *buyer* first,
 * then finding them on the Team screen and granting a role. A system admin
 * could not provision anyone from the dashboard at all.
 *
 * ## Two paths, and why the branch is not an edge case
 *
 * **The address already has a HitBox account** — very common, because staff buy
 * things too, and because Clerk refuses to invite an address it already knows.
 * Then there is nothing to invite: the role is granted immediately and an
 * ACCEPTED invitation row is written anyway, so the trail reads the same
 * whichever path was taken.
 *
 * **The address is unknown** — a PENDING row is written, Clerk emails a
 * sign-up link, the row moves to SENT, and the role is granted later, when the
 * person accepts and `users.account.provisioned` tells us the row exists.
 *
 * ## What is checked before either path
 *
 * The route guard proves the caller holds `employee-role-mgmt:assign` at a
 * scope reaching the target organization. This service then adds the control
 * the guard cannot express: **you cannot grant a role carrying permissions you
 * do not hold yourself** (`assertCanGrantRole`). Without it, the weakest holder
 * of that capability could mint an account more powerful than their own and
 * sign in as it.
 */
export class StaffInvitationService {
    constructor(private readonly deps: StaffInvitationServiceDeps) { }

    async invite(input: {
        dto: InviteStaffDto;
        invitedById: string;
        /** The inviter's own effective permission keys, from the guard. */
        inviterPermissions: string[];
    }): Promise<InviteResult> {
        const email = input.dto.email.trim().toLowerCase();

        const role = await this.deps.roles.findById(input.dto.roleId);
        if (!role) {
            throw AppError.notFound('Role not found', ACCESS_CONTROL_ERROR_CODES.ROLE_NOT_FOUND);
        }
        if (!role.isActive) {
            throw AppError.badRequest(
                `${role.name} is deactivated and cannot be granted`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_NOT_FOUND,
            );
        }

        // No privilege escalation. Checked here rather than in the guard
        // because the guard reasons about one capability and this reasons about
        // the whole permission set the role confers.
        assertCanGrantRole({
            granterPermissions: input.inviterPermissions,
            roleName: role.name,
            rolePermissions: role.rolePermissions.map((rp) => rp.permission.key),
        });

        const scopeType = input.dto.scopeType ?? defaultScopeFor(role.entityGroup);
        const scopeId =
            scopeType === RoleScopeType.ORGANIZATION ? (input.dto.organizationId ?? null) : null;
        if (scopeType === RoleScopeType.ORGANIZATION && !scopeId) {
            throw AppError.badRequest(
                `${role.name} is organization-scoped; an organizationId is required`,
                ACCESS_CONTROL_ERROR_CODES.MISSING_ORG_SCOPE,
            );
        }

        const duplicate = await this.deps.invitations.findLiveFor({ email, roleId: role.id, scopeId });
        if (duplicate) {
            throw AppError.conflict(
                `${email} already has an open invitation to ${role.name}. Revoke it or resend it.`,
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS,
                { invitationId: duplicate.id },
            );
        }

        const expiresAt = new Date(Date.now() + this.deps.ttlHours * 3_600_000);
        const invitation = await this.deps.invitations.createPending({
            email,
            roleId: role.id,
            scopeType,
            scopeId,
            invitedById: input.invitedById,
            expiresAt,
        });

        // ── Path 1: they already have an account ────────────────────────────
        const existing = await this.deps.users.findActiveByEmail(email);
        if (existing) {
            const assignment = await this.deps.assignments.assign({
                userId: existing.id,
                dto: {
                    roleId: role.id,
                    scopeType,
                    ...(scopeId ? { organizationId: scopeId } : {}),
                },
                grantedById: input.invitedById,
            });
            const accepted = await this.deps.invitations.markAccepted({
                id: invitation.id,
                acceptedUserId: existing.id,
                assignmentId: assignment.id,
            });

            this.deps.logger.info(
                { invitationId: invitation.id, userId: existing.id, role: role.name, email },
                'staff invitation resolved against an existing account — role granted immediately',
            );
            await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_ASSIGNED, {
                assignmentId: assignment.id,
                userId: existing.id,
                roleId: role.id,
                roleName: role.name,
                domain: role.domain,
                scopeType,
                organizationId: scopeId,
                grantedById: input.invitedById,
            });
            return {
                outcome: 'ROLE_ASSIGNED',
                invitation: present(accepted),
                assignmentId: assignment.id,
            };
        }

        // ── Path 2: invite them ─────────────────────────────────────────────
        try {
            const sent = await this.deps.identity.sendInvitation({ email });
            const updated = await this.deps.invitations.markSent(
                invitation.id,
                sent.providerInvitationId,
            );
            this.deps.logger.info(
                { invitationId: invitation.id, role: role.name, email, expiresAt },
                'staff invitation sent',
            );
            return { outcome: 'INVITATION_SENT', invitation: present(updated), assignmentId: null };
        } catch (error) {
            // The row stays, marked FAILED with the reason: an invitation that
            // could not be sent is something an administrator has to see and
            // act on, not something to roll back into silence.
            const message = error instanceof Error ? error.message : String(error);
            const failed = await this.deps.invitations.markFailed(invitation.id, message);
            this.deps.logger.error(
                { err: error, invitationId: invitation.id, email },
                'identity provider refused the staff invitation',
            );
            throw AppError.badRequest(
                `The invitation to ${email} could not be sent: ${message}`,
                ACCESS_CONTROL_ERROR_CODES.FORBIDDEN,
                { invitationId: failed.id },
            );
        }
    }

    /**
     * Claims any invitation waiting for this address.
     *
     * Driven by `users.account.provisioned`, which the users module publishes
     * **after** it has written the row — not by the auth event, which would
     * race that insert and fail the assignment's foreign key intermittently.
     *
     * Idempotent: a replayed event finds nothing claimable and does nothing.
     */
    async claimFor(input: { userId: string; email: string }): Promise<number> {
        const candidates = await this.deps.invitations.findClaimable(input.email);
        if (candidates.length === 0) return 0;

        const now = new Date();
        let claimed = 0;

        for (const invitation of candidates) {
            if (invitation.expiresAt <= now) {
                // Swept lazily as well as by the job, so a late acceptance is
                // never silently honoured.
                await this.deps.invitations.expire(now);
                this.deps.logger.warn(
                    { invitationId: invitation.id, email: input.email },
                    'staff invitation had expired before it was claimed',
                );
                continue;
            }

            try {
                const assignment = await this.deps.assignments.assign({
                    userId: input.userId,
                    dto: {
                        roleId: invitation.roleId,
                        scopeType: invitation.scopeType,
                        ...(invitation.scopeId ? { organizationId: invitation.scopeId } : {}),
                    },
                    grantedById: invitation.invitedById,
                });
                await this.deps.invitations.markAccepted({
                    id: invitation.id,
                    acceptedUserId: input.userId,
                    assignmentId: assignment.id,
                });
                claimed += 1;
                this.deps.logger.info(
                    {
                        invitationId: invitation.id,
                        userId: input.userId,
                        role: invitation.role.name,
                        assignmentId: assignment.id,
                    },
                    'staff invitation claimed — role granted',
                );
            } catch (error) {
                this.deps.logger.error(
                    { err: error, invitationId: invitation.id, userId: input.userId },
                    'could not grant the role for a claimed staff invitation — replay required',
                );
            }
        }
        return claimed;
    }

    async list(input: {
        query: ListInvitationsQuery;
        organizationIds: string[] | null;
    }): Promise<{ page: number; limit: number; total: number; items: InvitationResponse[] }> {
        const { page, limit } = input.query;
        const { total, items } = await this.deps.invitations.list({
            ...(input.query.status ? { status: input.query.status } : {}),
            ...(input.query.email ? { email: input.query.email } : {}),
            ...(input.query.roleId ? { roleId: input.query.roleId } : {}),
            organizationIds: input.organizationIds,
            skip: (page - 1) * limit,
            take: limit,
        });
        return { page, limit, total, items: items.map(present) };
    }

    /**
     * Withdraws an unclaimed invitation.
     *
     * The local row is revoked first and the provider second: this database
     * decides whether a role is granted, so a provider call that fails must not
     * leave a claimable invitation behind. The reverse order could.
     */
    async revoke(input: {
        id: string;
        revokedById: string;
        reason: string;
    }): Promise<InvitationResponse> {
        const invitation = await this.deps.invitations.findById(input.id);
        if (!invitation) {
            throw AppError.notFound(
                'Invitation not found',
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_NOT_FOUND,
            );
        }
        if (invitation.status === 'ACCEPTED') {
            throw AppError.conflict(
                'That invitation has already been accepted. Revoke the role assignment instead.',
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS,
                { assignmentId: invitation.assignmentId },
            );
        }
        if (invitation.status === 'REVOKED') {
            throw AppError.conflict(
                'That invitation is already revoked.',
                ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS,
            );
        }

        const revoked = await this.deps.invitations.markRevoked({
            id: input.id,
            revokedById: input.revokedById,
            reason: input.reason,
        });

        if (invitation.providerInvitationId) {
            try {
                await this.deps.identity.revokeInvitation(invitation.providerInvitationId);
            } catch (error) {
                // Logged, not thrown. The link may still work at the provider,
                // but accepting it now creates an ordinary account with no role
                // — which is the safe failure.
                this.deps.logger.warn(
                    { err: error, invitationId: input.id },
                    'local invitation revoked; the identity provider still has it',
                );
            }
        }

        this.deps.logger.info(
            { invitationId: input.id, revokedById: input.revokedById, reason: input.reason },
            'staff invitation revoked',
        );
        return present(revoked);
    }

    /** Sweeps expired invitations. Call from the scheduler; idempotent. */
    async expireStale(): Promise<number> {
        const count = await this.deps.invitations.expire(new Date());
        if (count > 0) {
            this.deps.logger.info({ count }, 'staff invitations expired');
        }
        return count;
    }
}

/** Mirrors `defaultScopeFor` in the assignment service — same rule, one place. */
function defaultScopeFor(entityGroup: string): RoleScopeType {
    switch (entityGroup) {
        case 'brand_artist':
            return RoleScopeType.ORGANIZATION;
        case 'end_user':
            return RoleScopeType.OWN;
        default:
            return RoleScopeType.GLOBAL;
    }
}

function present(invitation: InvitationWithRole): InvitationResponse {
    return {
        id: invitation.id,
        email: invitation.email,
        roleId: invitation.roleId,
        roleName: invitation.role.name,
        roleDisplayName: invitation.role.displayName,
        scopeType: invitation.scopeType,
        organizationId: invitation.scopeId,
        status: invitation.status,
        invitedById: invitation.invitedById,
        invitedAt: invitation.invitedAt,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        acceptedUserId: invitation.acceptedUserId,
        assignmentId: invitation.assignmentId,
        revokedAt: invitation.revokedAt,
        revokeReason: invitation.revokeReason,
        providerError: invitation.providerError,
    };
}

export type { StaffInvitation };

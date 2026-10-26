import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { VendorMemberStatus } from '@hitbox/database';
import {
    SUPPLY_AUDIT_EVENTS,
    SUPPLY_ERROR_CODES,
    SUPPLY_EVENTS,
} from '../constants/supply.constant';
import { requireWrite } from '../domain/supply-access';
import type { ISupplyAudit } from '../domain/interfaces/supply-audit.interface';
import type {
    IVendorInvitations,
    StaffInvitationAcceptedEvent,
} from '../domain/interfaces/vendor-invitations.interface';
import type {
    AssignVendorDropDto,
    UpdateVendorAllotmentDto,
    PatchVendorAllotmentDto,
    InviteVendorMemberDto,
    InviteVendorMemberResult,
    ListVendorMembersQuery,
    RevokeVendorMemberDto,
    VendorDropAssignmentResponse,
    VendorMemberResponse,
} from '../dto/supply.dto';
import type { SupplyRepository, VendorRow } from '../repository/supply.repository';
import type {
    VendorDropAssignmentRow,
    VendorMemberRow,
    VendorPortalRepository,
} from '../repository/vendor-portal.repository';
import type { SupplyMutationContext } from './supply.service';
import {
    assertNotBelowAccepted,
    mergeAllotment,
    presentAssignment,
    resolveAllotment,
} from './allotment';

interface VendorAdminServiceDeps {
    supply: SupplyRepository;
    portal: VendorPortalRepository;
    /** Absent when no identity provider is wired — invitations then answer 503. */
    invitations?: IVendorInvitations | undefined;
    eventBus: IEventBus;
    audit: ISupplyAudit;
    logger: Logger;
}

/**
 * HitBox staff administering the vendor portal: who may sign in for a vendor,
 * and which drops that vendor may supply.
 *
 * ## The invitation is the ordinary staff invitation
 *
 * Inviting a vendor member sends a StaffInvitation for the VENDOR role through
 * the `IVendorInvitations` port, so the person sets their password through the
 * same identity-provider sign-up every other invited account uses. This module
 * adds only the half access-control cannot know about: the `VendorMember` row
 * that says *which* vendor the account acts for.
 *
 *   invite      → StaffInvitation (VENDOR role) + VendorMember INVITED
 *   sign-up     → role granted by access-control → `staff.invitation-accepted`
 *               → VendorMember ACTIVE, userId linked   (onInvitationAccepted)
 *
 * An address that already has an account skips the email: the role is granted
 * on the spot and the member is written ACTIVE.
 *
 * Every write here is `globalOnly` at the route — the same custody rule as the
 * rest of supply administration.
 */
export class VendorAdminService {
    constructor(private readonly deps: VendorAdminServiceDeps) { }

    // ── Members ─────────────────────────────────────────────────────────────

    async listMembers(
        context: SupplyMutationContext,
        vendorId: string,
        query: ListVendorMembersQuery,
    ): Promise<{ data: VendorMemberResponse[] }> {
        requireWrite(context.access);
        await this.loadVendor(vendorId);
        const rows = await this.deps.portal.listMembers(vendorId, query.status);
        return { data: rows.map(toMemberResponse) };
    }

    async inviteMember(
        context: SupplyMutationContext,
        inviterPermissions: string[],
        vendorId: string,
        dto: InviteVendorMemberDto,
    ): Promise<InviteVendorMemberResult> {
        requireWrite(context.access);

        const invitations = this.deps.invitations;
        if (!invitations) {
            throw new AppError(
                'Vendor invitations are not configured on this deployment.',
                503,
                SUPPLY_ERROR_CODES.VENDOR_INVITATIONS_UNAVAILABLE,
            );
        }

        const vendor = await this.loadVendor(vendorId);
        assertOpen(vendor);

        const email = (dto.email ?? vendor.contactEmail ?? '').trim().toLowerCase();
        if (!email) {
            throw AppError.badRequest(
                'No email given and the vendor has no contactEmail on file.',
                SUPPLY_ERROR_CODES.VENDOR_EMAIL_REQUIRED,
            );
        }

        // Checked before anything is sent: an invitation, once out, grants a
        // role whether or not this module then writes its row.
        const duplicate = await this.deps.portal.findLiveByEmail(email);
        if (duplicate && duplicate.vendorId !== vendorId) {
            throw AppError.conflict(
                `${email} already signs in for another vendor. Revoke that membership first.`,
                SUPPLY_ERROR_CODES.VENDOR_MEMBER_OTHER_VENDOR,
                { memberId: duplicate.id, vendorId: duplicate.vendorId },
            );
        }
        if (duplicate) {
            throw AppError.conflict(
                `${email} is already ${duplicate.status === VendorMemberStatus.ACTIVE ? 'a member' : 'invited'} ` +
                'for this vendor. Revoke that membership first to invite again.',
                SUPPLY_ERROR_CODES.VENDOR_MEMBER_EXISTS,
                { memberId: duplicate.id },
            );
        }

        const sent = await invitations.invite({
            email,
            invitedById: context.access.userId,
            inviterPermissions,
        });

        // The address already had an account. One account acts for one vendor,
        // so an account that is already somebody else's member is refused —
        // after the fact, because only the invitation reveals the account. The
        // VENDOR role it was just granted reaches nothing without a membership.
        if (sent.userId) {
            const existing = await this.deps.portal.findByUserId(sent.userId);
            if (existing) {
                if (existing.vendorId === vendorId) {
                    return {
                        outcome: sent.outcome,
                        member: toMemberResponse(existing),
                        invitationExpiresAt: sent.expiresAt.toISOString(),
                    };
                }
                throw AppError.conflict(
                    `${email} already signs in for another vendor. Revoke that membership first.`,
                    SUPPLY_ERROR_CODES.VENDOR_MEMBER_OTHER_VENDOR,
                    { memberId: existing.id, vendorId: existing.vendorId },
                );
            }
        }

        const member = await this.deps.portal.createMember({
            vendorId,
            email,
            invitationId: sent.invitationId,
            invitedById: context.access.userId,
            userId: sent.userId,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_MEMBER_INVITE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'VendorMember',
            resourceId: member.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            // The address is the invitee's PII; the member id leads to it for
            // anyone entitled to read it.
            after: { vendorId, status: member.status },
            metadata: { invitationId: sent.invitationId, outcome: sent.outcome },
        });
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_MEMBER_INVITED, {
            memberId: member.id,
            vendorId,
            invitationId: sent.invitationId,
            outcome: sent.outcome,
        });
        this.deps.logger.info(
            { vendorId, memberId: member.id, invitationId: sent.invitationId, outcome: sent.outcome },
            'vendor member invited',
        );

        return {
            outcome: sent.outcome,
            member: toMemberResponse(member),
            invitationExpiresAt: sent.expiresAt.toISOString(),
        };
    }

    async revokeMember(
        context: SupplyMutationContext,
        vendorId: string,
        memberId: string,
        dto: RevokeVendorMemberDto,
    ): Promise<VendorMemberResponse> {
        requireWrite(context.access);

        const member = await this.deps.portal.findMember(vendorId, memberId);
        if (!member) {
            throw AppError.notFound(
                'Vendor member not found',
                SUPPLY_ERROR_CODES.VENDOR_MEMBER_NOT_FOUND,
            );
        }
        if (member.status === VendorMemberStatus.REVOKED) {
            throw AppError.conflict(
                'That membership is already revoked.',
                SUPPLY_ERROR_CODES.VENDOR_MEMBER_EXISTS,
            );
        }

        const before = {
            status: member.status,
            userId: member.userId,
            invitationId: member.invitationId,
        };

        // Local first: portal access is decided by this row, so it must close
        // even if the provider call below fails.
        const revoked = await this.deps.portal.revoke({
            id: member.id,
            revokedById: context.access.userId,
            reason: dto.reason,
        });

        if (before.status === VendorMemberStatus.INVITED && before.invitationId) {
            try {
                await this.deps.invitations?.revoke({
                    invitationId: before.invitationId,
                    revokedById: context.access.userId,
                    reason: dto.reason,
                });
            } catch (error) {
                // An accepted-later invitation now grants a role with no
                // membership behind it, which reaches nothing — the safe failure.
                this.deps.logger.warn(
                    { err: error, memberId, invitationId: before.invitationId },
                    'vendor member revoked; the staff invitation could not be withdrawn',
                );
            }
        }

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_MEMBER_REVOKE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'VendorMember',
            resourceId: member.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { status: before.status, userId: before.userId },
            after: { status: revoked.status },
            metadata: { vendorId, reason: dto.reason },
        });
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_MEMBER_REVOKED, {
            memberId,
            vendorId,
            userId: before.userId,
        });

        return toMemberResponse(revoked);
    }

    /**
     * `access-control.staff.invitation-accepted` → link the account.
     *
     * Idempotent, and silent for every invitation that is not a vendor's: the
     * lookup by invitation id is what decides whether this is ours.
     */
    async onInvitationAccepted(event: StaffInvitationAcceptedEvent): Promise<void> {
        const member = await this.deps.portal.findByInvitationId(event.invitationId);
        if (!member) return;
        if (member.status !== VendorMemberStatus.INVITED) return;

        const other = await this.deps.portal.findByUserId(event.userId);
        if (other && other.id !== member.id) {
            this.deps.logger.warn(
                { memberId: member.id, userId: event.userId, otherMemberId: other.id },
                'accepted vendor invitation belongs to an account that already acts for another vendor — left INVITED',
            );
            return;
        }

        const active = await this.deps.portal.activate(member.id, event.userId);
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_MEMBER_ACTIVATED, {
            memberId: active.id,
            vendorId: active.vendorId,
            userId: event.userId,
        });
        this.deps.logger.info(
            { memberId: active.id, vendorId: active.vendorId, userId: event.userId },
            'vendor member accepted the invitation — portal access active',
        );
    }

    // ── Drop assignments ────────────────────────────────────────────────────

    async listDrops(
        context: SupplyMutationContext,
        vendorId: string,
    ): Promise<{ data: VendorDropAssignmentResponse[] }> {
        requireWrite(context.access);
        await this.loadVendor(vendorId);
        const rows = await this.deps.portal.listAssignments(vendorId);
        return {
            data: await Promise.all(rows.map((row) => presentAssignment(this.deps.portal, row))),
        };
    }

    /**
     * Assigns a drop with its allotment: per variant for a drop with variants
     * ("Red/S 100, Red/M 100, Red/L 100"), an optional quantity otherwise.
     */
    async assignDrop(
        context: SupplyMutationContext,
        vendorId: string,
        dto: AssignVendorDropDto,
    ): Promise<VendorDropAssignmentResponse> {
        requireWrite(context.access);
        assertOpen(await this.loadVendor(vendorId));

        const organizationId = await this.deps.supply.findDropOrganization(dto.dropId);
        if (organizationId === undefined) {
            throw AppError.notFound('Drop not found', SUPPLY_ERROR_CODES.NOT_FOUND);
        }
        if (await this.deps.portal.findAssignment(vendorId, dto.dropId)) {
            throw AppError.conflict(
                'This vendor is already assigned to that drop. Change its allotment instead.',
                SUPPLY_ERROR_CODES.DROP_ALREADY_ASSIGNED,
            );
        }
        const allotment = await resolveAllotment(this.deps.supply, dto.dropId, dto);

        const row = await this.deps.portal.createAssignment({
            vendorId,
            dropId: dto.dropId,
            assignedById: context.access.userId,
            ...allotment,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_DROP_ASSIGN,
            actorId: context.access.userId,
            organizationId,
            resourceType: 'VendorDropAssignment',
            resourceId: row.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            after: { vendorId, dropId: dto.dropId, ...allotment },
        });
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_DROP_ASSIGNED, {
            vendorId,
            dropId: dto.dropId,
        });

        return presentAssignment(this.deps.portal, row);
    }

    /**
     * Replaces the allotment. Variants left out are removed; nothing may go
     * below what HitBox has already accepted from this vendor.
     */
    async updateAllotment(
        context: SupplyMutationContext,
        vendorId: string,
        dropId: string,
        dto: UpdateVendorAllotmentDto,
    ): Promise<VendorDropAssignmentResponse> {
        requireWrite(context.access);
        const existing = await this.loadAssignment(vendorId, dropId);
        return this.applyAllotment(context, existing, dto);
    }

    /**
     * Sets only the variants sent (or the drop-level quantity) and keeps the
     * rest — the "increase the total supply" route used to cover a vendor's
     * over-allotment consignment before accepting it.
     */
    async patchAllotment(
        context: SupplyMutationContext,
        vendorId: string,
        dropId: string,
        dto: PatchVendorAllotmentDto,
    ): Promise<VendorDropAssignmentResponse> {
        requireWrite(context.access);
        const existing = await this.loadAssignment(vendorId, dropId);
        return this.applyAllotment(context, existing, mergeAllotment(existing, dto));
    }

    private async loadAssignment(vendorId: string, dropId: string) {
        const existing = await this.deps.portal.findAssignment(vendorId, dropId);
        if (!existing) {
            throw AppError.notFound(
                'This vendor is not assigned to that drop.',
                SUPPLY_ERROR_CODES.DROP_NOT_ASSIGNED,
            );
        }
        return existing;
    }

    private async applyAllotment(
        context: SupplyMutationContext,
        existing: VendorDropAssignmentRow,
        dto: UpdateVendorAllotmentDto,
    ): Promise<VendorDropAssignmentResponse> {
        const { vendorId, dropId } = existing;
        const next = await resolveAllotment(this.deps.supply, dropId, dto);
        await assertNotBelowAccepted(this.deps.portal, existing, next);

        const row = await this.deps.portal.replaceAllotment({
            assignmentId: existing.id,
            ...next,
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_DROP_ALLOTMENT,
            actorId: context.access.userId,
            organizationId: (await this.deps.supply.findDropOrganization(dropId)) ?? null,
            resourceType: 'VendorDropAssignment',
            resourceId: existing.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: {
                quantity: existing.quantity,
                variants: existing.allotments.map((a) => ({
                    variantId: a.variantId,
                    quantity: a.quantity,
                })),
            },
            after: { ...next },
        });
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_ALLOTMENT_UPDATED, {
            vendorId,
            dropId,
        });

        return presentAssignment(this.deps.portal, row);
    }

    async unassignDrop(
        context: SupplyMutationContext,
        vendorId: string,
        dropId: string,
    ): Promise<void> {
        requireWrite(context.access);

        const row = await this.deps.portal.findAssignment(vendorId, dropId);
        if (!row) {
            throw AppError.notFound(
                'This vendor is not assigned to that drop.',
                SUPPLY_ERROR_CODES.DROP_NOT_ASSIGNED,
            );
        }
        const organizationId = await this.deps.supply.findDropOrganization(dropId);
        await this.deps.portal.deleteAssignment(row.id);

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.VENDOR_DROP_UNASSIGN,
            actorId: context.access.userId,
            organizationId: organizationId ?? null,
            resourceType: 'VendorDropAssignment',
            resourceId: row.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { vendorId, dropId },
        });
        await this.deps.eventBus.publish(SUPPLY_EVENTS.VENDOR_DROP_UNASSIGNED, {
            vendorId,
            dropId,
        });
    }

    private async loadVendor(vendorId: string): Promise<VendorRow> {
        const vendor = await this.deps.supply.findVendorById(vendorId);
        if (!vendor) {
            throw AppError.notFound('Vendor not found', SUPPLY_ERROR_CODES.VENDOR_NOT_FOUND);
        }
        return vendor;
    }
}

/** An archived or deactivated vendor takes no new members and no new drops. */
function assertOpen(vendor: VendorRow): void {
    if (vendor.archivedAt) {
        throw AppError.conflict(
            'This vendor is archived.',
            SUPPLY_ERROR_CODES.VENDOR_ARCHIVED,
        );
    }
    if (!vendor.isActive) {
        throw AppError.conflict(
            'This vendor is inactive. Reactivate it first.',
            SUPPLY_ERROR_CODES.VENDOR_INACTIVE,
        );
    }
}

export function toMemberResponse(row: VendorMemberRow): VendorMemberResponse {
    return {
        id: row.id,
        vendorId: row.vendorId,
        email: row.email,
        status: row.status,
        userId: row.userId,
        invitationId: row.invitationId,
        invitedById: row.invitedById,
        invitedAt: row.invitedAt.toISOString(),
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        revokeReason: row.revokeReason,
    };
}

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StaffInvitationService } from '../src/service/staff-invitation.service';

/**
 * The provisioning flow, against fakes.
 *
 * What is being pinned here is the branch that is easy to get wrong: staff
 * frequently already have a HitBox account (they buy things too), and Clerk
 * refuses to invite an address it already knows. So "invite" has to mean two
 * different things depending on a fact the operator does not know when they
 * click the button.
 */

const ROLE = {
    id: 'role-1',
    name: 'HITBOX_ORDER_MANAGER',
    displayName: 'HitBox Order Manager',
    entityGroup: 'hitbox_seller_org',
    domain: 'BUSINESS',
    isActive: true,
    rolePermissions: [{ permission: { key: 'order:manage:global' } }],
};

/** Everything the inviter needs to hold to grant ROLE. */
const FULL_PERMISSIONS = ['order:manage:global', 'employee-role-mgmt:assign:global'];

function build(overrides: Partial<Record<string, unknown>> = {}) {
    const rows = new Map<string, Record<string, unknown>>();
    let seq = 0;

    const invitations = {
        createPending: jest.fn(async (input: Record<string, unknown>) => {
            seq += 1;
            const row = {
                id: `inv-${seq}`,
                ...input,
                status: 'PENDING',
                role: ROLE,
                providerInvitationId: null,
                acceptedAt: null,
                acceptedUserId: null,
                assignmentId: null,
                revokedAt: null,
                revokeReason: null,
                providerError: null,
            };
            rows.set(row.id as string, row);
            return row;
        }),
        markSent: jest.fn(async (id: string, providerInvitationId: string) => {
            const row = { ...rows.get(id), status: 'SENT', providerInvitationId, role: ROLE };
            rows.set(id, row);
            return row;
        }),
        markFailed: jest.fn(async (id: string, providerError: string) => ({
            ...rows.get(id),
            status: 'FAILED',
            providerError,
            role: ROLE,
        })),
        markAccepted: jest.fn(async (input: Record<string, unknown>) => ({
            ...rows.get(input.id as string),
            status: 'ACCEPTED',
            acceptedUserId: input.acceptedUserId,
            assignmentId: input.assignmentId,
            role: ROLE,
        })),
        markRevoked: jest.fn(async (input: Record<string, unknown>) => ({
            ...rows.get(input.id as string),
            status: 'REVOKED',
            revokeReason: input.reason,
            role: ROLE,
        })),
        findLiveFor: jest.fn(async () => null),
        findClaimable: jest.fn(async () => []),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        expire: jest.fn(async () => 0),
        list: jest.fn(async () => ({ total: 0, items: [] })),
    };

    const deps = {
        invitations,
        roles: { findById: jest.fn(async () => ROLE) },
        assignments: { assign: jest.fn(async () => ({ id: 'assignment-1' })) },
        identity: {
            sendInvitation: jest.fn(async () => ({ providerInvitationId: 'clerk-inv-1' })),
            revokeInvitation: jest.fn(async () => undefined),
        },
        users: { findActiveByEmail: jest.fn(async () => null) },
        eventBus: { publish: jest.fn(async () => undefined), subscribe: jest.fn() },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        ttlHours: 72,
        ...overrides,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new StaffInvitationService(deps as any), deps };
}

const DTO = { email: 'New.Admin@HitBox.com', roleId: 'role-1' };

describe('inviting an address with no account', () => {
    it('sends an invitation and records the provider id', async () => {
        const { service, deps } = build();
        const result = await service.invite({
            dto: DTO,
            invitedById: 'admin-1',
            inviterPermissions: FULL_PERMISSIONS,
        });

        expect(result.outcome).toBe('INVITATION_SENT');
        expect(result.assignmentId).toBeNull();
        expect(deps.identity.sendInvitation).toHaveBeenCalledWith({
            email: 'new.admin@hitbox.com',
        });
        expect(deps.invitations.markSent).toHaveBeenCalledWith('inv-1', 'clerk-inv-1');
        // No role yet — there is nobody to give it to.
        expect(deps.assignments.assign).not.toHaveBeenCalled();
    });

    it('lower-cases the address before anything touches it', async () => {
        const { service, deps } = build();
        await service.invite({
            dto: DTO,
            invitedById: 'admin-1',
            inviterPermissions: FULL_PERMISSIONS,
        });
        // The address is matched against what the provider reports back on
        // acceptance; comparison must not depend on how the inviter typed it.
        const created = deps.invitations.createPending.mock.calls[0]?.[0] as { email: string };
        expect(created.email).toBe('new.admin@hitbox.com');
    });

    it('writes the row BEFORE calling the provider', async () => {
        const { service, deps } = build();
        await service.invite({
            dto: DTO,
            invitedById: 'admin-1',
            inviterPermissions: FULL_PERMISSIONS,
        });
        const createdAt = deps.invitations.createPending.mock.invocationCallOrder[0] as number;
        const sentAt = deps.identity.sendInvitation.mock.invocationCallOrder[0] as number;
        // Otherwise a crash between the two emails someone a sign-up link with
        // no role waiting for them, and no record that it happened.
        expect(createdAt).toBeLessThan(sentAt);
    });

    it('keeps the row as FAILED when the provider refuses', async () => {
        const { service, deps } = build({
            identity: {
                sendInvitation: jest.fn(async () => {
                    throw new Error('that email address is taken');
                }),
                revokeInvitation: jest.fn(),
            },
        });

        await expect(
            service.invite({
                dto: DTO,
                invitedById: 'admin-1',
                inviterPermissions: FULL_PERMISSIONS,
            }),
        ).rejects.toThrow(/could not be sent: that email address is taken/);

        // Not rolled back into silence: an invitation that could not be sent is
        // something an administrator has to see.
        expect(deps.invitations.markFailed).toHaveBeenCalled();
    });
});

describe('inviting an address that already has an account', () => {
    it('grants the role immediately instead of emailing anyone', async () => {
        const { service, deps } = build({
            users: { findActiveByEmail: jest.fn(async () => ({ id: 'user-9' })) },
        });

        const result = await service.invite({
            dto: DTO,
            invitedById: 'admin-1',
            inviterPermissions: FULL_PERMISSIONS,
        });

        expect(result.outcome).toBe('ROLE_ASSIGNED');
        expect(result.assignmentId).toBe('assignment-1');
        expect(deps.identity.sendInvitation).not.toHaveBeenCalled();
        expect(deps.assignments.assign).toHaveBeenCalled();
        // An ACCEPTED row is still written, so the audit trail reads the same
        // whichever path was taken.
        expect(deps.invitations.markAccepted).toHaveBeenCalled();
    });
});

describe('the no-escalation check', () => {
    it('refuses an inviter who does not hold what the role confers', async () => {
        const { service, deps } = build();
        await expect(
            service.invite({
                dto: DTO,
                invitedById: 'brand-admin-1',
                inviterPermissions: ['drop:manage:organization'],
            }),
        ).rejects.toThrow(/cannot grant HITBOX_ORDER_MANAGER/);

        // Refused before anything is written or emailed.
        expect(deps.invitations.createPending).not.toHaveBeenCalled();
        expect(deps.identity.sendInvitation).not.toHaveBeenCalled();
    });
});

describe('duplicates', () => {
    it('refuses a second open invitation for the same grant', async () => {
        const { service } = build({
            invitations: {
                ...build().deps.invitations,
                findLiveFor: jest.fn(async () => ({ id: 'inv-existing', role: ROLE })),
            },
        });
        await expect(
            service.invite({
                dto: DTO,
                invitedById: 'admin-1',
                inviterPermissions: FULL_PERMISSIONS,
            }),
        ).rejects.toThrow(/already has an open invitation/);
    });
});

describe('claiming on account creation', () => {
    const invitation = {
        id: 'inv-1',
        roleId: 'role-1',
        scopeType: 'GLOBAL',
        scopeId: null,
        invitedById: 'admin-1',
        expiresAt: new Date(Date.now() + 3_600_000),
        role: ROLE,
    };

    it('grants the role and marks the invitation accepted', async () => {
        const { service, deps } = build();
        deps.invitations.findClaimable = jest.fn(async () => [invitation]) as never;

        const claimed = await service.claimFor({
            userId: 'user-42',
            email: 'new.admin@hitbox.com',
        });

        expect(claimed).toBe(1);
        expect(deps.assignments.assign).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-42', grantedById: 'admin-1' }),
        );
        expect(deps.invitations.markAccepted).toHaveBeenCalledWith(
            expect.objectContaining({ acceptedUserId: 'user-42', assignmentId: 'assignment-1' }),
        );
    });

    it('does nothing when there is nothing waiting — a replayed event is safe', async () => {
        const { service, deps } = build();
        expect(await service.claimFor({ userId: 'user-42', email: 'nobody@hitbox.com' })).toBe(0);
        expect(deps.assignments.assign).not.toHaveBeenCalled();
    });

    it('refuses to honour an invitation that expired before it was claimed', async () => {
        const { service, deps } = build();
        deps.invitations.findClaimable = jest.fn(async () => [
            { ...invitation, expiresAt: new Date(Date.now() - 1000) },
        ]) as never;

        expect(await service.claimFor({ userId: 'user-42', email: 'x@hitbox.com' })).toBe(0);
        expect(deps.assignments.assign).not.toHaveBeenCalled();
    });
});

describe('revoking', () => {
    let context: ReturnType<typeof build>;

    beforeEach(async () => {
        context = build();
        await context.service.invite({
            dto: DTO,
            invitedById: 'admin-1',
            inviterPermissions: FULL_PERMISSIONS,
        });
    });

    it('revokes locally first, then at the provider', async () => {
        const { service, deps } = context;
        await service.revoke({ id: 'inv-1', revokedById: 'admin-2', reason: 'sent in error' });

        const localAt = deps.invitations.markRevoked.mock.invocationCallOrder[0] as number;
        const providerAt = deps.identity.revokeInvitation.mock.invocationCallOrder[0] as number;
        // This database decides whether a role is granted, so a provider call
        // that fails must not leave a claimable invitation behind.
        expect(localAt).toBeLessThan(providerAt);
    });

    it('still revokes locally when the provider call fails', async () => {
        const { service, deps } = context;
        deps.identity.revokeInvitation = jest.fn(async () => {
            throw new Error('provider unreachable');
        }) as never;

        const result = await service.revoke({
            id: 'inv-1',
            revokedById: 'admin-2',
            reason: 'sent in error',
        });
        expect(result.status).toBe('REVOKED');
        expect(deps.logger.warn).toHaveBeenCalled();
    });
});

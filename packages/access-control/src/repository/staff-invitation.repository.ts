import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type {
    PrismaClient,
    Role,
    RoleScopeType,
    StaffInvitation,
    StaffInvitationStatus,
} from '@hitbox/database';

/**
 * The role is loaded with its permission keys, not just its name.
 *
 * Subscribers to the invitation events decide whether they care from the
 * **capabilities** the role confers rather than from its name — the artist
 * module provisions a profile for any role carrying
 * `brand-artist-record:*:own`, not for a role literally called ARTIST. That
 * only works if the keys travel with the event, and they can only travel if
 * they are selected here.
 */
export type InvitationWithRole = StaffInvitation & {
    role: Role & { rolePermissions: { permission: { key: string } }[] };
};

/** Loaded everywhere an invitation is read, so every read is event-ready. */
const roleInclude = {
    role: { include: { rolePermissions: { include: { permission: true } } } },
} as const;

/** States an invitation can still be claimed from. */
export const CLAIMABLE_STATUSES: StaffInvitationStatus[] = ['PENDING', 'SENT'];

/** The only place in this module that touches Prisma for invitations. */
export class StaffInvitationRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<InvitationWithRole | null> {
        return this.prisma.staffInvitation.findUnique({
            where: { id },
            include: roleInclude,
        });
    }

    /**
     * Invitations this address could still claim, newest first.
     *
     * Not filtered on `expiresAt` here: an expired-but-unswept row is caught in
     * the service, which is also where it gets marked EXPIRED. Doing it in one
     * place keeps "what counts as expired" from being two different answers.
     */
    findClaimable(email: string): Promise<InvitationWithRole[]> {
        return this.prisma.staffInvitation.findMany({
            where: { email: email.toLowerCase(), status: { in: CLAIMABLE_STATUSES } },
            include: roleInclude,
            orderBy: { invitedAt: 'desc' },
        });
    }

    /** A live invitation for exactly this grant — the duplicate guard. */
    findLiveFor(input: {
        email: string;
        roleId: string;
        scopeId: string | null;
    }): Promise<InvitationWithRole | null> {
        return this.prisma.staffInvitation.findFirst({
            where: {
                email: input.email.toLowerCase(),
                roleId: input.roleId,
                scopeId: input.scopeId,
                status: { in: CLAIMABLE_STATUSES },
            },
            include: roleInclude,
        });
    }

    async list(query: {
        status?: StaffInvitationStatus | undefined;
        email?: string | undefined;
        roleId?: string | undefined;
        /** Null = unrestricted; an array confines to these organizations. */
        organizationIds: string[] | null;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: InvitationWithRole[] }> {
        const where: Prisma.StaffInvitationWhereInput = {
            ...(query.status ? { status: query.status } : {}),
            ...(query.email ? { email: query.email.toLowerCase() } : {}),
            ...(query.roleId ? { roleId: query.roleId } : {}),
            // An org-scoped administrator sees invitations into their own
            // organizations. Global ones (scopeId null) are deliberately NOT
            // included: who is being made a platform administrator is not a
            // brand's business.
            ...(query.organizationIds === null
                ? {}
                : { scopeId: { in: query.organizationIds } }),
        };

        const [total, items] = await Promise.all([
            this.prisma.staffInvitation.count({ where }),
            this.prisma.staffInvitation.findMany({
                where,
                include: roleInclude,
                orderBy: { invitedAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /**
     * Writes the row in `PENDING`, **before** the provider is called.
     *
     * The order is the point: a crash between the write and the provider call
     * leaves a PENDING row an operator can see and retry, whereas writing
     * afterwards would let a successfully-emailed invitation vanish, and the
     * recipient would land on a sign-up page with no role waiting for them.
     */
    createPending(input: {
        email: string;
        roleId: string;
        scopeType: RoleScopeType;
        scopeId: string | null;
        invitedById: string;
        expiresAt: Date;
    }): Promise<InvitationWithRole> {
        const now = new Date();
        return this.prisma.staffInvitation.create({
            data: {
                id: randomUUID(),
                email: input.email.toLowerCase(),
                roleId: input.roleId,
                scopeType: input.scopeType,
                scopeId: input.scopeId,
                status: 'PENDING',
                invitedById: input.invitedById,
                invitedAt: now,
                expiresAt: input.expiresAt,
                createdAt: now,
                updatedAt: now,
            },
            include: roleInclude,
        });
    }

    markSent(id: string, providerInvitationId: string): Promise<InvitationWithRole> {
        return this.prisma.staffInvitation.update({
            where: { id },
            data: { status: 'SENT', providerInvitationId, updatedAt: new Date() },
            include: roleInclude,
        });
    }

    markFailed(id: string, providerError: string): Promise<InvitationWithRole> {
        return this.prisma.staffInvitation.update({
            where: { id },
            data: {
                status: 'FAILED',
                // Truncated: a provider error can carry a stack, and this column
                // is read by a human in a table cell.
                providerError: providerError.slice(0, 500),
                updatedAt: new Date(),
            },
            include: roleInclude,
        });
    }

    markAccepted(input: {
        id: string;
        acceptedUserId: string;
        assignmentId: string;
    }): Promise<InvitationWithRole> {
        const now = new Date();
        return this.prisma.staffInvitation.update({
            where: { id: input.id },
            data: {
                status: 'ACCEPTED',
                acceptedUserId: input.acceptedUserId,
                assignmentId: input.assignmentId,
                acceptedAt: now,
                updatedAt: now,
            },
            include: roleInclude,
        });
    }

    markRevoked(input: {
        id: string;
        revokedById: string;
        reason: string;
    }): Promise<InvitationWithRole> {
        const now = new Date();
        return this.prisma.staffInvitation.update({
            where: { id: input.id },
            data: {
                status: 'REVOKED',
                revokedById: input.revokedById,
                revokeReason: input.reason,
                revokedAt: now,
                updatedAt: now,
            },
            include: roleInclude,
        });
    }

    /** Sweeps claimable invitations past their expiry. Idempotent. */
    async expire(now: Date): Promise<number> {
        const result = await this.prisma.staffInvitation.updateMany({
            where: { status: { in: CLAIMABLE_STATUSES }, expiresAt: { lt: now } },
            data: { status: 'EXPIRED', updatedAt: now },
        });
        return result.count;
    }
}

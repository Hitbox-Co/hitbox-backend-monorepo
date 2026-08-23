import { MembershipStatus, OrganizationStatus } from '@hitbox/database';
import type { Organization, OrganizationMembership, PrismaClient } from '@hitbox/database';

export interface CreateOrganizationData {
    slug: string;
    name: string;
    clerkOrgId?: string | null;
}

export class OrganizationRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<Organization | null> {
        return this.prisma.organization.findFirst({ where: { id, deletedAt: null } });
    }

    findBySlug(slug: string): Promise<Organization | null> {
        return this.prisma.organization.findFirst({ where: { slug, deletedAt: null } });
    }

    create(data: CreateOrganizationData): Promise<Organization> {
        return this.prisma.organization.create({
            data: { slug: data.slug, name: data.name, clerkOrgId: data.clerkOrgId ?? null },
        });
    }

    update(id: string, data: { name?: string; status?: OrganizationStatus }): Promise<Organization> {
        return this.prisma.organization.update({ where: { id }, data });
    }

    /** Soft delete — audit rows and historical data must survive. */
    async softDelete(id: string): Promise<void> {
        await this.prisma.organization.update({
            where: { id },
            data: { deletedAt: new Date(), status: OrganizationStatus.SUSPENDED },
        });
    }

    listMembers(organizationId: string) {
        return this.prisma.organizationMembership.findMany({
            where: { organizationId },
            include: {
                user: {
                    select: { id: true, email: true, username: true, firstName: true, lastName: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
    }

    findMembership(
        userId: string,
        organizationId: string,
    ): Promise<OrganizationMembership | null> {
        return this.prisma.organizationMembership.findUnique({
            where: { userId_organizationId: { userId, organizationId } },
        });
    }

    /** Idempotent — re-inviting an existing member just refreshes their status. */
    upsertMembership(input: {
        userId: string;
        organizationId: string;
        status?: MembershipStatus;
    }): Promise<OrganizationMembership> {
        const status = input.status ?? MembershipStatus.ACTIVE;
        return this.prisma.organizationMembership.upsert({
            where: {
                userId_organizationId: {
                    userId: input.userId,
                    organizationId: input.organizationId,
                },
            },
            create: { userId: input.userId, organizationId: input.organizationId, status },
            update: { status },
        });
    }

    /**
     * Removing a membership must also drop every role the user held inside that
     * tenant, otherwise re-adding them later would silently restore permissions
     * an administrator believed were gone. Done in one transaction.
     */
    async removeMembership(userId: string, organizationId: string): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.userRoleAssignment.deleteMany({ where: { userId, organizationId } }),
            this.prisma.organizationMembership.deleteMany({ where: { userId, organizationId } }),
        ]);
    }
}

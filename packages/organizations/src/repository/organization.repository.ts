import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListOrganizationsQuery } from '../dto/organization.dto';

const organizationSelect = {
    id: true,
    name: true,
    type: true,
    slug: true,
    isActive: true,
    archivedAt: true,
    _count: { select: { artists: true, products: true } },
} satisfies Prisma.OrganizationSelect;

export type OrganizationRow = Prisma.OrganizationGetPayload<{
    select: typeof organizationSelect;
}>;

/** The only place in this module that touches Prisma. */
export class OrganizationRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(
        query: ListOrganizationsQuery,
    ): Promise<{ total: number; items: OrganizationRow[] }> {
        const where: Prisma.OrganizationWhereInput = {
            ...(query.includeArchived ? {} : { archivedAt: null }),
            ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
            ...(query.type ? { type: query.type } : {}),
            ...(query.search
                ? {
                    OR: [
                        { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                        { slug: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                    ],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.organization.count({ where }),
            this.prisma.organization.findMany({
                where,
                select: organizationSelect,
                // Alphabetical: this backs a picker, and a picker is scanned by
                // eye. Ordering by createdAt would put the newest brand first,
                // which is never where someone looks for one by name.
                orderBy: { name: 'asc' },
                skip: (query.page - 1) * query.limit,
                take: query.limit,
            }),
        ]);
        return { total, items };
    }

    findById(id: string): Promise<OrganizationRow | null> {
        return this.prisma.organization.findUnique({
            where: { id },
            select: organizationSelect,
        });
    }

    findBySlug(slug: string): Promise<OrganizationRow | null> {
        return this.prisma.organization.findUnique({
            where: { slug },
            select: organizationSelect,
        });
    }
}

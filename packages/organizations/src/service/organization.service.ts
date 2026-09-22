import { AppError } from '@hitbox/shared';
import { ORGANIZATIONS_ERROR_CODES } from '../constants/organizations.constant';
import type {
    ListOrganizationsQuery,
    OrganizationResponse,
} from '../dto/organization.dto';
import type {
    OrganizationRepository,
    OrganizationRow,
} from '../repository/organization.repository';

interface OrganizationServiceDeps {
    organizations: OrganizationRepository;
}

export class OrganizationService {
    constructor(private readonly deps: OrganizationServiceDeps) { }

    async list(query: ListOrganizationsQuery): Promise<{
        data: OrganizationResponse[];
        meta: { page: number; limit: number; total: number; totalPages: number };
    }> {
        const { total, items } = await this.deps.organizations.list(query);
        return {
            data: items.map(toResponse),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / query.limit)),
            },
        };
    }

    async getById(id: string): Promise<OrganizationResponse> {
        const row = await this.deps.organizations.findById(id);
        if (!row) {
            throw AppError.notFound(
                'Organization not found',
                ORGANIZATIONS_ERROR_CODES.NOT_FOUND,
            );
        }
        return toResponse(row);
    }
}

function toResponse(row: OrganizationRow): OrganizationResponse {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        slug: row.slug,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        counts: { artists: row._count.artists, products: row._count.products },
    };
}

import { AppError } from '@hitbox/shared';
import { ARTIST_PROFILE_ERROR_CODES } from '../constants/artist-profile.constant';
import type { ArtistResponse, ListArtistsQuery } from '../dto/artist.dto';
import type { ArtistRepository, ArtistRow } from '../repository/artist.repository';

interface ArtistServiceDeps {
    artists: ArtistRepository;
}

export class ArtistService {
    constructor(private readonly deps: ArtistServiceDeps) { }

    async list(query: ListArtistsQuery): Promise<{
        data: ArtistResponse[];
        meta: { page: number; limit: number; total: number; totalPages: number };
    }> {
        const { total, items } = await this.deps.artists.list(query);
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

    async getById(id: string): Promise<ArtistResponse> {
        const row = await this.deps.artists.findById(id);
        if (!row) {
            throw AppError.notFound('Artist not found', ARTIST_PROFILE_ERROR_CODES.NOT_FOUND);
        }
        return toResponse(row);
    }
}

function toResponse(row: ArtistRow): ArtistResponse {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        genre: row.genre,
        avatarUrl: row.avatarUrl,
        isPublic: row.isPublic,
        isActive: row.isActive,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        organizationId: row.organizationId,
        organizationName: row.organization?.name ?? null,
        counts: { products: row._count.products, collections: row._count.artistCollections },
    };
}

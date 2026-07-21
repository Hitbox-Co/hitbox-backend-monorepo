import type {
    ArtistCollectionCapacity,
    IArtistCollectionStats,
} from '@hitbox/collections';
import { DEFAULT_COLLECTION_MAX_LIMIT } from '../constants/artist-collection.constant';
import type { ArtistCollectionRepository } from '../repository/artist-collection.repository';

/**
 * Artist-side implementation of the collections module's IArtistCollectionStats
 * port. Same pattern as users→auth and products→discover: the consumer
 * (collections) defines the port, the provider (artist) implements it, and
 * bootstrap injects this adapter. When artist becomes its own service, this
 * class is re-implemented as an HTTP/RPC client — collections never changes.
 */
export class ArtistCollectionStatsAdapter implements IArtistCollectionStats {
    constructor(private readonly collections: ArtistCollectionRepository) { }

    async getCapacities(collectionIds: string[]): Promise<ArtistCollectionCapacity[]> {
        const rows = await this.collections.findCapacities(collectionIds);
        return rows.map((row) => ({
            collectionId: row.collectionId,
            // Guard against a bad/zero cap so progress math never divides oddly.
            maximumLimit: row.maximumLimit > 0 ? row.maximumLimit : DEFAULT_COLLECTION_MAX_LIMIT,
        }));
    }
}

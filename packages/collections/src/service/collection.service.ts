import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { CollectionVisibility } from '@hitbox/database';
import { COLLECTIONS_ERROR_CODES } from '../constants/collections.constant';
import { toCollectionItem } from '../dto/collection.dto';
import type {
    CollectionItemDto,
    CollectionStatsDto,
    ListCollectionQueryDto,
} from '../dto/collection.dto';
import type { IArtistCollectionStats } from '../domain/interfaces/artist-collection-stats.interface';
import type { BuyerCollectionRepository } from '../repository/buyer-collection.repository';

interface CollectionServiceDeps {
    collections: BuyerCollectionRepository;
    /** artist module's adapter, injected at bootstrap. */
    artistStats: IArtistCollectionStats;
    logger: Logger;
}

export interface PaginatedItems {
    items: CollectionItemDto[];
    total: number;
}

export class CollectionService {
    constructor(private readonly deps: CollectionServiceDeps) { }

    /** The owner's own shelf — private items included. */
    async listMine(userId: string, query: ListCollectionQueryDto): Promise<PaginatedItems> {
        const { items, total } = await this.deps.collections.findManyByUser(userId, query);
        return { items: items.map(toCollectionItem), total };
    }

    /** Someone else's showcase — PUBLIC items only. */
    async listPublicByUser(userId: string, query: ListCollectionQueryDto): Promise<PaginatedItems> {
        const { items, total } = await this.deps.collections.findManyByUser(userId, query, {
            publicOnly: true,
        });
        return { items: items.map(toCollectionItem), total };
    }

    /**
     * Stats section: total claimed items, how many ArtistCollections the user
     * has started, and progress toward completing them.
     *
     * Progress example (per the spec): the user has products in 3 collections
     * whose caps sum to 25, and owns 10 of them → owned 10 / total 25 = 40%.
     */
    async getStats(userId: string): Promise<CollectionStatsDto> {
        const base = await this.deps.collections.aggregateForStats(userId);

        const capacities = await this.deps.artistStats.getCapacities(base.collectionIds);
        const total = capacities.reduce((sum, c) => sum + c.maximumLimit, 0);
        const owned = base.ownedInCollections;
        const percentage = total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : 0;

        return {
            totalClaimedItems: base.totalClaimedItems,
            totalArtistCollections: base.collectionIds.length,
            collectionProgress: { owned, total, percentage },
        };
    }

    /** Toggle an owned item between PUBLIC and PRIVATE. */
    async setVisibility(
        userId: string,
        productId: string,
        visibility: CollectionVisibility,
    ): Promise<CollectionItemDto> {
        const item = await this.deps.collections.findItem(userId, productId);
        if (!item) {
            throw AppError.notFound(
                'Item not found in your collection',
                COLLECTIONS_ERROR_CODES.ITEM_NOT_FOUND,
            );
        }
        const updated = await this.deps.collections.updateVisibility(item.id, visibility);
        return toCollectionItem(updated);
    }
}

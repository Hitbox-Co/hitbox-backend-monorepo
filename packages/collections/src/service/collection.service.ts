import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { CollectionVisibility } from '@hitbox/database';
import { COLLECTIONS_ERROR_CODES } from '../constants/collections.constant';
import { toCollectionItem } from '../dto/collection.dto';
import type { CollectionItemDto, ListCollectionQueryDto } from '../dto/collection.dto';
import type { BuyerCollectionRepository } from '../repository/buyer-collection.repository';

interface CollectionServiceDeps {
    collections: BuyerCollectionRepository;
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

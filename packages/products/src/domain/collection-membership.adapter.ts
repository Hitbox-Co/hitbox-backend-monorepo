import { DropStatus } from '@hitbox/database';
import type { IEventBus } from '@hitbox/shared';
import { PRODUCT_EVENTS } from '../constants/products.constant';
import type { MembershipDropRow, ProductRepository } from '../repository/product.repository';

/** A drop as collection membership sees it. Matches @hitbox/artist's `MembershipDrop`. */
export interface CollectionMembershipDrop {
    id: string;
    publicCode: string | null;
    name: string;
    groupCode: string;
    status: string;
    /** On sale: ACTIVE, switched on, not archived — the public catalog's rule. */
    active: boolean;
    artistId: string | null;
    totalSupply: number;
    rewardPoints: number;
    publishedAt: Date | null;
    collection: { id: string; name: string } | null;
}

function toDrop(row: MembershipDropRow): CollectionMembershipDrop {
    return {
        id: row.id,
        publicCode: row.publicCode,
        name: row.name,
        groupCode: row.groupCode,
        status: row.status,
        active: row.status === DropStatus.ACTIVE && row.isActive && row.archivedAt === null,
        artistId: row.artistId,
        totalSupply: row.totalSupply,
        rewardPoints: row.rewardPoints,
        publishedAt: row.publishedAt,
        collection: row.collection ? { id: row.collection.id, name: row.collection.name } : null,
    };
}

/**
 * The provider side of the artist module's `IDropCollectionMembership` port:
 * an artist putting their own drops into their own collections.
 *
 * Products owns `Drop`, so products does the write — through the repository,
 * which keeps the product cache honest — and announces it with the same
 * `products.product.updated` every other drop edit publishes. The artist
 * module decides *whether* a drop may go in (it's theirs, it's active, it
 * isn't there already); the guarded write here re-asserts those facts so a
 * drop that changed in between is never moved anyway.
 */
export class CollectionMembershipAdapter {
    constructor(
        private readonly products: ProductRepository,
        private readonly eventBus: IEventBus,
    ) { }

    async listAssignable(input: {
        artistId: string;
        collectionId: string;
        includeFiled: boolean;
        q?: string | undefined;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: CollectionMembershipDrop[] }> {
        const { total, items } = await this.products.listAssignableToCollection(input);
        return { total, items: items.map(toDrop) };
    }

    async findDrops(dropIds: string[]): Promise<CollectionMembershipDrop[]> {
        if (dropIds.length === 0) return [];
        return (await this.products.findForMembership(dropIds)).map(toDrop);
    }

    /** False when any drop no longer matches what the caller checked — nothing was written. */
    async setCollection(input: {
        drops: { id: string; expectedCollectionId: string | null }[];
        artistId: string;
        collectionId: string | null;
        requireActive: boolean;
    }): Promise<boolean> {
        const written = await this.products.setCollection(input);
        if (!written) return false;
        for (const drop of input.drops) {
            await this.eventBus.publish(PRODUCT_EVENTS.PRODUCT_UPDATED, { productId: drop.id });
        }
        return true;
    }
}

import { Prisma } from '@hitbox/database';
import type { IMediaUrlResolver } from './interfaces/media-url-resolver.interface';
import type { DropCardRow } from '../repository/product.repository';

/**
 * The card both feeds render. Discover's `DiscoverProductItem` and
 * Marketplace's `MarketplaceListingItem` each declare this same shape in
 * their own package (neither depends on the other); this is the one place it
 * is built.
 */
export interface DropCard {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    rarity: string | null;
    category: string | null;
    artist: { id: string; name: string; slug: string } | null;
    price: { amount: string; currency: string; isFree: boolean } | null;
    totalSupply: number;
    mintedCount: number;
    rewardPoints: number;
    isWishlisted: boolean | null;
}

/**
 * `wishlisted` is the viewer's wishlisted drop ids, or null for a guest.
 *
 * Price: at most one row — the base price (variantId null) of the default
 * market, unique by @@unique([productId, variantId, marketId]). Formatted with
 * two decimals ("480.00"). The amount is re-wrapped in a Decimal because rows
 * read back from the list cache carry it as a plain string.
 */
export function toDropCard(
    row: DropCardRow,
    mediaUrls: IMediaUrlResolver | undefined,
    wishlisted: ReadonlySet<string> | null,
): DropCard {
    const ref = row.dropImages[0]?.asset.storageRef;
    const price = row.dropPrices[0];
    let amount: string | null = null;
    if (price) amount = price.isFree ? '0' : price.amount != null ? new Prisma.Decimal(price.amount).toFixed(2) : null;

    return {
        id: row.id,
        name: row.name,
        description: row.description,
        imageUrl: ref ? (mediaUrls?.publicUrl(ref) ?? null) : null,
        rarity: row.rarity,
        category: row.category,
        artist: row.artist ?? row.collection?.artist ?? null,
        price: price && amount !== null
            ? { amount, currency: price.market.currency, isFree: price.isFree }
            : null,
        totalSupply: row.totalSupply,
        mintedCount: row._count.skus,
        rewardPoints: row.rewardPoints,
        isWishlisted: wishlisted ? wishlisted.has(row.id) : null,
    };
}

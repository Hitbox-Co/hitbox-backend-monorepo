import type { PrismaClient } from '@hitbox/database';
import type { IArtistCollectionStats } from '@hitbox/collections';
import { ArtistOwnershipAdapter } from './adapter/artist-ownership.adapter';
import { ArtistCollectionStatsAdapter } from './collection/adapter/artist-collection-stats.adapter';
import { ArtistCollectionRepository } from './collection/repository/artist-collection.repository';

export interface ArtistModuleDeps {
    prisma: PrismaClient;
}

export interface ArtistModule {
    /**
     * Injected into createCollectionsModule — collections' port, artist's
     * adapter. Answers "how much capacity do these collections have?" for the
     * buyer collection-progress stat.
     */
    collectionStats: IArtistCollectionStats;
    /**
     * Injected into createTaxModule — tax's `IArtistOwnership` port. Answers
     * "which artist records does this user act for", which is how
     * `payment-royalty:read:own` narrows to one artist's tax documents.
     */
    ownership: ArtistOwnershipAdapter;
    // NOTE: no router yet. The artist/profile screen (and any public
    // artist/collection browsing routes) mount here when built.
}

export function createArtistModule(deps: ArtistModuleDeps): ArtistModule {
    const collections = new ArtistCollectionRepository(deps.prisma);
    return {
        collectionStats: new ArtistCollectionStatsAdapter(collections),
        ownership: new ArtistOwnershipAdapter(deps.prisma),
    };
}

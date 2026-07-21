import type { PrismaClient } from '@hitbox/database';
import type { IArtistCollectionStats } from '@hitbox/collections';
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
    // NOTE: no router yet. The artist/profile screen (and any public
    // artist/collection browsing routes) mount here when built.
}

export function createArtistModule(deps: ArtistModuleDeps): ArtistModule {
    const collections = new ArtistCollectionRepository(deps.prisma);
    return {
        collectionStats: new ArtistCollectionStatsAdapter(collections),
    };
}

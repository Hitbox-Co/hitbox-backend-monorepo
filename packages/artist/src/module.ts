import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import type { IArtistCollectionStats } from '@hitbox/collections';
import { ARTIST_READ_CAPABILITY } from './profile/constants/artist-profile.constant';
import { ArtistController } from './profile/controller/artist.controller';
import { ArtistRepository } from './profile/repository/artist.repository';
import { ArtistService } from './profile/service/artist.service';
import { ArtistOwnershipAdapter } from './adapter/artist-ownership.adapter';
import { ArtistCollectionStatsAdapter } from './collection/adapter/artist-collection-stats.adapter';
import { ArtistCollectionRepository } from './collection/repository/artist-collection.repository';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface ArtistPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface ArtistModuleDeps {
    prisma: PrismaClient;
    /** Required only to build the admin router. */
    guard?: ArtistPermissionGuard | undefined;
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
    /**
     * The artist directory, mounted at /api/v1/admin/artists.
     *
     * Read-only: it fills the artist picker on the drop form and labels
     * catalog rows. The full artist *profile* screen (bio, compliance
     * attestation, payout terms) is a separate surface behind
     * `brand-artist-record:read` and is not built yet.
     */
    createAdminRouter(requireAuth: RequestHandler): Router;
}

export function createArtistModule(deps: ArtistModuleDeps): ArtistModule {
    const collections = new ArtistCollectionRepository(deps.prisma);
    const artists = new ArtistRepository(deps.prisma);
    const service = new ArtistService({ artists });
    const controller = new ArtistController(service);

    return {
        collectionStats: new ArtistCollectionStatsAdapter(collections),
        ownership: new ArtistOwnershipAdapter(deps.prisma),

        createAdminRouter(requireAuth) {
            if (!deps.guard) {
                throw new Error(
                    'createArtistModule({ guard }) is required to build the admin router.',
                );
            }
            const { guard } = deps;

            const router = Router();
            router.use(requireAuth);
            router.get('/', guard.requirePermission(ARTIST_READ_CAPABILITY), controller.list);
            router.get(
                '/:artistId',
                guard.requirePermission(ARTIST_READ_CAPABILITY),
                controller.getById,
            );
            return router;
        },
    };
}

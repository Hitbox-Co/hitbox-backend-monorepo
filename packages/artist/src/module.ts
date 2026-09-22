import { Router } from 'express';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import type { IArtistCollectionStats } from '@hitbox/collections';
import { ARTIST_READ_CAPABILITY } from './profile/constants/artist-profile.constant';
import { ArtistController } from './profile/controller/artist.controller';
import { ArtistRepository } from './profile/repository/artist.repository';
import { ArtistService } from './profile/service/artist.service';
import { ArtistProvisioningService } from './profile/service/artist-provisioning.service';
import type {
    StaffInvitationAcceptedEvent,
    StaffInvitedEvent,
} from './profile/service/artist-provisioning.service';
import { ArtistOwnershipAdapter } from './adapter/artist-ownership.adapter';
import { ARTIST_MODULE } from './collection/constants/artist-collection.constant';
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
    /**
     * Subscribed to so an invited artist gets a profile.
     *
     * Optional: without it the module still serves the directory, it just
     * never provisions anything — which is the right behaviour in a test that
     * only wants the read side.
     */
    eventBus?: IEventBus | undefined;
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
    /**
     * Creates the `Artist` row behind an invitation. Exposed for tests and for
     * a backfill script; in the running app it is driven by the subscriptions
     * this factory sets up.
     */
    provisioning: ArtistProvisioningService;
}

export function createArtistModule(deps: ArtistModuleDeps): ArtistModule {
    const collections = new ArtistCollectionRepository(deps.prisma);
    const artists = new ArtistRepository(deps.prisma);
    const service = new ArtistService({ artists });
    const controller = new ArtistController(service);

    const logger = createModuleLogger(ARTIST_MODULE);
    const provisioning = new ArtistProvisioningService({ artists, logger });

    /**
     * Inviting someone as an artist creates their artist profile.
     *
     * Subscriptions rather than a port: provisioning is a *reaction* to
     * something access-control did, not a precondition of it. An invitation
     * must not fail because the artist table was unhappy, and access-control
     * must not learn what an artist is.
     *
     * Handlers swallow their own failures for the same reason — an unhandled
     * rejection in a subscriber would otherwise surface as a failed invitation
     * that was, in fact, sent.
     */
    if (deps.eventBus) {
        deps.eventBus.subscribe<StaffInvitedEvent>(
            'access-control.staff.invited',
            async (event) => {
                try {
                    await provisioning.onStaffInvited(event);
                } catch (error) {
                    logger.error(
                        { err: error, invitationId: event?.invitationId },
                        'could not provision an artist profile for a staff invitation',
                    );
                }
            },
        );

        deps.eventBus.subscribe<StaffInvitationAcceptedEvent>(
            'access-control.staff.invitation-accepted',
            async (event) => {
                try {
                    await provisioning.onInvitationAccepted(event);
                } catch (error) {
                    logger.error(
                        { err: error, invitationId: event?.invitationId },
                        'could not link an artist profile to the accepted account',
                    );
                }
            },
        );
    }

    return {
        provisioning,
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

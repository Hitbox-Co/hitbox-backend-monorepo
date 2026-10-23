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
import { ArtistCollectionService } from './collection/service/artist-collection.service';
import {
    AdminArtistCollectionController,
    ArtistCollectionController,
} from './collection/controller/artist-collection.controller';
import {
    COLLECTION_READ_CAPABILITY,
    COLLECTION_WRITE_CAPABILITY,
} from './collection/constants/artist-collection.constant';
import {
    ARTIST_SELF_READ_CAPABILITY,
    ARTIST_SELF_UPDATE_CAPABILITY,
} from './self/constants/artist-self.constant';
import { ArtistSelfController } from './self/controller/artist-self.controller';
import type { ArtistUserIdResolver } from './self/controller/artist-self.controller';
import type { IArtistImageStorage } from './self/domain/artist-image-storage.interface';
import type { IArtistAuditRecorder } from './domain/interfaces/audit-recorder.port';
import type { IDropCollectionMembership } from './collection/domain/drop-membership.port';
import { ArtistSelfRepository } from './self/repository/artist-self.repository';
import { ArtistSelfService } from './self/service/artist-self.service';

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
    /** Required to build the admin and self-service routers. */
    guard?: ArtistPermissionGuard | undefined;
    /**
     * The signed-in account id (`req => req.auth?.accountId`). Required to
     * build the self-service router — "which artist" is always the caller's
     * own profile, never a request parameter.
     */
    resolveUserId?: ArtistUserIdResolver | undefined;
    /**
     * Avatar / cover storage, provided by @hitbox/media. Optional: without a
     * bucket, the image endpoints answer ARTIST_IMAGES_UNAVAILABLE and the
     * rest of the profile still works.
     */
    images?: IArtistImageStorage | undefined;
    /**
     * Putting drops into collections, provided by @hitbox/products
     * (`productsModule.collectionMembership`) — products owns `Drop` and its
     * cache. Optional: without it the drop routes answer
     * ARTIST_COLLECTION_DROPS_UNAVAILABLE and the rest still works.
     */
    drops?: IDropCollectionMembership | undefined;
    /**
     * The audit hook. Every collection change is recorded through it
     * (`artist.collection.*`). Required to build the self-service and
     * collections routers — a write surface without its audit trail is not
     * something to start by accident. Optional for read-only test setups.
     */
    audit?: IArtistAuditRecorder | undefined;
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
     * Artist self-service, mounted at /api/v1/artist: an artist reading and
     * editing their OWN profile — name, handle, bio, genre, visibility,
     * avatar and cover. docs/artist/artist-profile-api.md.
     */
    createSelfRouter(requireAuth: RequestHandler): Router;
    /**
     * HitBox monitoring of every artist's collections, mounted at
     * /api/v1/admin/artist-collections. Read-only, platform-wide grants only.
     * docs/artist-collection/.
     */
    createCollectionsAdminRouter(requireAuth: RequestHandler): Router;
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
    const selfRepository = new ArtistSelfRepository(deps.prisma);
    const collectionService = new ArtistCollectionService({
        collections,
        artists: selfRepository,
        // Routers refuse to build without a real recorder (below); this
        // fallback only ever serves a module built for the read side.
        audit: deps.audit ?? { record: () => Promise.reject(new Error('artist module built without an audit recorder')) },
        images: deps.images,
        drops: deps.drops,
        eventBus: deps.eventBus,
        logger,
    });
    const selfService = new ArtistSelfService({
        artists: selfRepository,
        images: deps.images,
        eventBus: deps.eventBus,
        logger,
    });

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

        createSelfRouter(requireAuth) {
            if (!deps.guard || !deps.resolveUserId || !deps.audit) {
                throw new Error(
                    'createArtistModule({ guard, resolveUserId, audit }) is required to build the self-service router.',
                );
            }
            const { guard, resolveUserId } = deps;
            const controller = new ArtistSelfController(selfService, resolveUserId);

            // `own` scope, checked against the caller's own id: only a holder
            // of brand-artist-record:*:own (the ARTIST role) passes. A Brand
            // Admin's :organization grant does not reach it.
            const mine = (req: Request) => ({ ownerId: resolveUserId(req) ?? null });
            const read = guard.requirePermission(ARTIST_SELF_READ_CAPABILITY, { context: mine });
            const update = guard.requirePermission(ARTIST_SELF_UPDATE_CAPABILITY, { context: mine });

            const router = Router();
            router.use(requireAuth);

            router.get('/genres', read, controller.genres);
            router.get('/me', read, controller.get);
            router.patch('/me', update, controller.update);

            for (const kind of ['avatar', 'cover'] as const) {
                router.post(`/me/${kind}/upload-url`, update, controller.createUpload(kind));
                router.put(`/me/${kind}`, update, controller.setImage(kind));
                router.delete(`/me/${kind}`, update, controller.removeImage(kind));
            }

            // Collections — same own-scope gates as the profile: a collection
            // is part of the artist's record. docs/artist-collection/.
            const collectionsController = new ArtistCollectionController(collectionService, resolveUserId);
            const readCollections = guard.requirePermission(COLLECTION_READ_CAPABILITY, { context: mine });
            const writeCollections = guard.requirePermission(COLLECTION_WRITE_CAPABILITY, { context: mine });

            router.get('/collections', readCollections, collectionsController.list);
            router.post('/collections', writeCollections, collectionsController.create);
            // Before '/collections/:collectionId' so "order" is never read as an id.
            router.put('/collections/order', writeCollections, collectionsController.reorder);
            router.get('/collections/:collectionId', readCollections, collectionsController.get);
            router.patch('/collections/:collectionId', writeCollections, collectionsController.update);
            router.delete('/collections/:collectionId', writeCollections, collectionsController.archive);
            router.post('/collections/:collectionId/restore', writeCollections, collectionsController.restore);
            // Drops: the picker, add (or move), remove. The artist's own,
            // active drops only — checked in the service, re-asserted by
            // products at write time.
            router.get('/collections/:collectionId/available-drops', readCollections, collectionsController.availableDrops);
            router.post('/collections/:collectionId/drops', writeCollections, collectionsController.addDrops);
            router.delete('/collections/:collectionId/drops/:dropId', writeCollections, collectionsController.removeDrop);
            router.post('/collections/:collectionId/hero/upload-url', writeCollections, collectionsController.createHeroUpload);
            router.put('/collections/:collectionId/hero', writeCollections, collectionsController.setHero);
            router.delete('/collections/:collectionId/hero', writeCollections, collectionsController.removeHero);
            return router;
        },

        createCollectionsAdminRouter(requireAuth) {
            if (!deps.guard) {
                throw new Error(
                    'createArtistModule({ guard }) is required to build the collections admin router.',
                );
            }
            // Platform-wide only. brand-artist-record:manage:global (System
            // Admin) satisfies it; a Brand Admin's :organization read does not.
            const monitor = deps.guard.requirePermission(COLLECTION_READ_CAPABILITY, { globalOnly: true });
            const adminController = new AdminArtistCollectionController(collectionService);

            const router = Router();
            router.use(requireAuth);
            router.get('/', monitor, adminController.list);
            // Before '/:collectionId' so "summary" is never read as an id.
            router.get('/summary', monitor, adminController.summary);
            router.get('/:collectionId', monitor, adminController.get);
            return router;
        },

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

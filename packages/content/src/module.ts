import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    CONTENT_MODULE,
    REWARD_ADMIN_CAPABILITY,
    REWARD_READ_CAPABILITY,
    SUBSCRIBED_EVENTS,
} from './constants/content.constant';
import { AdminRewardController } from './controller/admin-reward.controller';
import type { IContentAuditRecorder } from './domain/content-audit.port';
import { AdminRewardService } from './service/admin-reward.service';
import { BuyerRewardController } from './controller/buyer-reward.controller';
import type { ContentUserIdResolver } from './controller/buyer-reward.controller';
import type { IRewardMedia } from './domain/reward-media.port';
import { ContentRepository } from './repository/content.repository';
import { CollectionRewardService } from './service/collection-reward.service';
import { RewardUnlockService } from './service/reward-unlock.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface ContentPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

export interface ContentModuleDeps {
    prisma: PrismaClient;
    /**
     * Subscribed to: a claim may complete a buyer's set, a revoked claim may
     * break it. Optional only for tests — without it nothing unlocks on its own.
     */
    eventBus?: IEventBus | undefined;
    /** Required to build the buyer router. */
    guard?: ContentPermissionGuard | undefined;
    /** The signed-in account id. Required to build the buyer router. */
    resolveUserId?: ContentUserIdResolver | undefined;
    /**
     * Reward files, provided by @hitbox/media (`mediaModule.exclusiveContent`).
     * Optional: without a bucket, uploads answer CONTENT_REWARD_MEDIA_UNAVAILABLE
     * and links are null; the rewards and the unlock rule still work.
     */
    media?: IRewardMedia | undefined;
    /**
     * The audit hook. Staff moderation (switch off / on, remove / restore) is
     * recorded through it. Required to build the admin router — a moderation
     * surface without its audit trail is not something to start by accident.
     */
    audit?: IContentAuditRecorder | undefined;
}

export interface ContentModule {
    /**
     * Injected into createArtistModule — the artist module's
     * `ICollectionRewards` port. The artist panel manages its collections'
     * rewards through it, after proving the caller owns the collection.
     */
    collectionRewards: CollectionRewardService;
    /** The unlock rule. Exposed for tests and backfills; the running app drives it from claim events. */
    unlocks: RewardUnlockService;
    /**
     * A buyer's rewards, mounted at /api/v1/rewards.
     * docs/content/collection-rewards.md.
     */
    createBuyerRouter(requireAuth: RequestHandler): Router;
    /**
     * HitBox staff over every collection reward — monitoring and moderation —
     * mounted at /api/v1/admin/rewards. Platform-wide grants only.
     * docs/content/admin-rewards-api.md.
     */
    createAdminRouter(requireAuth: RequestHandler): Router;
}

interface ClaimedEvent { userId: string; productId: string }
interface ClaimRevokedEvent { userId?: string | null; productId?: string | null }

export function createContentModule(deps: ContentModuleDeps): ContentModule {
    const logger = createModuleLogger(CONTENT_MODULE);
    const content = new ContentRepository(deps.prisma);
    const unlocks = new RewardUnlockService({ content, media: deps.media, eventBus: deps.eventBus, logger });
    const collectionRewards = new CollectionRewardService({ content, unlocks, media: deps.media });
    const adminRewards = new AdminRewardService({
        content,
        unlocks,
        // The router refuses to build without a real recorder (below).
        audit: deps.audit ?? { record: () => Promise.reject(new Error('content module built without an audit recorder')) },
        media: deps.media,
        eventBus: deps.eventBus,
        logger,
    });

    /**
     * Ownership changes drive the rule. Subscriptions rather than a port: an
     * unlock is a *reaction* to a claim, and a claim must never fail because
     * the reward table was unhappy — so handlers swallow and log their own
     * failures. A buyer missed here is caught later: opening the teaser
     * re-checks and grants.
     */
    if (deps.eventBus) {
        deps.eventBus.subscribe<ClaimedEvent>(SUBSCRIBED_EVENTS.PRODUCT_CLAIMED, async (event) => {
            try {
                await unlocks.onClaimed(event);
            } catch (error) {
                logger.error({ err: error, userId: event?.userId }, 'could not evaluate collection reward after a claim');
            }
        });
        deps.eventBus.subscribe<ClaimRevokedEvent>(SUBSCRIBED_EVENTS.CLAIM_REVOKED, async (event) => {
            try {
                await unlocks.onClaimRevoked({ userId: event?.userId ?? null, productId: event?.productId ?? null });
            } catch (error) {
                logger.error({ err: error, userId: event?.userId }, 'could not re-check collection reward after a revoked claim');
            }
        });
    }

    return {
        collectionRewards,
        unlocks,

        createBuyerRouter(requireAuth) {
            if (!deps.guard || !deps.resolveUserId) {
                throw new Error('createContentModule({ guard, resolveUserId }) is required to build the buyer router.');
            }
            const { guard, resolveUserId } = deps;
            const controller = new BuyerRewardController(unlocks, resolveUserId);

            // `own` scope against the caller's own id: content-unlock:read:own
            // (BUYER_COLLECTOR). Which rewards are theirs is decided inside.
            const read = guard.requirePermission(REWARD_READ_CAPABILITY, {
                context: (req: Request) => ({ ownerId: resolveUserId(req) ?? null }),
            });

            const router = Router();
            router.use(requireAuth);
            router.get('/', read, controller.list);
            // Before '/:rewardId' so "collections" is never read as an id.
            router.get('/collections/:collectionId', read, controller.teaser);
            router.get('/:rewardId', read, controller.get);
            return router;
        },

        createAdminRouter(requireAuth) {
            if (!deps.guard || !deps.audit) {
                throw new Error('createContentModule({ guard, audit }) is required to build the admin router.');
            }
            // Platform-wide only: content-unlock:manage:global (System Admin,
            // Content Manager). A Brand Admin's or an artist's
            // :organization grant does not pass.
            const staff = deps.guard.requirePermission(REWARD_ADMIN_CAPABILITY, { globalOnly: true });
            const controller = new AdminRewardController(adminRewards);

            const router = Router();
            router.use(requireAuth);
            router.get('/', staff, controller.list);
            // Before '/:rewardId' so "summary" is never read as an id.
            router.get('/summary', staff, controller.summary);
            router.get('/:rewardId', staff, controller.get);
            router.get('/:rewardId/unlocks', staff, controller.unlocks);
            for (const action of ['switch-off', 'switch-on', 'remove', 'restore'] as const) {
                router.post(`/:rewardId/${action}`, staff, controller.moderate(action));
            }
            return router;
        },
    };
}

import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { CONTENT_ERROR_CODES, CONTENT_EVENTS } from '../constants/content.constant';
import type { IRewardMedia } from '../domain/reward-media.port';
import type { BuyerRewardDetail, BuyerRewardSummary, RewardTeaser } from '../dto/reward.views';
import type { ContentRepository, RewardRow } from '../repository/content.repository';
import { collectionRef, isOpen, itemCounts, itemViews } from './reward-mapping';

interface RewardUnlockServiceDeps {
    content: ContentRepository;
    media?: IRewardMedia | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    now?: () => Date;
}

/**
 * The rule, and the buyer's side of it.
 *
 * **A buyer unlocks a collection's reward when they own a claimed unit of
 * every released drop of that collection** (released = PUBLISHED, ACTIVE or
 * ENDED). Owning means *claimed* — the NFC tap that puts the item on the
 * buyer's shelf — not merely paid for.
 *
 * When it is decided:
 *   - on every claim (`claims.product.claimed`) — for the drop's collection;
 *   - when the artist switches a reward on — for everyone who already has the
 *     set (`grantToCompleters`).
 *
 * Keeping it: an unlock lasts. A drop the artist adds to the collection later
 * does not take it away from someone who completed the set before. Losing a
 * piece does: when a claim is revoked (refund, lost dispute) and the buyer no
 * longer owns any unit of that drop, their access ends — and comes back the
 * moment they complete the set again.
 *
 * Opening it needs both: a live grant **and** the reward being on (switched
 * on, not removed, its collection not deleted).
 */
export class RewardUnlockService {
    constructor(private readonly deps: RewardUnlockServiceDeps) { }

    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    // ── Reacting to ownership ───────────────────────────────────────────────

    /** A buyer claimed a unit of `dropId`. Grants the drop's collection reward if the set is now complete. */
    async onClaimed(input: { userId: string; productId: string }): Promise<boolean> {
        const collectionId = await this.deps.content.collectionOfDrop(input.productId);
        if (!collectionId) return false;
        return this.evaluate(input.userId, collectionId);
    }

    /**
     * A buyer's claim was taken back. If they no longer own any unit of that
     * drop, they no longer hold the set: their access to its collection's
     * reward ends.
     */
    async onClaimRevoked(input: { userId: string | null; productId: string | null }): Promise<boolean> {
        if (!input.userId || !input.productId) return false;
        if (await this.deps.content.ownsDrop(input.userId, input.productId)) return false;
        const collectionId = await this.deps.content.collectionOfDrop(input.productId);
        if (!collectionId) return false;
        const reward = await this.deps.content.findRewardOfCollection(collectionId);
        if (!reward) return false;

        const ended = await this.deps.content.endGrant(input.userId, reward.id, this.now());
        if (ended) {
            await this.deps.eventBus?.publish(CONTENT_EVENTS.REWARD_ACCESS_LOST, {
                rewardId: reward.id,
                collectionId,
                userId: input.userId,
                droppedProductId: input.productId,
            });
            this.deps.logger.info({ rewardId: reward.id, userId: input.userId }, 'collection reward access ended');
        }
        return ended;
    }

    /** Grants the collection's reward to this buyer if it is on and they hold the full set. */
    async evaluate(userId: string, collectionId: string): Promise<boolean> {
        const reward = await this.deps.content.findRewardOfCollection(collectionId);
        if (!reward || !isOpen(reward)) return false;

        const drops = await this.deps.content.releasedDrops(collectionId);
        if (drops.length === 0) return false;
        const owned = await this.deps.content.ownedDropIds(userId, drops.map((d) => d.id));
        if (owned.size < drops.length) return false;

        const opened = await this.deps.content.grant(userId, reward.id, this.now());
        if (opened) await this.announce(reward, [userId]);
        return opened;
    }

    /** Switching a reward on: everyone who already holds the full set gets it now. */
    async grantToCompleters(reward: RewardRow): Promise<number> {
        if (!isOpen(reward) || !reward.collectionId) return 0;
        const completers = await this.deps.content.completers(reward.collectionId);
        const opened = await this.deps.content.grantMany(completers, reward.id, this.now());
        if (opened.length > 0) await this.announce(reward, opened);
        return opened.length;
    }

    private async announce(reward: RewardRow, userIds: string[]): Promise<void> {
        for (const userId of userIds) {
            await this.deps.eventBus?.publish(CONTENT_EVENTS.REWARD_UNLOCKED, {
                rewardId: reward.id,
                collectionId: reward.collectionId,
                userId,
            });
        }
        this.deps.logger.info({ rewardId: reward.id, count: userIds.length }, 'collection reward unlocked');
    }

    // ── The buyer's endpoints ───────────────────────────────────────────────

    /** GET /rewards — what I have unlocked and can open now. */
    async listMine(userId: string): Promise<BuyerRewardSummary[]> {
        const rows = await this.deps.content.myLiveRewards(userId, this.now());
        return rows
            .filter((row) => isOpen(row.bundle))
            .map((row) => summary(row.bundle, row.grantedAt));
    }

    /**
     * GET /rewards/:rewardId — an unlocked reward, opened: every file with a
     * signed link. A reward the caller hasn't unlocked is 403 LOCKED (with
     * the collection id so the app can show the teaser); one that doesn't
     * exist or is switched off is 404.
     */
    async getMine(userId: string, rewardId: string): Promise<BuyerRewardDetail> {
        const reward = await this.deps.content.findReward(rewardId);
        if (!reward || !isOpen(reward)) throw notFound();
        const grant = await this.deps.content.findGrant(userId, reward.id);
        const now = this.now();
        const live = grant !== null && (grant.accessExpiresAt === null || grant.accessExpiresAt > now);
        if (!grant || !live) {
            throw new AppError(
                'Collect every drop of this collection to unlock it.',
                403,
                CONTENT_ERROR_CODES.REWARD_LOCKED,
                { collectionId: reward.collectionId },
            );
        }
        await this.deps.content.recordView(userId, reward.id, now);
        return {
            ...summary(reward, grant.grantedAt),
            items: await itemViews(reward.contentBundleItems, this.deps.media, true),
        };
    }

    /**
     * GET /rewards/collections/:collectionId — the teaser: what the reward
     * holds (counts per kind, never the files) and how close I am. No links.
     */
    async teaser(userId: string, collectionId: string): Promise<RewardTeaser> {
        const reward = await this.deps.content.findRewardOfCollection(collectionId);
        if (!reward || !isOpen(reward)) throw notFound();

        const now = this.now();
        const drops = await this.deps.content.releasedDrops(collectionId);
        const [owned, unlocked] = await Promise.all([
            this.deps.content.ownedDropIds(userId, drops.map((d) => d.id)),
            this.deps.content.hasLiveGrant(userId, reward.id, now),
        ]);
        const missing = drops.filter((d) => !owned.has(d.id));
        const complete = drops.length > 0 && missing.length === 0;

        // Holds the set but was never granted (claimed before the reward
        // existed, and the switch-on grant missed them): grant now.
        let open = unlocked;
        if (complete && !unlocked) open = await this.evaluate(userId, collectionId);

        return {
            reward: {
                id: reward.id,
                name: reward.name,
                description: reward.description,
                itemCounts: itemCounts(reward.contentBundleItems),
                itemTotal: reward.contentBundleItems.length,
            },
            collection: collectionRef(reward),
            progress: {
                required: drops.length,
                collected: drops.length - missing.length,
                missing: missing.map((d) => ({ dropId: d.id, publicCode: d.publicCode, name: d.name })),
                complete,
            },
            unlocked: open,
        };
    }
}

function summary(row: RewardRow, grantedAt: Date): BuyerRewardSummary {
    return {
        id: row.id,
        publicCode: row.publicCode,
        name: row.name,
        description: row.description,
        collection: collectionRef(row),
        unlockedAt: grantedAt.toISOString(),
        itemCounts: itemCounts(row.contentBundleItems),
        itemTotal: row.contentBundleItems.length,
    };
}

function notFound(): AppError {
    return AppError.notFound('This collection has no reward.', CONTENT_ERROR_CODES.REWARD_NOT_FOUND);
}

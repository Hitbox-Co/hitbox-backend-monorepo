import type { Logger } from 'pino';
import type { Redis } from '@hitbox/shared';
import { AUTHZ_CACHE } from '../constants/authz.constant';
import type { AuthzPrincipal } from '../domain/interfaces/principal.interface';

/**
 * PERMISSION CACHE
 * ================
 * Authorization runs on nearly every request, so the effective-permission
 * snapshot is cached in two tiers:
 *
 *   L1  in-process Map      — sub-microsecond, per instance, very short TTL
 *   L2  Redis               — shared across instances, minutes-long TTL
 *   L3  Postgres (the truth) — only on a full miss
 *
 * INVALIDATION (see docs/authorization/07-caching.md)
 *
 *   Targeted   `invalidateUser(id)`  DELs the user's L2 key, drops L1 locally,
 *                                    and PUBLISHes so every other instance
 *                                    drops its L1 copy too (bounded by network
 *                                    latency, not by TTL).
 *   Global     `invalidateAll()`     INCRs an epoch counter. Cached entries
 *                                    carry the epoch they were built under and
 *                                    are rejected on read, so a catalog change
 *                                    invalidates everything in O(1) with no key
 *                                    scanning.
 *
 * Cache entries are derived state; the relational rows remain authoritative, so
 * throwing the cache away is always safe. Nothing is cached forever: the L2 TTL
 * is a backstop that bounds staleness even if an invalidation is lost.
 */

/** What we actually store, so a stale epoch can be detected on read. */
interface CacheEnvelope {
    epoch: number;
    principal: AuthzPrincipal;
}

export interface PermissionCacheOptions {
    /** Null when REDIS_URL is unset — the cache degrades to L1-only. */
    redis: Redis | null;
    logger: Logger;
    /** L2 TTL. Upper bound on staleness if an invalidation message is lost. */
    ttlSeconds: number;
    /** L1 TTL. Set to 0 to disable the in-process tier entirely. */
    localTtlMs: number;
    /** How long the epoch value itself is cached in-process. */
    epochTtlMs?: number;
}

const INVALIDATION_CHANNEL = 'authz:invalidate';

export class PermissionCache {
    private readonly local = new Map<string, { expiresAt: number; envelope: CacheEnvelope }>();
    private readonly redis: Redis | null;
    private readonly logger: Logger;
    private readonly ttlSeconds: number;
    private readonly localTtlMs: number;
    private readonly epochTtlMs: number;

    /** Fallback epoch when Redis is absent (single-instance dev). */
    private memoryEpoch = 1;
    private epochValue: number | null = null;
    private epochReadAt = 0;

    private subscriber: Redis | null = null;

    constructor(options: PermissionCacheOptions) {
        this.redis = options.redis;
        this.logger = options.logger;
        this.ttlSeconds = options.ttlSeconds;
        this.localTtlMs = options.localTtlMs;
        this.epochTtlMs = options.epochTtlMs ?? 5_000;

        if (this.redis && this.localTtlMs > 0) {
            this.startInvalidationListener(this.redis);
        }
    }

    // ------------------------------------------------------------------ reads

    async get(userId: string): Promise<AuthzPrincipal | null> {
        const epoch = await this.currentEpoch();

        const local = this.local.get(userId);
        if (local) {
            if (local.expiresAt > Date.now() && local.envelope.epoch === epoch) {
                return local.envelope.principal;
            }
            this.local.delete(userId);
        }

        if (!this.redis) return null;

        try {
            const raw = await this.redis.get(this.key(userId));
            if (!raw) return null;

            const envelope = JSON.parse(raw) as CacheEnvelope;
            if (envelope.epoch !== epoch) return null;

            this.rememberLocally(userId, envelope);
            return envelope.principal;
        } catch (err) {
            // A cache outage must never turn into an authorization outage —
            // fall through to the database.
            this.logger.warn({ err, userId }, 'authz cache read failed; falling back to database');
            return null;
        }
    }

    async set(userId: string, principal: AuthzPrincipal): Promise<void> {
        const envelope: CacheEnvelope = { epoch: await this.currentEpoch(), principal };
        this.rememberLocally(userId, envelope);

        if (!this.redis) return;
        try {
            await this.redis.set(
                this.key(userId),
                JSON.stringify(envelope),
                'EX',
                this.ttlSeconds,
            );
        } catch (err) {
            this.logger.warn({ err, userId }, 'authz cache write failed');
        }
    }

    // ---------------------------------------------------------- invalidation

    /** Call after ANY change to a single user's roles or memberships. */
    async invalidateUser(userId: string): Promise<void> {
        this.local.delete(userId);
        if (!this.redis) return;

        try {
            await this.redis.del(this.key(userId));
            // Tell the other instances to drop their L1 copy immediately.
            await this.redis.publish(INVALIDATION_CHANNEL, userId);
        } catch (err) {
            this.logger.error(
                { err, userId },
                'authz cache invalidation failed — permissions may be stale until TTL expiry',
            );
        }
    }

    async invalidateUsers(userIds: readonly string[]): Promise<void> {
        await Promise.all(userIds.map((userId) => this.invalidateUser(userId)));
    }

    /**
     * Global invalidation for catalog-level changes (a role's permission set
     * changed, the seeder ran). O(1): bump the epoch, every entry becomes
     * unreadable on its next read.
     */
    async invalidateAll(): Promise<void> {
        this.local.clear();
        this.epochValue = null;

        if (!this.redis) {
            this.memoryEpoch += 1;
            return;
        }
        try {
            const next = await this.redis.incr(AUTHZ_CACHE.EPOCH_KEY);
            this.epochValue = next;
            this.epochReadAt = Date.now();
            await this.redis.publish(INVALIDATION_CHANNEL, '*');
            this.logger.info({ epoch: next }, 'authz permission cache epoch bumped');
        } catch (err) {
            this.logger.error({ err }, 'authz global cache invalidation failed');
        }
    }

    /** Releases the pub/sub connection. Called on shutdown. */
    async close(): Promise<void> {
        if (!this.subscriber) return;
        try {
            await this.subscriber.quit();
        } catch {
            this.subscriber.disconnect();
        }
        this.subscriber = null;
    }

    // ---------------------------------------------------------------- internals

    private key(userId: string): string {
        // The epoch lives inside the value, not the key, so a targeted DEL is
        // exact and does not need to guess which epoch a user was cached under.
        return `authz:principal:${userId}`;
    }

    private rememberLocally(userId: string, envelope: CacheEnvelope): void {
        if (this.localTtlMs <= 0) return;
        this.local.set(userId, { expiresAt: Date.now() + this.localTtlMs, envelope });
    }

    private async currentEpoch(): Promise<number> {
        if (!this.redis) return this.memoryEpoch;

        const now = Date.now();
        if (this.epochValue !== null && now - this.epochReadAt < this.epochTtlMs) {
            return this.epochValue;
        }

        try {
            const raw = await this.redis.get(AUTHZ_CACHE.EPOCH_KEY);
            this.epochValue = raw ? Number.parseInt(raw, 10) : 1;
            if (Number.isNaN(this.epochValue)) this.epochValue = 1;
        } catch (err) {
            this.logger.warn({ err }, 'authz epoch read failed; using last known value');
            this.epochValue = this.epochValue ?? 1;
        }
        this.epochReadAt = now;
        return this.epochValue;
    }

    private startInvalidationListener(redis: Redis): void {
        try {
            // ioredis connections in subscriber mode cannot issue normal
            // commands, hence a dedicated duplicate.
            const subscriber = redis.duplicate();
            subscriber.on('error', (err: unknown) =>
                this.logger.warn({ err }, 'authz invalidation subscriber error'),
            );
            subscriber.subscribe(INVALIDATION_CHANNEL).catch((err: unknown) =>
                this.logger.warn({ err }, 'authz invalidation subscribe failed'),
            );
            subscriber.on('message', (_channel: string, message: string) => {
                if (message === '*') {
                    this.local.clear();
                    this.epochValue = null;
                } else {
                    this.local.delete(message);
                }
            });
            this.subscriber = subscriber;
        } catch (err) {
            // Without pub/sub, L1 staleness is bounded by localTtlMs instead.
            this.logger.warn({ err }, 'authz invalidation listener unavailable');
        }
    }
}

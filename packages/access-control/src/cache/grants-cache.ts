import { createRedisSubscriber, getRedis } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    AUTHZ_CACHE_EPOCH_KEY,
    AUTHZ_CACHE_EPOCH_TTL_MS,
    AUTHZ_CACHE_INVALIDATION_CHANNEL,
    AUTHZ_CACHE_KEY_PREFIX,
    AUTHZ_CACHE_L1_MAX_ENTRIES,
    AUTHZ_CACHE_L1_TTL_MS,
    AUTHZ_CACHE_L2_TTL_SECONDS,
} from '../constants/access-control.constant';
import type { IGrantsInvalidator } from '../domain/interfaces/grants-invalidator.interface';
import type {
    IPrincipalGrantsLookup,
    PrincipalGrant,
} from '../domain/interfaces/principal-grants.interface';
import { InProcessStore } from './in-process-store';

/**
 * THREE-LAYER GRANT CACHE
 *
 *   L3  PostgreSQL          source of truth. Never bypassed on a miss.
 *        ▲                  RoleAssignment → Role → RolePermission → Permission
 *   L2  Redis               shared across every process/instance. TTL 60 s.
 *        ▲                  key: authz:grants:{epoch}:{userId}
 *   L1  in-process Map      per process, zero network. TTL 15 s, LRU-bounded.
 *        ▲
 *   L0  per-request WeakMap (in the guard) — several checks in one request
 *                            resolve to a single lookup.
 *
 * A read walks down until something answers, then **back-fills upward**, so a
 * cold L1 warmed from L2 costs one Redis GET rather than a four-table join.
 *
 * ── Why authorization caching needs more care than product caching ─────────
 *
 * A stale product listing is a cosmetic bug. A stale grant is a revoked
 * administrator who still has access. So this cache is invalidation-first:
 *
 *  1. **Precise eviction on assign/revoke.** The service awaits
 *     `invalidateUser` before responding, so a revoke is effective by the
 *     time the caller sees 204.
 *  2. **Epoch bump for role-shaped changes.** Editing a role's permissions
 *     affects an unknown set of users. Rather than SCAN (which blocks a
 *     production Redis), a counter in the L2 key namespace is INCR'd —
 *     every cached entry everywhere becomes unreachable in one command.
 *  3. **Pub/sub broadcast.** L1 lives inside a process, so Redis alone cannot
 *     evict it. Every invalidation is published on a channel that all
 *     instances subscribe to, so their L1 clears within milliseconds.
 *  4. **Short TTLs as a backstop.** Pub/sub is at-most-once — a subscriber
 *     disconnected during a broadcast misses it. The 15-second L1 TTL bounds
 *     that worst case, so a missed broadcast degrades to brief staleness
 *     rather than indefinite.
 *  5. **L2 distrust after a failed eviction.** If a DEL or epoch bump does
 *     not land, a stale entry may still be readable — so the instance stops
 *     reading L2 for one L2 TTL rather than serving it back.
 *
 * Every layer fails open *to the layer below*, never to "allow": if Redis is
 * down, reads fall through to Postgres and authorization still works
 * correctly, just slower.
 */

/** Message shape on the invalidation channel. */
type InvalidationMessage =
    | { type: 'user'; userId: string; origin: string }
    | { type: 'all'; epoch: number; reason: string; origin: string };

export interface GrantsCacheOptions {
    l1TtlMs?: number;
    l1MaxEntries?: number;
    l2TtlSeconds?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

export interface GrantsCacheDeps {
    /** L3 — the repository. */
    source: IPrincipalGrantsLookup;
    logger: Logger;
    options?: GrantsCacheOptions;
}

export interface GrantsCacheStats {
    l1: ReturnType<InProcessStore<PrincipalGrant[]>['stats']>;
    l2Hits: number;
    l2Misses: number;
    sourceLoads: number;
    epoch: number | null;
    /** False while L2 is being bypassed after a failed eviction. */
    l2Trusted: boolean;
    redisAvailable: boolean;
    subscribed: boolean;
}

export class LayeredGrantsCache implements IPrincipalGrantsLookup, IGrantsInvalidator {
    private readonly l1: InProcessStore<PrincipalGrant[]>;
    private readonly l2TtlSeconds: number;
    private readonly logger: Logger;
    private readonly source: IPrincipalGrantsLookup;
    private readonly now: () => number;

    /**
     * Identifies this process on the channel so it can ignore the echo of its
     * own broadcast — it has already applied that invalidation locally.
     */
    private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    private subscriber: ReturnType<typeof createRedisSubscriber> = null;

    /** Locally-known L2 namespace epoch, refreshed by TTL or by broadcast. */
    private epoch: number | null = null;
    private epochReadAt = 0;

    /**
     * Set when a distributed eviction failed. Until this moment passes, L2 is
     * bypassed entirely: a DEL that did not land means a stale entry may still
     * be sitting there, and serving a revoked role is worse than losing the
     * cache for a minute. The window is one L2 TTL — after that, any stale
     * entry has expired on its own.
     */
    private l2DistrustUntil = 0;

    private l2Hits = 0;
    private l2Misses = 0;
    private sourceLoads = 0;

    constructor(deps: GrantsCacheDeps) {
        this.source = deps.source;
        this.logger = deps.logger;
        this.now = deps.options?.now ?? Date.now;
        this.l2TtlSeconds = deps.options?.l2TtlSeconds ?? AUTHZ_CACHE_L2_TTL_SECONDS;
        this.l1 = new InProcessStore<PrincipalGrant[]>({
            ttlMs: deps.options?.l1TtlMs ?? AUTHZ_CACHE_L1_TTL_MS,
            maxEntries: deps.options?.l1MaxEntries ?? AUTHZ_CACHE_L1_MAX_ENTRIES,
            ...(deps.options?.now ? { now: deps.options.now } : {}),
        });
    }

    // ── Read path ───────────────────────────────────────────────────────────

    async findGrantsByUserId(userId: string): Promise<PrincipalGrant[]> {
        // L1
        const local = this.l1.get(userId);
        if (local) return local;

        // L2
        const fromRedis = await this.readL2(userId);
        if (fromRedis) {
            this.l2Hits += 1;
            this.l1.set(userId, fromRedis);
            return fromRedis;
        }
        this.l2Misses += 1;

        // L3 — source of truth.
        const grants = await this.source.findGrantsByUserId(userId);
        this.sourceLoads += 1;

        // An empty result is cached too. A user with no assignments is a
        // perfectly normal state (every buyer before their first grant), and
        // not caching it would send every one of their requests to Postgres.
        await this.writeL2(userId, grants);
        this.l1.set(userId, grants);
        return grants;
    }

    private async readL2(userId: string): Promise<PrincipalGrant[] | null> {
        const redis = getRedis();
        if (!redis) return null;
        // A failed eviction may have left a stale entry readable.
        if (this.now() < this.l2DistrustUntil) return null;
        try {
            const epoch = await this.currentEpoch(redis);
            const raw = await redis.get(this.l2Key(epoch, userId));
            return raw ? (JSON.parse(raw) as PrincipalGrant[]) : null;
        } catch (error) {
            this.logger.warn({ err: error, userId }, 'authz L2 read failed — falling through to database');
            return null;
        }
    }

    private async writeL2(userId: string, grants: PrincipalGrant[]): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            const epoch = await this.currentEpoch(redis);
            await redis.set(
                this.l2Key(epoch, userId),
                JSON.stringify(grants),
                'EX',
                this.l2TtlSeconds,
            );
        } catch (error) {
            this.logger.warn({ err: error, userId }, 'authz L2 write failed — cache skipped');
        }
    }

    // ── Invalidation ────────────────────────────────────────────────────────

    async invalidateUser(userId: string): Promise<void> {
        // Local first, so this process is correct even if Redis is down.
        this.l1.delete(userId);

        const redis = getRedis();
        if (!redis) return;
        try {
            const epoch = await this.currentEpoch(redis);
            await redis.del(this.l2Key(epoch, userId));
            await this.broadcast(redis, { type: 'user', userId, origin: this.instanceId });
        } catch (error) {
            // The DEL may not have landed, so a stale L2 entry could still be
            // readable. Stop trusting L2 here for one TTL rather than risk
            // serving it back on the next request.
            this.distrustL2();
            this.logger.error(
                { err: error, userId, distrustMs: this.l2TtlSeconds * 1000 },
                'authz cache invalidation failed — bypassing L2 until any stale entry expires',
            );
        }
    }

    async invalidateAll(reason: string): Promise<void> {
        this.l1.clear();

        const redis = getRedis();
        if (!redis) return;
        try {
            // Bumping the epoch orphans every existing L2 key in one command.
            // The old keys are unreachable immediately and expire on their own
            // TTL, so no SCAN and no blocking DEL storm.
            const epoch = await redis.incr(AUTHZ_CACHE_EPOCH_KEY);
            this.epoch = epoch;
            this.epochReadAt = this.now();
            await this.broadcast(redis, {
                type: 'all',
                epoch,
                reason,
                origin: this.instanceId,
            });
            this.logger.info({ epoch, reason }, 'authz cache flushed');
        } catch (error) {
            // The epoch bump may not have landed, so the old L2 namespace
            // could still be live and readable.
            this.distrustL2();
            this.logger.error(
                { err: error, reason, distrustMs: this.l2TtlSeconds * 1000 },
                'authz cache flush failed — bypassing L2 until stale entries expire',
            );
        }
    }

    /**
     * Bypass L2 for one TTL. Long enough that anything the failed eviction
     * left behind has expired by the time we trust it again.
     */
    private distrustL2(): void {
        this.l2DistrustUntil = this.now() + this.l2TtlSeconds * 1000;
    }

    private async broadcast(
        redis: NonNullable<ReturnType<typeof getRedis>>,
        message: InvalidationMessage,
    ): Promise<void> {
        await redis.publish(AUTHZ_CACHE_INVALIDATION_CHANNEL, JSON.stringify(message));
    }

    // ── Cross-instance L1 eviction ──────────────────────────────────────────

    /**
     * Subscribes to the invalidation channel. Call once at bootstrap; safe to
     * call again (it no-ops if already subscribed) and a no-op with no Redis.
     */
    async start(): Promise<void> {
        if (this.subscriber) return;

        const subscriber = createRedisSubscriber('authz-cache');
        if (!subscriber) {
            this.logger.info(
                'authz cache running L1-only (no REDIS_URL) — staleness bounded by the L1 TTL',
            );
            return;
        }
        this.subscriber = subscriber;

        subscriber.on('message', (channel: string, payload: string) => {
            if (channel !== AUTHZ_CACHE_INVALIDATION_CHANNEL) return;
            this.applyRemoteInvalidation(payload);
        });

        await subscriber.subscribe(AUTHZ_CACHE_INVALIDATION_CHANNEL);
        this.logger.info(
            { channel: AUTHZ_CACHE_INVALIDATION_CHANNEL, instanceId: this.instanceId },
            'authz cache subscribed to invalidation broadcasts',
        );
    }

    /** Exposed for tests and for the pub/sub handler. */
    applyRemoteInvalidation(payload: string): void {
        let message: InvalidationMessage;
        try {
            message = JSON.parse(payload) as InvalidationMessage;
        } catch (error) {
            this.logger.warn({ err: error, payload }, 'unparseable authz invalidation message');
            return;
        }

        // Our own echo — already applied locally before publishing.
        if (message.origin === this.instanceId) return;

        if (message.type === 'user') {
            this.l1.delete(message.userId);
            return;
        }

        this.l1.clear();
        // Adopt the new epoch immediately so this instance stops reading the
        // orphaned L2 namespace without waiting for its epoch TTL.
        this.epoch = message.epoch;
        this.epochReadAt = this.now();
    }

    async stop(): Promise<void> {
        if (!this.subscriber) return;
        const subscriber = this.subscriber;
        this.subscriber = null;
        try {
            await subscriber.quit();
        } catch (error) {
            this.logger.warn({ err: error }, 'authz cache subscriber shutdown failed');
        }
    }

    // ── Epoch ───────────────────────────────────────────────────────────────

    /**
     * The L2 namespace epoch, memoised briefly so a warm path costs at most
     * one extra GET every AUTHZ_CACHE_EPOCH_TTL_MS. Broadcasts keep it fresher
     * than that in practice; the TTL is what covers a missed broadcast.
     */
    private async currentEpoch(
        redis: NonNullable<ReturnType<typeof getRedis>>,
    ): Promise<number> {
        if (this.epoch !== null && this.now() - this.epochReadAt < AUTHZ_CACHE_EPOCH_TTL_MS) {
            return this.epoch;
        }
        const raw = await redis.get(AUTHZ_CACHE_EPOCH_KEY);
        const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
        this.epoch = Number.isFinite(parsed) ? parsed : 0;
        this.epochReadAt = this.now();
        return this.epoch;
    }

    private l2Key(epoch: number, userId: string): string {
        return `${AUTHZ_CACHE_KEY_PREFIX}:${epoch}:${userId}`;
    }

    // ── Observability ───────────────────────────────────────────────────────

    stats(): GrantsCacheStats {
        return {
            l1: this.l1.stats(),
            l2Hits: this.l2Hits,
            l2Misses: this.l2Misses,
            sourceLoads: this.sourceLoads,
            epoch: this.epoch,
            l2Trusted: this.now() >= this.l2DistrustUntil,
            redisAvailable: getRedis() !== null,
            subscribed: this.subscriber !== null,
        };
    }
}

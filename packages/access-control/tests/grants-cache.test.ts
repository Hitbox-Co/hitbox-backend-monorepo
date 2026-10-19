// Redis is mocked so these tests exercise the layering logic, not ioredis.
// `redisMock` starts as null, which is the "REDIS_URL unset" case.
let redisMock: MockRedis | null = null;
let subscriberMock: MockSubscriber | null = null;

jest.mock('@hitbox/shared', () => {
    const actual = jest.requireActual('@hitbox/shared');
    return {
        ...actual,
        getRedis: () => redisMock,
        createRedisSubscriber: () => subscriberMock,
    };
});

import { LayeredGrantsCache } from '../src/cache/grants-cache';
import { InProcessStore } from '../src/cache/in-process-store';
import { AUTHZ_CACHE_EPOCH_KEY } from '../src/constants/access-control.constant';
import type { PrincipalGrant } from '../src/domain/interfaces/principal-grants.interface';
import { USER, OTHER_USER, grantsForRole } from './helpers';

/** Minimal in-memory stand-in for the commands the cache actually uses. */
class MockRedis {
    store = new Map<string, string>();
    published: { channel: string; payload: string }[] = [];
    failNext = false;

    private guard() {
        if (this.failNext) {
            this.failNext = false;
            throw new Error('redis exploded');
        }
    }

    async get(key: string): Promise<string | null> {
        this.guard();
        return this.store.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<'OK'> {
        this.guard();
        this.store.set(key, value);
        return 'OK';
    }
    async del(key: string): Promise<number> {
        this.guard();
        return this.store.delete(key) ? 1 : 0;
    }
    async incr(key: string): Promise<number> {
        this.guard();
        const next = Number.parseInt(this.store.get(key) ?? '0', 10) + 1;
        this.store.set(key, String(next));
        return next;
    }
    async publish(channel: string, payload: string): Promise<number> {
        this.guard();
        this.published.push({ channel, payload });
        return 1;
    }
}

class MockSubscriber {
    handlers: ((channel: string, payload: string) => void)[] = [];
    channels: string[] = [];
    quitCalled = false;

    on(event: string, handler: (channel: string, payload: string) => void): void {
        if (event === 'message') this.handlers.push(handler);
    }
    async subscribe(channel: string): Promise<number> {
        this.channels.push(channel);
        return 1;
    }
    async quit(): Promise<'OK'> {
        this.quitCalled = true;
        return 'OK';
    }
    /** Simulate a broadcast arriving from another instance. */
    emit(channel: string, payload: string): void {
        for (const handler of this.handlers) handler(channel, payload);
    }
}

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
} as unknown as Parameters<typeof LayeredGrantsCache.prototype.constructor>[0]['logger'];

/** A clock the tests advance by hand instead of sleeping. */
function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeSource(grants: PrincipalGrant[] = grantsForRole('HITBOX_SUPPORT')) {
    const findGrantsByUserId = jest.fn().mockResolvedValue(grants);
    return { source: { findGrantsByUserId }, findGrantsByUserId, grants };
}

beforeEach(() => {
    redisMock = null;
    subscriberMock = null;
    jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// L1 store
// ────────────────────────────────────────────────────────────────────────────

describe('L1 in-process store', () => {
    it('returns a value before its TTL and forgets it after', () => {
        const clock = makeClock();
        const store = new InProcessStore<string>({ ttlMs: 1_000, maxEntries: 10, now: clock.now });

        store.set('a', 'value');
        expect(store.get('a')).toBe('value');

        clock.advance(999);
        expect(store.get('a')).toBe('value');

        clock.advance(2);
        expect(store.get('a')).toBeUndefined();
        expect(store.stats().expirations).toBe(1);
    });

    it('is bounded — evicting the least recently used entry', () => {
        const store = new InProcessStore<number>({ ttlMs: 60_000, maxEntries: 3 });
        store.set('a', 1);
        store.set('b', 2);
        store.set('c', 3);

        // Touch 'a' so 'b' becomes the least recently used.
        expect(store.get('a')).toBe(1);
        store.set('d', 4);

        expect(store.size).toBe(3);
        expect(store.get('b')).toBeUndefined();
        expect(store.get('a')).toBe(1);
        expect(store.get('d')).toBe(4);
        expect(store.stats().evictions).toBe(1);
    });

    it('never grows past maxEntries under sustained inserts', () => {
        const store = new InProcessStore<number>({ ttlMs: 60_000, maxEntries: 50 });
        for (let i = 0; i < 5_000; i += 1) store.set(`user_${i}`, i);
        expect(store.size).toBe(50);
    });

    it('clear() empties it', () => {
        const store = new InProcessStore<number>({ ttlMs: 60_000, maxEntries: 10 });
        store.set('a', 1);
        store.clear();
        expect(store.size).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Layering
// ────────────────────────────────────────────────────────────────────────────

describe('read path walks L1 → L2 → source', () => {
    it('hits the source once, then serves from L1', async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        const first = await cache.findGrantsByUserId(USER);
        const second = await cache.findGrantsByUserId(USER);
        const third = await cache.findGrantsByUserId(USER);

        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(cache.stats().l1.hits).toBe(2);
        expect(cache.stats().sourceLoads).toBe(1);
    });

    it('keys per user rather than sharing one entry', async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);

        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
        expect(findGrantsByUserId).toHaveBeenCalledWith(USER);
        expect(findGrantsByUserId).toHaveBeenCalledWith(OTHER_USER);
    });

    it('re-reads the source once L1 expires', async () => {
        const clock = makeClock();
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({
            source,
            logger,
            options: { l1TtlMs: 5_000, now: clock.now },
        });

        await cache.findGrantsByUserId(USER);
        clock.advance(5_001);
        await cache.findGrantsByUserId(USER);

        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
    });

    it('serves a cold L1 from L2 without touching the source', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId, grants } = makeSource();

        // Instance A populates L2.
        const instanceA = new LayeredGrantsCache({ source, logger });
        await instanceA.findGrantsByUserId(USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);

        // Instance B starts cold but shares Redis.
        const instanceB = new LayeredGrantsCache({ source, logger });
        const fromL2 = await instanceB.findGrantsByUserId(USER);

        expect(fromL2).toEqual(grants);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(1); // no extra DB hit
        expect(instanceB.stats().l2Hits).toBe(1);
        expect(instanceB.stats().sourceLoads).toBe(0);
    });

    it('back-fills L1 from an L2 hit, so the next read is local', async () => {
        redisMock = new MockRedis();
        const { source } = makeSource();
        const warm = new LayeredGrantsCache({ source, logger });
        await warm.findGrantsByUserId(USER);

        const cold = new LayeredGrantsCache({ source, logger });
        await cold.findGrantsByUserId(USER);
        await cold.findGrantsByUserId(USER);

        expect(cold.stats().l2Hits).toBe(1);
        expect(cold.stats().l1.hits).toBe(1);
    });

    it('caches an empty grant set — a user with no roles is normal', async () => {
        const { source, findGrantsByUserId } = makeSource([]);
        const cache = new LayeredGrantsCache({ source, logger });

        expect(await cache.findGrantsByUserId(USER)).toEqual([]);
        expect(await cache.findGrantsByUserId(USER)).toEqual([]);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);
    });

    it('round-trips grants through L2 without losing fields', async () => {
        redisMock = new MockRedis();
        const grants = grantsForRole('BRAND_ADMIN');
        const { source } = makeSource(grants);

        await new LayeredGrantsCache({ source, logger }).findGrantsByUserId(USER);
        const restored = await new LayeredGrantsCache({ source, logger }).findGrantsByUserId(USER);

        expect(restored).toEqual(grants);
        expect(restored[0]?.assignmentScopeId).toBe(grants[0]?.assignmentScopeId);
        expect(restored[0]?.fieldAllowlist).toEqual(grants[0]?.fieldAllowlist);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Invalidation
// ────────────────────────────────────────────────────────────────────────────

describe('per-user invalidation', () => {
    it('forces a fresh source read for that user only', async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);

        await cache.invalidateUser(USER);

        await cache.findGrantsByUserId(USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(3);

        // The other user's entry survived.
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(3);
    });

    it('deletes the L2 entry as well, so another instance cannot serve it', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId } = makeSource();

        const instanceA = new LayeredGrantsCache({ source, logger });
        await instanceA.findGrantsByUserId(USER);
        await instanceA.invalidateUser(USER);

        const instanceB = new LayeredGrantsCache({ source, logger });
        await instanceB.findGrantsByUserId(USER);

        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
        expect(instanceB.stats().l2Hits).toBe(0);
    });

    it('broadcasts so other instances drop their L1', async () => {
        redisMock = new MockRedis();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.invalidateUser(USER);

        expect(redisMock.published).toHaveLength(1);
        const message = JSON.parse(redisMock.published[0]!.payload);
        expect(message).toMatchObject({ type: 'user', userId: USER });
    });
});

describe('full flush via the epoch counter', () => {
    it('makes every user re-read from the source', async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);

        await cache.invalidateAll('role edited');

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(4);
    });

    it('bumps the shared epoch instead of scanning for keys', async () => {
        redisMock = new MockRedis();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        const keysBefore = [...redisMock.store.keys()].filter((k) => k.includes(USER));
        expect(keysBefore).toHaveLength(1);

        await cache.invalidateAll('catalog synced');

        expect(redisMock.store.get(AUTHZ_CACHE_EPOCH_KEY)).toBe('1');
        // Old key still physically present but now unreachable — it expires on
        // its own TTL rather than needing a blocking DEL storm.
        expect(redisMock.store.has(keysBefore[0]!)).toBe(true);
    });

    it('orphans the old L2 namespace so a cold instance cannot read it', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId } = makeSource();

        const instanceA = new LayeredGrantsCache({ source, logger });
        await instanceA.findGrantsByUserId(USER);
        await instanceA.invalidateAll('role edited');

        const instanceB = new LayeredGrantsCache({ source, logger });
        await instanceB.findGrantsByUserId(USER);

        expect(instanceB.stats().l2Hits).toBe(0);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-instance L1 eviction
// ────────────────────────────────────────────────────────────────────────────

describe('pub/sub keeps L1 honest across instances', () => {
    it('subscribes to the invalidation channel on start', async () => {
        redisMock = new MockRedis();
        subscriberMock = new MockSubscriber();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.start();

        expect(subscriberMock.channels).toEqual(['authz:grants:invalidate']);
        expect(cache.stats().subscribed).toBe(true);
    });

    it("drops a user's L1 entry when another instance revokes their role", async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);

        cache.applyRemoteInvalidation(
            JSON.stringify({ type: 'user', userId: USER, origin: 'another-instance' }),
        );

        await cache.findGrantsByUserId(USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
    });

    it('clears all of L1 on a remote flush', async () => {
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);

        cache.applyRemoteInvalidation(
            JSON.stringify({ type: 'all', epoch: 7, reason: 'role edited', origin: 'other' }),
        );

        await cache.findGrantsByUserId(USER);
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(4);
        expect(cache.stats().epoch).toBe(7);
    });

    it('ignores the echo of its own broadcast', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(OTHER_USER);
        await cache.invalidateUser(USER);

        // Replay our own message, as Redis pub/sub delivers to the publisher too.
        const own = redisMock.published[0]!.payload;
        cache.applyRemoteInvalidation(own);

        // OTHER_USER's entry must survive — the echo changed nothing.
        await cache.findGrantsByUserId(OTHER_USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);
    });

    it('survives a malformed broadcast without throwing', () => {
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });
        expect(() => cache.applyRemoteInvalidation('not json{')).not.toThrow();
    });

    it('releases the subscriber on stop', async () => {
        redisMock = new MockRedis();
        subscriberMock = new MockSubscriber();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.start();
        await cache.stop();

        expect(subscriberMock.quitCalled).toBe(true);
        expect(cache.stats().subscribed).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Degradation
// ────────────────────────────────────────────────────────────────────────────

describe('degrades to the layer below, never to "allow"', () => {
    it('works L1-only when REDIS_URL is unset', async () => {
        redisMock = null;
        const { source, findGrantsByUserId, grants } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        expect(await cache.findGrantsByUserId(USER)).toEqual(grants);
        expect(await cache.findGrantsByUserId(USER)).toEqual(grants);

        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);
        expect(cache.stats().redisAvailable).toBe(false);
    });

    it('start() is a no-op with no Redis', async () => {
        redisMock = null;
        subscriberMock = null;
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await expect(cache.start()).resolves.toBeUndefined();
        expect(cache.stats().subscribed).toBe(false);
    });

    it('falls through to the source when an L2 read throws', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId, grants } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        redisMock.failNext = true;
        const result = await cache.findGrantsByUserId(USER);

        // Correct data, from Postgres, despite Redis failing.
        expect(result).toEqual(grants);
        expect(findGrantsByUserId).toHaveBeenCalled();
    });

    it('still evicts L1 when the Redis side of an invalidation fails', async () => {
        redisMock = new MockRedis();
        const { source, findGrantsByUserId } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        await cache.findGrantsByUserId(USER);
        expect(cache.stats().l2Trusted).toBe(true);

        redisMock.failNext = true;
        await cache.invalidateUser(USER);

        // The DEL never landed, so a stale L2 entry is still sitting there.
        // The cache must stop trusting L2 rather than serve it back.
        expect(cache.stats().l2Trusted).toBe(false);

        await cache.findGrantsByUserId(USER);
        expect(findGrantsByUserId).toHaveBeenCalledTimes(2);
        expect(cache.stats().l2Hits).toBe(0);
    });

    it('resumes trusting L2 once any stale entry would have expired', async () => {
        redisMock = new MockRedis();
        const clock = makeClock();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({
            source,
            logger,
            options: { l2TtlSeconds: 60, now: clock.now },
        });

        redisMock.failNext = true;
        await cache.invalidateUser(USER);
        expect(cache.stats().l2Trusted).toBe(false);

        clock.advance(60_001);
        expect(cache.stats().l2Trusted).toBe(true);
    });

    it('distrusts L2 when a full flush fails to land', async () => {
        redisMock = new MockRedis();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        redisMock.failNext = true;
        await cache.invalidateAll('role edited');

        expect(cache.stats().l2Trusted).toBe(false);
    });

    it('does not reject the caller when invalidation fails', async () => {
        redisMock = new MockRedis();
        const { source } = makeSource();
        const cache = new LayeredGrantsCache({ source, logger });

        redisMock.failNext = true;
        await expect(cache.invalidateUser(USER)).resolves.toBeUndefined();

        redisMock.failNext = true;
        await expect(cache.invalidateAll('x')).resolves.toBeUndefined();
    });
});

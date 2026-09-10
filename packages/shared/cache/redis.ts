import Redis from 'ioredis';
import { env } from '../config/env';
import { createModuleLogger } from '../logger';

/**
 * Lazily-created shared ioredis client. Returns null when REDIS_URL is unset
 * so callers (e.g. the rate limiter) can fall back to an in-memory strategy.
 * Never connects at import time — safe to import in unit tests.
 */
const logger = createModuleLogger('redis');
let client: Redis | null = null;

export function getRedis(): Redis | null {
    if (!env.REDIS_URL) return null;
    if (client) return client;

    client = new Redis(env.REDIS_URL, {
        // Rate-limiter commands should fail fast rather than queue forever.
        maxRetriesPerRequest: 3,
    });
    client.on('error', (err: unknown) => logger.error({ err }, 'redis connection error'));
    client.on('connect', () => logger.info('redis connected'));
    return client;
}

/**
 * A dedicated connection for pub/sub subscriptions.
 *
 * Redis puts a connection into subscriber mode once it SUBSCRIBEs, after
 * which it can no longer run normal commands — so a subscriber must never
 * share the client returned by `getRedis()`. Returns null when REDIS_URL is
 * unset, exactly like `getRedis()`, so callers degrade instead of failing.
 *
 * The caller owns the returned connection and should `quit()` it on shutdown.
 */
export function createRedisSubscriber(name: string): Redis | null {
    const primary = getRedis();
    if (!primary) return null;

    const subscriber = primary.duplicate();
    subscriber.on('error', (err: unknown) =>
        logger.error({ err, subscriber: name }, 'redis subscriber error'),
    );
    return subscriber;
}

export type { Redis };

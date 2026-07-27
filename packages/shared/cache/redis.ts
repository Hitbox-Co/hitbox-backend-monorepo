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

export type { Redis };

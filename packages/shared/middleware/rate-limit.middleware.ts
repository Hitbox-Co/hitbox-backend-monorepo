import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { AppError } from '../errors/app-error';
import { createModuleLogger } from '../logger';
import { getRedis } from '../cache/redis';

const logger = createModuleLogger('rate-limit');

export interface RateLimiterOptions {
    /** Defaults to env.RATE_LIMIT_WINDOW_MS. */
    windowMs?: number;
    /** Max requests per window per client. Defaults to env.RATE_LIMIT_MAX. */
    max?: number;
    /** Bucket name, keeps separate limiters apart in Redis (e.g. 'api', 'auth'). */
    prefix?: string;
}

/**
 * Fixed-window rate limiter, keyed per client IP.
 *
 * With REDIS_URL set the window is shared across every backend instance
 * (correct once horizontally scaled); without it, each instance keeps its own
 * in-memory window. Over-limit requests get the standard 429 error envelope
 * (`RATE_LIMITED`) and `RateLimit-*` response headers advertise the budget.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RequestHandler {
    const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
    const max = options.max ?? env.RATE_LIMIT_MAX;
    const redis = getRedis();

    if (redis) {
        logger.info({ windowMs, max, prefix: options.prefix ?? 'api' }, 'rate limiter using redis store');
    } else {
        logger.warn({ windowMs, max }, 'REDIS_URL not set — rate limiter using in-memory store (per instance)');
    }

    return rateLimit({
        windowMs,
        limit: max,
        standardHeaders: true, // RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
        legacyHeaders: false,
        ...(redis
            ? {
                store: new RedisStore({
                    prefix: `rl:${options.prefix ?? 'api'}:`,
                    sendCommand: (...args: string[]) =>
                        (redis.call as (...a: string[]) => Promise<any>)(...args),
                }),
            }
            : {}),
        handler: (_req, _res, next) => {
            next(AppError.tooManyRequests());
        },
    });
}

import { createHash } from 'node:crypto';
import { createModuleLogger, getRedis } from '@hitbox/shared';
import {
    PRODUCT_CACHE_ENTITY_TTL_SECONDS,
    PRODUCT_CACHE_KEY_PREFIX,
    PRODUCT_CACHE_LIST_TTL_SECONDS,
    PRODUCTS_MODULE,
} from '../constants/products.constant';

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

const logger = createModuleLogger(`${PRODUCTS_MODULE}:cache`);

const LIST_VERSION_KEY = `${PRODUCT_CACHE_KEY_PREFIX}:list:version`;

/** Deterministic, order-stable digest for an arbitrary query/params object. */
function hashInput(input: unknown): string {
    return createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

/**
 * Cache-aside layer for the products repository.
 *
 * - Entity reads (`getEntity`/`setEntity`) are keyed by id or productCode and
 *   invalidated directly (`invalidateEntity`) after a write to that row.
 * - List/section reads (`getList`/`setList` — catalog, discover, marketplace)
 *   are keyed by a hash of their query params PLUS a shared version counter.
 *   Any mutation bumps that counter (`invalidateLists`), which invalidates
 *   every cached list variant in one O(1) call — avoids SCAN/KEYS pattern
 *   deletion, which is slow and blocks a production Redis.
 *
 * Every method degrades to a no-op (cache miss on read, skipped write) when
 * REDIS_URL isn't configured or a Redis call fails — caching is purely an
 * optimization here, never a hard dependency. Callers always fall back to
 * the database.
 */
export class ProductCache {
    async getEntity<T>(scope: 'id' | 'code', key: string): Promise<T | null> {
        const redis = getRedis();
        if (!redis) return null;
        try {
            const raw = await redis.get(this.entityKey(scope, key));
            return raw ? (JSON.parse(raw) as T) : null;
        } catch (error) {
            logger.warn({ err: error }, 'cache read failed — falling back to database');
            return null;
        }
    }

    async setEntity(scope: 'id' | 'code', key: string, value: unknown): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            await redis.set(
                this.entityKey(scope, key),
                JSON.stringify(value),
                'EX',
                PRODUCT_CACHE_ENTITY_TTL_SECONDS,
            );
        } catch (error) {
            logger.warn({ err: error }, 'cache write failed');
        }
    }

    /** Drops both lookup keys for one product — call after any mutation to it. */
    async invalidateEntity(id: string, productCode?: string | null): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            const keys = [this.entityKey('id', id)];
            if (productCode) keys.push(this.entityKey('code', productCode));
            await redis.del(...keys);
        } catch (error) {
            logger.warn({ err: error }, 'cache invalidation failed');
        }
    }

    /** `namespace` separates unrelated sections (e.g. 'catalog', 'discover', 'marketplace'). */
    async getList<T>(namespace: string, query: unknown): Promise<T | null> {
        const redis = getRedis();
        if (!redis) return null;
        try {
            const version = await this.currentListVersion(redis);
            const raw = await redis.get(this.listKey(namespace, version, query));
            return raw ? (JSON.parse(raw) as T) : null;
        } catch (error) {
            logger.warn({ err: error }, 'cache read failed — falling back to database');
            return null;
        }
    }

    async setList(namespace: string, query: unknown, value: unknown): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            const version = await this.currentListVersion(redis);
            await redis.set(
                this.listKey(namespace, version, query),
                JSON.stringify(value),
                'EX',
                PRODUCT_CACHE_LIST_TTL_SECONDS,
            );
        } catch (error) {
            logger.warn({ err: error }, 'cache write failed');
        }
    }

    /**
     * Invalidates every cached list/section result across all namespaces in
     * one call by bumping the shared version counter.
     */
    async invalidateLists(): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            await redis.incr(LIST_VERSION_KEY);
        } catch (error) {
            logger.warn({ err: error }, 'cache invalidation failed');
        }
    }

    private async currentListVersion(redis: RedisClient): Promise<number> {
        const raw = await redis.get(LIST_VERSION_KEY);
        return raw ? Number(raw) : 0;
    }

    private entityKey(scope: 'id' | 'code', key: string): string {
        return `${PRODUCT_CACHE_KEY_PREFIX}:entity:${scope}:${key}`;
    }

    private listKey(namespace: string, version: number, query: unknown): string {
        return `${PRODUCT_CACHE_KEY_PREFIX}:list:${namespace}:${version}:${hashInput(query)}`;
    }
}

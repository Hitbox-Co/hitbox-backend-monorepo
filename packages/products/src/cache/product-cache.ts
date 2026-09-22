import { createHash } from 'node:crypto';
import { Prisma } from '@hitbox/database';
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
 * JSON round-tripping loses every non-primitive type Prisma returns.
 *
 * `JSON.stringify(new Date())` produces a plain ISO **string**, and
 * `Prisma.Decimal` serializes to a numeric **string** — so a row read from
 * Redis is not the same shape as the row read from Postgres, even though both
 * are typed `ProductWithRelations`. The symptom is a 500 far from the cause:
 *
 *     TypeError: product.releaseStart?.toISOString is not a function
 *
 * …on any request that happened to hit a warm cache, and never on a cold one.
 * Types cannot catch it because the cast at the `JSON.parse` boundary asserts
 * a shape nobody verified.
 *
 * So values are tagged on the way in and rebuilt on the way out. Tagging
 * beats sniffing ISO-shaped strings on read: a legitimate string field that
 * merely *looks* like a timestamp would otherwise be silently converted to a
 * Date, which is the same class of bug pointing the other way.
 */
const DATE_TAG = '$date';
const DECIMAL_TAG = '$decimal';

export function serialise(value: unknown): string {
    // `toJSON` runs BEFORE a replacer, so by the time this is called a Date has
    // already collapsed to a string. `this[key]` is the untouched original —
    // which is the only way to see what the value really was.
    return JSON.stringify(value, function replacer(this: Record<string, unknown>, key, parsed) {
        const original = this[key];
        if (original instanceof Date) {
            return { [DATE_TAG]: original.toISOString() };
        }
        if (Prisma.Decimal.isDecimal(original)) {
            return { [DECIMAL_TAG]: original.toString() };
        }
        return parsed;
    });
}

export function deserialise<T>(raw: string): T {
    return JSON.parse(raw, (_key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const tagged = value as Record<string, unknown>;
            if (typeof tagged[DATE_TAG] === 'string') return new Date(tagged[DATE_TAG]);
            if (typeof tagged[DECIMAL_TAG] === 'string') {
                return new Prisma.Decimal(tagged[DECIMAL_TAG]);
            }
        }
        return value;
    }) as T;
}

/**
 * Cache-aside layer for the products repository.
 *
 * - Entity reads (`getEntity`/`setEntity`) are keyed by id or groupCode and
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
            return raw ? deserialise<T>(raw) : null;
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
                serialise(value),
                'EX',
                PRODUCT_CACHE_ENTITY_TTL_SECONDS,
            );
        } catch (error) {
            logger.warn({ err: error }, 'cache write failed');
        }
    }

    /** Drops both lookup keys for one product — call after any mutation to it. */
    async invalidateEntity(id: string, groupCode?: string | null): Promise<void> {
        const redis = getRedis();
        if (!redis) return;
        try {
            const keys = [this.entityKey('id', id)];
            if (groupCode) keys.push(this.entityKey('code', groupCode));
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
            return raw ? deserialise<T>(raw) : null;
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
                serialise(value),
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

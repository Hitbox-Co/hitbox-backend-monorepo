/**
 * L1 — a bounded, TTL'd, in-process key/value store.
 *
 * No dependencies and no network: this is the layer that makes a permission
 * check cost nothing on a warm path. Two properties matter for using it to
 * cache authorization data:
 *
 *  • **Bounded.** An unbounded per-user map is a memory leak the size of your
 *    user table. Least-recently-used entries are evicted past `maxEntries`.
 *  • **Short-lived.** The TTL is the worst-case staleness window if an
 *    invalidation broadcast is ever missed, so it is deliberately seconds,
 *    not minutes. Invalidation is the primary mechanism; TTL is the backstop.
 */

interface Entry<V> {
    value: V;
    /** Epoch millis after which the entry is dead. */
    expiresAt: number;
}

export interface InProcessStoreOptions {
    ttlMs: number;
    maxEntries: number;
    /** Injectable clock — tests advance time without sleeping. */
    now?: () => number;
}

export class InProcessStore<V> {
    /**
     * Map iteration order is insertion order, which is what makes the LRU
     * work: a read re-inserts its key to move it to the back, so the front is
     * always the least recently used.
     */
    private readonly entries = new Map<string, Entry<V>>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;

    private hits = 0;
    private misses = 0;
    private evictions = 0;
    private expirations = 0;

    constructor(options: InProcessStoreOptions) {
        this.ttlMs = options.ttlMs;
        this.maxEntries = options.maxEntries;
        this.now = options.now ?? Date.now;
    }

    get(key: string): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }

        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            this.expirations += 1;
            this.misses += 1;
            return undefined;
        }

        // Touch: move to the back of the LRU order.
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.hits += 1;
        return entry.value;
    }

    set(key: string, value: V): void {
        // Delete first so a re-set moves the key to the back rather than
        // keeping its original position.
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value);
            this.evictions += 1;
        }
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }

    stats(): {
        size: number;
        hits: number;
        misses: number;
        evictions: number;
        expirations: number;
    } {
        return {
            size: this.entries.size,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expirations: this.expirations,
        };
    }

    resetStats(): void {
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.expirations = 0;
    }
}

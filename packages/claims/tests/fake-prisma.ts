import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';

/**
 * An in-memory stand-in for the slice of Prisma the claims repository uses.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * This repo has no integration-test database harness — no testcontainers, no
 * TEST_DATABASE_URL, nothing. So the choice was between testing the claim
 * transaction against a fake and not testing it at all.
 *
 * What the fake reproduces faithfully, because the tests turn on it:
 *
 *   * `updateMany` is a compare-and-swap. It matches rows against the whole
 *     `where` and reports how many it changed, which is exactly the property
 *     both the token burn and the SKU flip rely on.
 *   * `$transaction` rolls back. A throw inside restores every table to its
 *     state at the start, which is what makes "a rejected token changes
 *     nothing" and "a retried claim-code collision sees the token as ISSUED"
 *     real assertions rather than wishes.
 *   * Every operation is genuinely async, so two transactions driven through
 *     `Promise.all` interleave at each await.
 *
 * What it does NOT reproduce, and what the race test therefore cannot prove:
 *
 *   * Row locking, MVCC, isolation levels, `SELECT … FOR UPDATE`. A single
 *     JS operation here is atomic because the event loop makes it so, not
 *     because the database does. Postgres could still serialise these two
 *     transactions differently.
 *   * Rollback during concurrency. The snapshot/restore is whole-store, so a
 *     transaction that rolls back while another is mid-flight would erase the
 *     other's writes. No test does both at once; do not write one that does.
 *
 * So the race test below shows the *application* logic handles exactly one
 * winner. It does not show Postgres does. That needs a real database, and it
 * is the one gap in this suite worth closing first.
 */

type Row = Record<string, any>;

interface Store {
    sku: Row[];
    user: Row[];
    drop: Row[];
    claimToken: Row[];
    skuClaim: Row[];
    blockchainLedger: Row[];
    skuHistory: Row[];
    buyerCollection: Row[];
}

const TABLES: (keyof Store)[] = [
    'sku',
    'user',
    'drop',
    'claimToken',
    'skuClaim',
    'blockchainLedger',
    'skuHistory',
    'buyerCollection',
];

/** Yields to the event loop, so concurrent transactions actually interleave. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Matches one row against a Prisma-style `where`, including `gt`/`lt`/`in`. */
function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
        const value = row[key];
        if (condition === null) return value === null || value === undefined;
        if (condition instanceof Date) return value?.getTime?.() === condition.getTime();
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            return Object.entries(condition).every(([op, operand]) => {
                switch (op) {
                    case 'gt':
                        return value != null && value > operand;
                    case 'gte':
                        return value != null && value >= operand;
                    case 'lt':
                        return value != null && value < operand;
                    case 'lte':
                        return value != null && value <= operand;
                    case 'not':
                        return value !== operand;
                    case 'in':
                        return (operand as unknown[]).includes(value);
                    default:
                        throw new Error(`fake-prisma: unsupported operator ${op}`);
                }
            });
        }
        return value === condition;
    });
}

/** Applies a Prisma-style `data`, including `{ increment: n }`. */
function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'increment' in value) {
            row[key] = (row[key] ?? 0) + (value as { increment: number }).increment;
        } else {
            row[key] = value;
        }
    }
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    if (!orderBy) return rows;
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
        for (const clause of clauses) {
            for (const [key, direction] of Object.entries(clause)) {
                const av = a[key];
                const bv = b[key];
                if (av === bv) continue;
                const less = av < bv ? -1 : 1;
                return direction === 'desc' ? -less : less;
            }
        }
        return 0;
    });
}

export interface FakePrismaOptions {
    /**
     * Fires before each `skuClaim.create`. Throw from it to simulate a
     * claimCode unique-constraint collision — the retry path depends on the
     * transaction rolling back around exactly that.
     */
    onSkuClaimCreate?: (attempt: number) => void;
}

export class FakePrisma {
    readonly store: Store = {
        sku: [],
        user: [],
        drop: [],
        claimToken: [],
        skuClaim: [],
        blockchainLedger: [],
        skuHistory: [],
        buyerCollection: [],
    };

    /** Set while a transaction is open, so nested $transaction calls flatten. */
    private inTransaction = false;
    private skuClaimCreateCount = 0;

    constructor(private readonly options: FakePrismaOptions = {}) { }

    asPrisma(): PrismaClient {
        return this as unknown as PrismaClient;
    }

    // ── transactions ──────────────────────────────────────────────────────

    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        // Already inside one: join it rather than nesting a second snapshot,
        // which is how Prisma's interactive transactions behave when a
        // repository method is called from within another's callback.
        if (this.inTransaction) return fn(this);

        const snapshot = this.snapshot();
        this.inTransaction = true;
        try {
            return await fn(this);
        } catch (error) {
            this.restore(snapshot);
            throw error;
        } finally {
            this.inTransaction = false;
        }
    }

    private snapshot(): Store {
        const copy = {} as Store;
        for (const table of TABLES) {
            copy[table] = this.store[table].map((row) => ({ ...row }));
        }
        return copy;
    }

    private restore(snapshot: Store): void {
        for (const table of TABLES) {
            this.store[table].length = 0;
            this.store[table].push(...snapshot[table].map((row) => ({ ...row })));
        }
    }

    // ── sku ───────────────────────────────────────────────────────────────

    readonly sku = {
        findUnique: async ({ where }: { where: Row; include?: Row }): Promise<Row | null> => {
            await tick();
            const row = this.store.sku.find((s) => matches(s, where));
            return row ? this.hydrateSku(row) : null;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const hits = this.store.sku.filter((s) => matches(s, where));
            hits.forEach((row) => applyData(row, data));
            return { count: hits.length };
        },
    };

    /** Assembles the `skuByTagInclude` shape the repository asks for. */
    private hydrateSku(sku: Row): Row {
        const drop = this.store.drop.find((d) => d.id === sku.productId) ?? {};
        const owner = sku.ownerId
            ? (this.store.user.find((u) => u.id === sku.ownerId) ?? null)
            : null;
        const skuClaims = sortRows(
            this.store.skuClaim.filter((c) => c.skuId === sku.id),
            { claimedNo: 'desc' },
        )
            .slice(0, 1)
            .map((c) => ({ claimedAt: c.claimedAt }));
        return {
            ...sku,
            owner: owner ? { id: owner.id, handle: owner.handle, fullName: owner.fullName } : null,
            drop: {
                id: drop.id,
                groupCode: drop.groupCode,
                name: drop.name,
                status: drop.status,
                collectionId: drop.collectionId ?? null,
                collection: drop.collection ?? null,
                dropImages: [],
                dropPrices: drop.dropPrices ?? [],
            },
            skuClaims,
        };
    }

    // ── user ──────────────────────────────────────────────────────────────

    readonly user = {
        findUnique: async ({ where }: { where: Row }) => {
            await tick();
            return this.store.user.find((u) => matches(u, where)) ?? null;
        },
    };

    // ── claimToken ────────────────────────────────────────────────────────

    readonly claimToken = {
        create: async ({ data, select }: { data: Row; select?: Row }) => {
            await tick();
            const row: Row = {
                id: randomUUID(),
                status: 'ISSUED',
                consumedAt: null,
                claimId: null,
                replayCount: 0,
                lastReplayAt: null,
                requestId: null,
                ...data,
            };
            this.store.claimToken.push(row);
            return select ? pick(row, select) : row;
        },
        findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
            await tick();
            const row = this.store.claimToken.find((t) => matches(t, where));
            if (!row) return null;
            return select ? pick(row, select) : row;
        },
        findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
            await tick();
            return sortRows(this.store.claimToken.filter((t) => matches(t, where)), orderBy)[0] ?? null;
        },
        findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
            await tick();
            return sortRows(this.store.claimToken.filter((t) => matches(t, where)), orderBy);
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const row = this.store.claimToken.find((t) => matches(t, where));
            if (!row) {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                    code: 'P2025',
                    clientVersion: 'test',
                });
            }
            applyData(row, data);
            return row;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const hits = this.store.claimToken.filter((t) => matches(t, where));
            hits.forEach((row) => applyData(row, data));
            return { count: hits.length };
        },
    };

    // ── skuClaim ──────────────────────────────────────────────────────────

    readonly skuClaim = {
        count: async ({ where }: { where?: Row } = {}) => {
            await tick();
            return this.store.skuClaim.filter((c) => matches(c, where)).length;
        },
        create: async ({ data }: { data: Row }) => {
            await tick();
            this.skuClaimCreateCount += 1;
            this.options.onSkuClaimCreate?.(this.skuClaimCreateCount);
            const row = { revokedAt: null, revokedReason: null, ...data };
            this.store.skuClaim.push(row);
            return row;
        },
        findUnique: async ({ where }: { where: Row }) => {
            await tick();
            return this.store.skuClaim.find((c) => matches(c, where)) ?? null;
        },
        findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
            await tick();
            return sortRows(this.store.skuClaim.filter((c) => matches(c, where)), orderBy)[0] ?? null;
        },
        findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
            await tick();
            return sortRows(this.store.skuClaim.filter((c) => matches(c, where)), orderBy);
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const hits = this.store.skuClaim.filter((c) => matches(c, where));
            hits.forEach((row) => applyData(row, data));
            return { count: hits.length };
        },
    };

    // ── blockchainLedger ──────────────────────────────────────────────────

    readonly blockchainLedger = {
        findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
            await tick();
            return (
                sortRows(this.store.blockchainLedger.filter((l) => matches(l, where)), orderBy)[0] ??
                null
            );
        },
        findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
            await tick();
            return sortRows(this.store.blockchainLedger.filter((l) => matches(l, where)), orderBy);
        },
        create: async ({ data }: { data: Row }) => {
            await tick();
            const sku = this.store.sku.find((s) => s.id === data.skuId);
            const drop = this.store.drop.find((d) => d.id === sku?.productId);
            const row = {
                ...data,
                sku: { tagId: sku?.tagId ?? null, drop: { groupCode: drop?.groupCode ?? null } },
            };
            this.store.blockchainLedger.push(row);
            return row;
        },
    };

    // ── skuHistory ────────────────────────────────────────────────────────

    readonly skuHistory = {
        create: async ({ data }: { data: Row }) => {
            await tick();
            this.store.skuHistory.push({ ...data });
            return data;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const hits = this.store.skuHistory.filter((h) => matches(h, where));
            hits.forEach((row) => applyData(row, data));
            return { count: hits.length };
        },
    };

    // ── buyerCollection ───────────────────────────────────────────────────

    readonly buyerCollection = {
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
            await tick();
            const key = where.userId_skuId as { userId: string; skuId: string };
            const existing = this.store.buyerCollection.find(
                (b) => b.userId === key.userId && b.skuId === key.skuId,
            );
            if (existing) {
                applyData(existing, update);
                return existing;
            }
            const row = { archivedAt: null, ...create };
            this.store.buyerCollection.push(row);
            return row;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            await tick();
            const hits = this.store.buyerCollection.filter((b) => matches(b, where));
            hits.forEach((row) => applyData(row, data));
            return { count: hits.length };
        },
    };
}

function pick(row: Row, select: Row): Row {
    const out: Row = {};
    for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
    return out;
}

/** A claimCode unique-constraint violation, as Prisma reports it. */
export function claimCodeCollision(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['claimCode'] },
    });
}

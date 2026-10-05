import { PrismaClient } from '@prisma/client';
import { PUBLIC_CODE_PREFIXES, generatePublicCode } from './public-code';

/**
 * Stamps `publicCode` onto every row as it is created.
 *
 * ## Why an extension rather than 68 repositories
 *
 * A human-readable code is wanted on every table, and every table is written
 * by its own module's repository. Threading a generator call through all of
 * them would be ~200 edit sites, each an opportunity to forget one — and a
 * table whose code is *sometimes* written is worse than one with no code at
 * all, because the gap only shows up when somebody cannot find a record.
 *
 * A query extension is the one place every write already passes through. No
 * repository, service or module changes; a table added next year gets a code
 * by adding its prefix to the registry.
 *
 * ## What it covers
 *
 * `create`, `createMany`, `createManyAndReturn`, and the create branch of
 * `upsert`. Raw SQL (`$queryRaw` / `$executeRaw`) bypasses the client entirely
 * and is therefore NOT covered — deliberately, since those are reserved for
 * reads and for migrations here.
 *
 * ## It never overwrites
 *
 * A caller that supplies its own `publicCode` keeps it. That is what makes a
 * seed reproducible and a data migration able to preserve codes that have
 * already been printed on something.
 */

/** Adds a code to one `data` object unless the caller already set one. */
function stamp(data: unknown, prefix: string): unknown {
    if (data === null || typeof data !== 'object') return data;
    const row = data as Record<string, unknown>;
    // `undefined` means "not supplied"; an explicit null is a caller decision
    // and is left alone, so a deliberate blank cannot be silently overwritten.
    if (row.publicCode !== undefined) return row;
    return { ...row, publicCode: generatePublicCode(prefix) };
}

function stampMany(data: unknown, prefix: string): unknown {
    if (Array.isArray(data)) return data.map((row) => stamp(row, prefix));
    return stamp(data, prefix);
}

/**
 * Wraps a client so every create carries a public code.
 *
 * The result is cast back to `PrismaClient`. `$extends` widens the client's
 * type, and every module in this codebase is typed against plain
 * `PrismaClient` — the cast keeps those 68 signatures valid while the runtime
 * behaviour is the extended one. Nothing is lost: the extension adds no
 * methods, only a `create` side effect.
 */
export function withPublicCodes(client: PrismaClient): PrismaClient {
    return client.$extends({
        name: 'publicCode',
        query: {
            $allModels: {
                create({ model, args, query }) {
                    const prefix = PUBLIC_CODE_PREFIXES[model];
                    if (prefix) args.data = stamp(args.data, prefix) as typeof args.data;
                    return query(args);
                },
                createMany({ model, args, query }) {
                    const prefix = PUBLIC_CODE_PREFIXES[model];
                    if (prefix) args.data = stampMany(args.data, prefix) as typeof args.data;
                    return query(args);
                },
                createManyAndReturn({ model, args, query }) {
                    const prefix = PUBLIC_CODE_PREFIXES[model];
                    if (prefix) args.data = stampMany(args.data, prefix) as typeof args.data;
                    return query(args);
                },
                upsert({ model, args, query }) {
                    const prefix = PUBLIC_CODE_PREFIXES[model];
                    // Only the `create` half. An upsert that updates must not
                    // rewrite the code of a row somebody has already quoted.
                    if (prefix) args.create = stamp(args.create, prefix) as typeof args.create;
                    return query(args);
                },
            },
        },
    }) as unknown as PrismaClient;
}

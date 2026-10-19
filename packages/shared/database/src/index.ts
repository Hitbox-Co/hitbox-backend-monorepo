import { PrismaClient } from "@prisma/client";
import { withPublicCodes } from "./public-code.extension";

/**
 * PrismaClient singleton for the whole backend. Every module receives this
 * via dependency injection (see each module's createXModule deps) — modules
 * never instantiate their own client.
 *
 * globalThis caching prevents connection-pool exhaustion under dev
 * hot-reload; Neon's pooled DATABASE_URL handles pooling in production.
 *
 * The client is wrapped by `withPublicCodes`, which stamps the human-readable
 * `publicCode` onto every row as it is created. That lives here rather than in
 * each repository for the reason given in public-code.extension.ts: it is the
 * one place every write already passes through.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
    globalForPrisma.prisma ??
    withPublicCodes(
        new PrismaClient({
            log:
                process.env.NODE_ENV === "development"
                    ? ["query", "warn", "error"]
                    : ["warn", "error"],
        }),
    );

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}

// Re-export the generated client — models, enums, Prisma namespace — so
// feature modules import from "@hitbox/database", never "@prisma/client".
export * from "@prisma/client";

// The human-readable record id: its generator, its prefix registry, and the
// helper that reads the issue time back out of a code.
export {
    generatePublicCode,
    publicCodeIssuedAt,
    PUBLIC_CODE_PREFIXES,
    PUBLIC_CODE_BODY_LENGTH,
} from "./public-code";
export { withPublicCodes } from "./public-code.extension";

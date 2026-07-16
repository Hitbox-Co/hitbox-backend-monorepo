import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient singleton for the whole backend. Every module receives this
 * via dependency injection (see each module's createXModule deps) — modules
 * never instantiate their own client.
 *
 * globalThis caching prevents connection-pool exhaustion under dev
 * hot-reload; Neon's pooled DATABASE_URL handles pooling in production.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
    globalForPrisma.prisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === "development"
                ? ["query", "warn", "error"]
                : ["warn", "error"],
    });

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}

// Re-export the generated client — models, enums, Prisma namespace — so
// feature modules import from "@hitbox/database", never "@prisma/client".
export * from "@prisma/client";

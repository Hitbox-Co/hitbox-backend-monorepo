// Own generated Prisma client (see prisma/schema.prisma's `generator.output`)
// — physically separate from @hitbox/database's client, own database.
import { PrismaClient } from './generated/prisma/index.js';

const globalForPrisma = globalThis as unknown as { leadsPrisma?: PrismaClient };

export const leadsPrisma: PrismaClient =
    globalForPrisma.leadsPrisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === "development"
                ? ["query", "warn", "error"]
                : ["warn", "error"],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.leadsPrisma = leadsPrisma;
}

export * from './generated/prisma/index.js';

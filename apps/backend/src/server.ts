import { env, logger } from "@hitbox/shared";
import { prisma } from "@hitbox/database";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

const app = createApp(bootstrap());

const HOST = "0.0.0.0";

const server = app.listen(env.PORT, HOST, () => {
    logger.info(`🚀 Server running on ${HOST}:${env.PORT}`);
});

// Warm the DB connection at boot, then keep it alive — Neon drops idle
// connections, which otherwise makes the first request after idle slow/fail.
void prisma.$connect().then(() => logger.info('database connection warmed'));
const keepWarm = setInterval(() => {
    void prisma.$queryRaw`SELECT 1`.catch((err: unknown) =>
        logger.warn({ err }, 'db keep-warm ping failed'));
}, 60_000);
keepWarm.unref();

function shutdown(signal: string): void {
    logger.info({ signal }, "shutting down");
    server.close(() => {
        prisma
            .$disconnect()
            .catch((error: unknown) => logger.error({ err: error }, "prisma disconnect failed"))
            .finally(() => process.exit(0));
    });
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

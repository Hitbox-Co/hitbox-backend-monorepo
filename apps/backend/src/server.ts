import { env, logger } from "@hitbox/shared";
import { prisma } from "@hitbox/database";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

const app = createApp(bootstrap());

// 0.0.0.0 so phones/emulators on the LAN can reach the API in development.
const HOST = env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0";

const server = app.listen(env.PORT, HOST, () => {
    logger.info(`🚀 Server running on http://localhost:${env.PORT} (bound to ${HOST})`);
});

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

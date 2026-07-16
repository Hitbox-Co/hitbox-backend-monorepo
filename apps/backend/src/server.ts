import { env, logger } from "@hitbox/shared";
import { prisma } from "@hitbox/database";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

const app = createApp(bootstrap());

const server = app.listen(env.PORT, "127.0.0.1" ,() => {
    logger.info(`🚀 Server running on http://localhost:${env.PORT}`);
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

import express from "express";
import type { Express, Request, Router } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { createRateLimiter, errorHandler, isProduction, notFoundHandler } from "@hitbox/shared";

export function createApp(apiRouter: Router): Express {
    const app = express();

    // Behind a host/CDN proxy the client IP is in X-Forwarded-For; trust one
    // hop so the rate limiter keys on the real client, not the proxy.
    if (isProduction) app.set("trust proxy", 1);

    app.use(
        cors({
            origin: "*",
        })
    );
    app.use(helmet());

    if (isProduction) {
        app.use(morgan("combined"));
    } else {
        app.use(morgan("dev"));
    }

    app.use(
        express.json({
            // Keep the raw body around — Clerk/svix webhook signatures are
            // computed over the exact bytes, not the parsed JSON.
            verify: (req, _res, buf) => {
                (req as Request & { rawBody?: Buffer }).rawBody = buf;
            },
        }),
    );
    app.use(express.urlencoded({ extended: true }));

    app.get("/", (_, res) => {
        res.json({ success: true, message: "HitBox Backend is running 🚀" });
    });

    // Rate limit the whole API (per client IP; Redis-backed when configured).
    app.use("/api/v1", createRateLimiter(), apiRouter);

    // 404 + single error boundary — always LAST.
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

import express from "express";
import type { Express, Request, Router } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { createRateLimiter, errorHandler, isProduction, notFoundHandler } from "@hitbox/shared";

export interface AppRouters {
    apiRouter: Router;
    leadsRouter: Router;
}

export function createApp({ apiRouter, leadsRouter }: AppRouters): Express {
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

    // Mobile platform — rate limit per client IP (Redis-backed when configured).
    app.use("/api/v1", createRateLimiter(), apiRouter);

    // Public website (lead capture) — same server/port, separate route
    // namespace, its own tighter budget: unauthenticated public forms with
    // no CAPTCHA yet (see docs/leads-schema.md §6.4) get a lower per-IP
    // limit and a distinct Redis key prefix so the two budgets never share.
    app.use(
        "/app/web/v1",
        createRateLimiter({ prefix: "web", windowMs: 60_000, max: 20 }),
        leadsRouter,
    );

    // 404 + single error boundary — always LAST.
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

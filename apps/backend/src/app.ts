import express from "express";
import type { Express, Request, Router } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { createRateLimiter, errorHandler, isProduction, notFoundHandler } from "@hitbox/shared";

export interface AppRouters {
    apiRouter: Router;
    leadsRouter: Router;
    /**
     * Payment provider callbacks. Null when no webhook signing secret is
     * configured — bootstrap then supplies a router that 503s, rather than
     * this app mounting an endpoint that would trust whatever arrives.
     */
    webhookRouter: Router;
}

export function createApp({ apiRouter, leadsRouter, webhookRouter }: AppRouters): Express {
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
            // Keep the raw body around — Clerk/svix and Stripe webhook
            // signatures are computed over the exact bytes, not the parsed
            // JSON. Re-serialising `req.body` produces different bytes and
            // every signature check would fail.
            verify: (req, _res, buf) => {
                (req as Request & { rawBody?: Buffer }).rawBody = buf;
            },
        }),
    );
    app.use(express.urlencoded({ extended: true }));

    app.get("/", (_, res) => {
        res.json({ success: true, message: "HitBox Backend is running 🚀" });
    });

    // Payment provider callbacks. Mounted OUTSIDE /api/v1 and on their own,
    // much larger budget: Stripe bursts retries after an outage, and throttling
    // a settlement webhook to the same 100/min as a mobile client means orders
    // silently stay unpaid. The endpoint is not unprotected — it verifies an
    // HMAC signature over the raw bytes before it reads anything — and the
    // limit here exists only to cap an unauthenticated flood.
    app.use(
        "/webhooks/payments",
        createRateLimiter({ prefix: "webhooks", windowMs: 60_000, max: 600 }),
        webhookRouter,
    );

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

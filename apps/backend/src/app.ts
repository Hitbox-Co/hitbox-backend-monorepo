import express from "express";
import type { Express, Request, Router } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { errorHandler, isProduction, notFoundHandler } from "@hitbox/shared";

export function createApp(apiRouter: Router): Express {
    const app = express();

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

    app.use("/api/v1", apiRouter);

    // 404 + single error boundary — always LAST.
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

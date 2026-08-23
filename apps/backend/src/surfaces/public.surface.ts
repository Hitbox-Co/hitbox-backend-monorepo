import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';

export interface PublicSurfaceRouters {
    /** Clerk webhooks + pre-flight registration validation. */
    auth: ExpressRouter;
    /** Read-only feeds. */
    discover: ExpressRouter;
    marketplace: ExpressRouter;
    /** NFC authenticity: anyone holding the item can verify it. */
    verify: ExpressRouter;
    ledger: ExpressRouter;
}

/**
 * PUBLIC SURFACE — no session required.
 *
 * Everything here is deliberately readable by anonymous callers, so nothing on
 * this surface may expose owner identity, tenant identity, or anything that is
 * not already public. New routes belong here only if that is true of them.
 *
 * Mounted at the API root, so paths are unchanged: /api/v1/discover, ...
 */
export function buildPublicSurface(routers: PublicSurfaceRouters): ExpressRouter {
    const surface = Router();

    surface.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    surface.use('/auth', routers.auth);
    surface.use('/discover', routers.discover);
    surface.use('/marketplace', routers.marketplace);
    surface.use('/verify', routers.verify);
    surface.use('/ledger', routers.ledger);

    return surface;
}

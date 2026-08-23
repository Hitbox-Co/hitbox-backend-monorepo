import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { createRateLimiter, env } from '@hitbox/shared';
import { withSurface } from '@hitbox/authz';
import {
    SURFACES,
    SURFACE_MOUNTS,
    SURFACE_RATE_MULTIPLIER,
    allowedOriginsFor,
} from './surfaces/surface';
import type { SurfaceName } from './surfaces/surface';
import { surfaceCors } from './middleware/surface-cors.middleware';

export interface SurfaceRouters {
    public: ExpressRouter;
    app: ExpressRouter;
    admin: ExpressRouter;
    manage: ExpressRouter;
}

/**
 * Wraps a surface router with everything that is decided per surface rather
 * than per route: its CORS allowlist, its rate limit, and the surface tag that
 * ends up on every audit record.
 *
 * Order matters. CORS runs first so a rejected origin never consumes rate-limit
 * budget; withSurface runs before any authorization middleware so the tag is
 * available when a decision is audited.
 */
function mountSurface(name: SurfaceName, router: ExpressRouter): ExpressRouter {
    const wrapper = Router();
    wrapper.use(surfaceCors(name, allowedOriginsFor(name)));
    wrapper.use(
        createRateLimiter({
            max: Math.max(1, Math.round(env.RATE_LIMIT_MAX * SURFACE_RATE_MULTIPLIER[name])),
            // Separate Redis bucket per surface, so heavy anonymous catalog
            // traffic cannot exhaust an operator's admin budget.
            prefix: `api:${name}`,
        }),
    );
    wrapper.use(withSurface(name));
    wrapper.use(router);
    return wrapper;
}

/**
 * Mounts every surface under the versioned API prefix (see app.ts).
 *
 *   /api/v1/...          public + app  (hitbox.com, mobile)
 *   /api/v1/admin/...    admin.hitbox.com
 *   /api/v1/manage/...   productmanager.hitbox.com
 *
 * The more specific prefixes are mounted FIRST so `/admin/...` is not swallowed
 * by the root-mounted app surface.
 */
export function buildRoutes(routers: SurfaceRouters): ExpressRouter {
    const api = Router();

    api.use(SURFACE_MOUNTS[SURFACES.ADMIN], mountSurface(SURFACES.ADMIN, routers.admin));
    api.use(SURFACE_MOUNTS[SURFACES.MANAGE], mountSurface(SURFACES.MANAGE, routers.manage));
    api.use(SURFACE_MOUNTS[SURFACES.PUBLIC], mountSurface(SURFACES.PUBLIC, routers.public));
    api.use(SURFACE_MOUNTS[SURFACES.APP], mountSurface(SURFACES.APP, routers.app));

    return api;
}

import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';

export interface AppSurfaceRouters {
    /** GET /authz/me — the permission manifest both clients bootstrap with. */
    authzManifest: ExpressRouter;
    users: ExpressRouter;
    products: ExpressRouter;
    collections: ExpressRouter;
    claims: ExpressRouter;
}

/**
 * APP SURFACE — hitbox.com and the mobile app.
 *
 * Both clients are served by exactly the same routes: a phone and a browser are
 * the same principal with the same permissions, and duplicating endpoints per
 * device is how the two drift apart. What differs between them is presentation,
 * which is the client's job, driven by GET /authz/me.
 *
 * Customer and artist are also NOT separate surfaces: an artist is a user who
 * additionally holds the ARTIST role, so `product:create:own` appears in their
 * manifest and the "create" affordance appears in their UI. Same routes, same
 * checks, different grants.
 *
 * Mounted at the API root, so existing paths are unchanged.
 */
export function buildAppSurface(routers: AppSurfaceRouters): ExpressRouter {
    const surface = Router();

    surface.use('/authz', routers.authzManifest);
    surface.use('/users', routers.users);
    surface.use('/products', routers.products);
    surface.use('/collections', routers.collections);
    surface.use('/claims', routers.claims);

    return surface;
}

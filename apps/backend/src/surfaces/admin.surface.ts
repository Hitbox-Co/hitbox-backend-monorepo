import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';

export interface AdminSurfaceRouters {
    authzManifest: ExpressRouter;
    /** Role administration, permission catalog, audit trail. */
    authzAdmin: ExpressRouter;
    /** Tenant lifecycle and membership. */
    organizations: ExpressRouter;
    /** Platform-wide catalog operations (product:*:any). */
    products: ExpressRouter;
    users: ExpressRouter;
}

/**
 * ADMIN SURFACE — admin.hitbox.com, mounted at /api/v1/admin.
 *
 * "Admin" is an AUTHORIZATION concept, not an identity one: these routes use
 * the same Clerk instance and the same session as the mobile app. What makes
 * them administrative is that the permissions they demand (`*:any`,
 * `role:assign:any`, `organization:create:any`) are only ever carried by
 * platform roles. There is no separate admin login, no admin token, no admin
 * Clerk instance — that would double the identity surface for no security gain.
 *
 * Two things are true of every route here:
 *   - it is unreachable from the customer app, because it is not mounted there
 *   - it is still permission-checked, because reachability is not authorization
 */
export function buildAdminSurface(routers: AdminSurfaceRouters): ExpressRouter {
    const surface = Router();

    surface.use('/authz', routers.authzManifest);
    surface.use('/authz', routers.authzAdmin);
    surface.use('/organizations', routers.organizations);
    surface.use('/products', routers.products);
    surface.use('/users', routers.users);

    return surface;
}

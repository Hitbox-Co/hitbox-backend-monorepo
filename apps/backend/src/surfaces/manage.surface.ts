import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';

export interface ManageSurfaceRouters {
    authzManifest: ExpressRouter;
    /** Read + member management for the tenant the caller is acting in. */
    organizations: ExpressRouter;
    /** Tenant catalog work (product:*:organization). */
    products: ExpressRouter;
}

/**
 * MANAGE SURFACE — productmanager.hitbox.com, mounted at /api/v1/manage.
 *
 * The business back-office: everything here is expected to run inside an
 * organization context, which the client supplies with the
 * `X-Organization-Id` header (or a route param). When a caller belongs to
 * exactly one tenant the header is optional; when they belong to several it is
 * required, because guessing which tenant a write lands in is not acceptable.
 *
 * Note that this surface hands out no capability of its own. A PRODUCT_MANAGER
 * reaching /manage/products can edit their tenant's products because they hold
 * `product:update:organization`; the same person reaching the same route with
 * no tenant context gets a 403. The tenant boundary is enforced by the resource
 * policy, not by the URL prefix.
 */
export function buildManageSurface(routers: ManageSurfaceRouters): ExpressRouter {
    const surface = Router();

    surface.use('/authz', routers.authzManifest);
    surface.use('/organizations', routers.organizations);
    surface.use('/products', routers.products);

    return surface;
}

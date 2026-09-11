import { Router } from 'express';

export interface ApiRouters {
    auth: Router;
    users: Router;
    products: Router;
    discover: Router;
    marketplace: Router;
    collections: Router;
    // NFC two-step claim (validate + confirm) + verify + ledger (claims module).
    claims: Router;
    verify: Router;
    ledger: Router;
    /** The caller's own effective permissions — GET /authz/me. */
    authz: Router;
    /**
     * Generic authorization administration: roles, the permission catalog and
     * user-role assignments. ONE namespace for all of it — there is
     * deliberately no /content-manager, /order-manager or /finance-admin
     * route group, because roles are not API namespaces.
     */
    adminAuthz: Router;
    /**
     * The admin dashboard — ONE permission-driven reporting API. There is no
     * per-role namespace here either: an Order Manager and a Finance Admin
     * call the same routes and get different sections back.
     */
    adminDashboard: Router;
    /** Media registry: presigned upload, list, signed serve, soft archive. */
    adminMedia: Router;
}

/** Mounts every module router under the versioned API prefix (see app.ts). */
export function buildRoutes(routers: ApiRouters): Router {
    const api = Router();

    api.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    api.use('/auth', routers.auth);
    api.use('/users', routers.users);
    api.use('/products', routers.products);
    api.use('/discover', routers.discover);
    api.use('/marketplace', routers.marketplace);
    api.use('/collections', routers.collections);
    api.use('/claims', routers.claims);
    api.use('/verify', routers.verify);
    api.use('/ledger', routers.ledger);
    api.use('/authz', routers.authz);
    api.use('/admin/authz', routers.adminAuthz);
    api.use('/admin/dashboard', routers.adminDashboard);
    api.use('/admin/media', routers.adminMedia);

    return api;
}

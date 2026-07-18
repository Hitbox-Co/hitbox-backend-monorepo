import { Router } from 'express';

export interface ApiRouters {
    auth: Router;
    users: Router;
    products: Router;
    discover: Router;
    marketplace: Router;
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

    return api;
}

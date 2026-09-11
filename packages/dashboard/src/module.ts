import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import { DASHBOARD_MODULE } from './constants/dashboard.constant';
import { DashboardController } from './controller/dashboard.controller';
import type { PrincipalResolver } from './controller/dashboard.controller';
import { DashboardRepository } from './repository/dashboard.repository';
import { DashboardService } from './service/dashboard.service';

/**
 * The admin dashboard: one permission-driven reporting API, not a set of
 * per-role endpoints. There is deliberately no `/order-manager/*` or
 * `/finance-admin/*` — every caller hits the same routes and the response is
 * shaped by what their grants allow.
 *
 * ── A deliberate architectural exception ────────────────────────────────────
 *
 * Every other read-model module (`discover`, `marketplace`) owns no tables and
 * reaches its data through injected ports. This one queries ~20 tables
 * directly with read-only Prisma, and that is on purpose: a reporting surface
 * that aggregates across the whole platform would otherwise need twenty ports
 * whose only implementation is "run this GROUP BY", which is ceremony rather
 * than isolation. The constraint kept instead is **read-only** — this module
 * performs no writes, owns no tables, and appears nowhere in the schema.
 *
 * On extraction it becomes a reporting service against a read replica, which
 * is the shape it already has.
 */
export interface DashboardModuleDeps {
    prisma: PrismaClient;
    /**
     * Turns a request into the caller's effective permissions.
     *
     * Structural, not imported: the dashboard depends on the *shape* of an
     * answer to "what may this caller do", so it never imports
     * @hitbox/access-control. Bootstrap passes the real guard's
     * `describePrincipal`, which is already memoised per request.
     */
    resolvePrincipal: PrincipalResolver;
}

export interface DashboardModule {
    /** Mounted under /admin/dashboard. */
    createRouter(requireAuth: RequestHandler): Router;
}

export function createDashboardModule(deps: DashboardModuleDeps): DashboardModule {
    const logger = createModuleLogger(DASHBOARD_MODULE);
    const repository = new DashboardRepository(deps.prisma);
    const service = new DashboardService({ repository, logger });
    const controller = new DashboardController(service, deps.resolvePrincipal);

    return {
        createRouter(requireAuth) {
            const router = Router();
            // Authentication is required for every route; authorization is
            // resolved per section inside the service, because one request
            // spans a dozen different capabilities.
            router.use(requireAuth);

            router.get('/', controller.overview);
            router.get('/users', controller.users);
            router.get('/orders', controller.orders);
            router.get('/finance', controller.finance);
            router.get('/markets', controller.markets);
            router.get('/products', controller.products);
            router.get('/release-approvals', controller.releaseApprovals);
            router.get('/provenance', controller.provenance);
            router.get('/supply', controller.supply);
            router.get('/resale', controller.resale);
            router.get('/activity', controller.activity);
            router.get('/demand-signals', controller.demandSignals);

            return router;
        },
    };
}

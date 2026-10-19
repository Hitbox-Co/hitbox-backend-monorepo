import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import type { DashboardPrincipal } from '../domain/dashboard-access';
import {
    activityQuerySchema,
    dashboardQuerySchema,
    ordersQuerySchema,
    paginatedQuerySchema,
    productsQuerySchema,
    provenanceQuerySchema,
    releaseApprovalsQuerySchema,
    resaleQuerySchema,
    supplyQuerySchema,
} from '../dto/dashboard.dto';
import type { DashboardService } from '../service/dashboard.service';

/** Resolves the caller's permissions. Supplied by bootstrap. */
export type PrincipalResolver = (req: Request) => Promise<DashboardPrincipal>;

/**
 * HTTP glue. Parses the query, hands the caller's principal to the service,
 * and returns what comes back — no authorization logic lives here, so a new
 * endpoint cannot accidentally skip a gate by forgetting a middleware.
 */
export class DashboardController {
    constructor(
        private readonly service: DashboardService,
        private readonly resolvePrincipal: PrincipalResolver,
    ) { }

    /** GET /admin/dashboard */
    overview: RequestHandler = asyncHandler(async (req, res) => {
        const query = dashboardQuerySchema.parse(req.query);
        res.json(await this.service.build(await this.principal(req), query));
    });

    /** GET /admin/dashboard/users */
    users: RequestHandler = asyncHandler(async (req, res) => {
        const query = paginatedQuerySchema.parse(req.query);
        res.json({ data: await this.service.users(await this.principal(req), query) });
    });

    /** GET /admin/dashboard/orders */
    orders: RequestHandler = asyncHandler(async (req, res) => {
        const query = ordersQuerySchema.parse(req.query);
        res.json(await this.service.orders(await this.principal(req), query));
    });

    /** GET /admin/dashboard/finance */
    finance: RequestHandler = asyncHandler(async (req, res) => {
        const query = dashboardQuerySchema.parse(req.query);
        res.json({ data: await this.service.finance(await this.principal(req), query) });
    });

    /** GET /admin/dashboard/markets */
    markets: RequestHandler = asyncHandler(async (req, res) => {
        const query = dashboardQuerySchema.parse(req.query);
        res.json({ data: await this.service.markets(await this.principal(req), query) });
    });

    /** GET /admin/dashboard/products */
    products: RequestHandler = asyncHandler(async (req, res) => {
        const query = productsQuerySchema.parse(req.query);
        res.json(await this.service.products(await this.principal(req), query));
    });

    /** GET /admin/dashboard/release-approvals */
    releaseApprovals: RequestHandler = asyncHandler(async (req, res) => {
        const query = releaseApprovalsQuerySchema.parse(req.query);
        res.json(await this.service.releaseApprovals(await this.principal(req), query));
    });

    /** GET /admin/dashboard/provenance */
    provenance: RequestHandler = asyncHandler(async (req, res) => {
        const query = provenanceQuerySchema.parse(req.query);
        res.json(await this.service.provenance(await this.principal(req), query));
    });

    /** GET /admin/dashboard/supply */
    supply: RequestHandler = asyncHandler(async (req, res) => {
        const query = supplyQuerySchema.parse(req.query);
        res.json(await this.service.supply(await this.principal(req), query));
    });

    /** GET /admin/dashboard/resale */
    resale: RequestHandler = asyncHandler(async (req, res) => {
        const query = resaleQuerySchema.parse(req.query);
        res.json(await this.service.resale(await this.principal(req), query));
    });

    /** GET /admin/dashboard/activity */
    activity: RequestHandler = asyncHandler(async (req, res) => {
        const query = activityQuerySchema.parse(req.query);
        res.json(await this.service.activity(await this.principal(req), query));
    });

    /** GET /admin/dashboard/demand-signals */
    demandSignals: RequestHandler = asyncHandler(async (req, res) => {
        const query = dashboardQuerySchema.parse(req.query);
        res.json({ data: await this.service.demandSignals(await this.principal(req), query) });
    });

    private principal(req: Request): Promise<DashboardPrincipal> {
        return this.resolvePrincipal(req);
    }
}

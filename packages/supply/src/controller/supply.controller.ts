import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { buildSupplyAccess } from '../domain/supply-access';
import type { SupplyAccess, SupplyPrincipal } from '../domain/supply-access';
import {
    createBatchSchema,
    createVendorSchema,
    decideBatchSchema,
    listBatchesQuerySchema,
    listTagsQuerySchema,
    listVendorsQuerySchema,
    recordQcSchema,
    registerTagsSchema,
    supplyMetricsQuerySchema,
    updateVendorSchema,
} from '../dto/supply.dto';
import type { SupplyMutationContext, SupplyService } from '../service/supply.service';

/**
 * Reads the caller's grants off the request. Bootstrap supplies the adapter, so
 * this module never imports the authorization module.
 */
export type SupplyPrincipalResolver = (req: Request) => Promise<SupplyPrincipal>;

export class SupplyController {
    constructor(
        private readonly service: SupplyService,
        private readonly resolvePrincipal: SupplyPrincipalResolver,
    ) { }

    // ── Vendors ─────────────────────────────────────────────────────────────

    /** GET /admin/supply/vendors */
    listVendors: RequestHandler = asyncHandler(async (req, res) => {
        res.json(
            await this.service.listVendors(
                await this.access(req),
                listVendorsQuerySchema.parse(req.query),
            ),
        );
    });

    /** GET /admin/supply/vendors/:vendorId */
    getVendor: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getVendor(
                await this.access(req),
                req.params.vendorId as string,
            ),
        });
    });

    /** POST /admin/supply/vendors */
    createVendor: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createVendorSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.createVendor(await this.mutation(req), dto),
        });
    });

    /** PATCH /admin/supply/vendors/:vendorId */
    updateVendor: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateVendorSchema.parse(req.body);
        res.json({
            data: await this.service.updateVendor(
                await this.mutation(req),
                req.params.vendorId as string,
                dto,
            ),
        });
    });

    // ── Consignments ────────────────────────────────────────────────────────

    /** GET /admin/supply/batches */
    listBatches: RequestHandler = asyncHandler(async (req, res) => {
        res.json(
            await this.service.listBatches(
                await this.access(req),
                listBatchesQuerySchema.parse(req.query),
            ),
        );
    });

    /** GET /admin/supply/batches/:batchId */
    getBatch: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getBatch(
                await this.access(req),
                req.params.batchId as string,
            ),
        });
    });

    /** POST /admin/supply/batches */
    createBatch: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createBatchSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.createBatch(await this.mutation(req), dto),
        });
    });

    /** POST /admin/supply/batches/:batchId/decision */
    decideBatch: RequestHandler = asyncHandler(async (req, res) => {
        const dto = decideBatchSchema.parse(req.body);
        res.json({
            data: await this.service.decideBatch(
                await this.mutation(req),
                req.params.batchId as string,
                dto,
            ),
        });
    });

    /**
     * POST /admin/supply/batches/:batchId/tags — apply a vendor manifest.
     *
     * All-or-nothing: a half-applied manifest leaves a physical carton in a
     * state nobody can reconcile from the database.
     */
    registerTags: RequestHandler = asyncHandler(async (req, res) => {
        const dto = registerTagsSchema.parse(req.body);
        res.json({
            data: await this.service.registerTags(
                await this.mutation(req),
                req.params.batchId as string,
                dto,
            ),
        });
    });

    // ── Chip inventory ──────────────────────────────────────────────────────

    /** GET /admin/supply/tags */
    listTags: RequestHandler = asyncHandler(async (req, res) => {
        res.json(
            await this.service.listTags(
                await this.access(req),
                listTagsQuerySchema.parse(req.query),
            ),
        );
    });

    /** GET /admin/supply/tags/:tagId */
    getTag: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getTag(
                await this.access(req),
                req.params.tagId as string,
            ),
        });
    });

    /** PATCH /admin/supply/tags/:tagId/qc */
    recordQc: RequestHandler = asyncHandler(async (req, res) => {
        const dto = recordQcSchema.parse(req.body);
        res.json({
            data: await this.service.recordQc(
                await this.mutation(req),
                req.params.tagId as string,
                dto,
            ),
        });
    });

    // ── Metrics ─────────────────────────────────────────────────────────────

    /** GET /admin/supply/metrics */
    metrics: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.metrics(
                await this.access(req),
                supplyMetricsQuerySchema.parse(req.query),
            ),
        });
    });

    /**
     * The caller's view, resolved from their grants on every request.
     *
     * Never cached across requests and never taken from the body or query —
     * there is no parameter a client can send that widens what it sees.
     */
    private async access(req: Request): Promise<SupplyAccess> {
        return buildSupplyAccess(await this.resolvePrincipal(req));
    }

    /**
     * The same view, plus the correlation id every write is recorded under.
     *
     * Read off the request rather than imported from the audit module — the
     * correlation middleware sets the property, and a plain property read is
     * not a dependency. The fallback matters: an audit row with a fresh id is
     * still a row, whereas one that threw because the middleware was not
     * mounted is a lost intake record.
     */
    private async mutation(req: Request): Promise<SupplyMutationContext> {
        const correlated = req as Request & { correlationId?: string };
        return {
            access: await this.access(req),
            correlationId: correlated.correlationId ?? randomUUID(),
        };
    }
}

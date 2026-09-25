import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { buildSkuAccess } from '../domain/sku-access';
import type { SkuAccess, SkuPrincipal } from '../domain/sku-access';
import {
    batchUpdateSkusSchema,
    bindTagSchema,
    bulkBindTagsSchema,
    listSkusQuerySchema,
    mintSkusSchema,
    updateSkuSchema,
} from '../dto/sku.dto';
import type { SkuMutationContext, SkuService } from '../service/sku.service';

/**
 * Reads the caller's grants off the request. Bootstrap supplies the adapter,
 * so this module never imports the authorization module.
 */
export type SkuPrincipalResolver = (req: Request) => Promise<SkuPrincipal>;

export class SkuController {
    constructor(
        private readonly service: SkuService,
        private readonly resolvePrincipal: SkuPrincipalResolver,
    ) { }

    /** POST /admin/products/:productId/skus — mint an edition, or part of one. */
    mint: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        const dto = mintSkusSchema.parse(req.body);
        const result = await this.service.mint(
            access,
            req.params.productId as string,
            dto,
        );
        res.status(201).json({ data: result });
    });

    /**
     * POST /admin/products/:productId/skus/tags — apply a vendor manifest.
     *
     * The batch is all-or-nothing: a half-applied manifest leaves a box of
     * physical tags in a state nobody can reconcile from the database.
     */
    bulkBindTags: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        const dto = bulkBindTagsSchema.parse(req.body);
        res.json({
            data: await this.service.bulkBindTags(
                access,
                req.params.productId as string,
                dto,
            ),
        });
    });

    /** PATCH /admin/skus/:skuId/tag — bind or replace one unit's tag. */
    bindTag: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        const dto = bindTagSchema.parse(req.body);
        res.json({
            data: await this.service.bindTag(access, req.params.skuId as string, dto),
        });
    });

    /** PATCH /admin/skus/:skuId — edit one unit's record. */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateSkuSchema.parse(req.body);
        res.json({
            data: await this.service.update(
                await this.mutation(req),
                req.params.skuId as string,
                dto,
            ),
        });
    });

    /**
     * PATCH /admin/skus/batch
     * PATCH /admin/products/:productId/skus/batch
     *
     * One set of changes, many units, one transaction. The nested form takes
     * the drop from the path — which is also what makes the batch reachable by
     * an organization-scoped caller, since the cross-drop router has no
     * organization to check a grant against and admits global grants only.
     */
    batchUpdate: RequestHandler = asyncHandler(async (req, res) => {
        const dto = batchUpdateSkusSchema.parse(req.body);
        res.json({
            data: await this.service.batchUpdate(
                await this.mutation(req),
                req.params.productId,
                dto,
            ),
        });
    });

    /** GET /admin/products/:productId/skus — the units of one drop. */
    listForProduct: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        const query = listSkusQuerySchema.parse(req.query);
        res.json(
            await this.service.listForProduct(access, req.params.productId as string, query),
        );
    });

    /** GET /admin/products/:productId/skus/summary — counts, for the header row. */
    summary: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        res.json({
            data: await this.service.summary(access, req.params.productId as string),
        });
    });

    /** GET /admin/skus — units across every drop the caller reaches. */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        const query = listSkusQuerySchema.parse(req.query);
        res.json(await this.service.list(access, undefined, query));
    });

    /** GET /admin/skus/:skuId — one unit, in full. */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.access(req);
        res.json({ data: await this.service.getDetail(access, req.params.skuId as string) });
    });

    /**
     * GET /admin/skus/code/:skuCode
     *
     * The code is what is printed on the item, so it is what an operator
     * holding one has to hand — the UUID is not written anywhere physical.
     */
    getByCode: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getDetailByCode(
                await this.access(req),
                req.params.skuCode as string,
            ),
        });
    });

    /**
     * The caller's view, resolved from their grants on every request.
     *
     * Never cached across requests and never taken from the body or query —
     * there is no parameter a client can send that widens what it sees.
     */
    private async access(req: Request): Promise<SkuAccess> {
        return buildSkuAccess(await this.resolvePrincipal(req));
    }

    /**
     * The same view, plus the correlation id every write is recorded under.
     *
     * Read off the request rather than imported from the audit module — the
     * correlation middleware sets the property, and a plain property read is
     * not a dependency. The fallback matters: an audit row with a fresh id is
     * still a row, whereas one that threw because the middleware was not
     * mounted is a lost edit.
     */
    private async mutation(req: Request): Promise<SkuMutationContext> {
        const correlated = req as Request & { correlationId?: string };
        return {
            access: await this.access(req),
            correlationId: correlated.correlationId ?? randomUUID(),
        };
    }
}

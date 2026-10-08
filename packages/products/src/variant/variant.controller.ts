import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    createVariantsSchema,
    generateVariantsSchema,
    listVariantsQuerySchema,
    updateVariantSchema,
} from './variant.dto';
import type { VariantService } from './variant.service';

/** HTTP for /api/v1/admin/products/:id/variants. Parse, delegate, respond. */
export class VariantController {
    constructor(private readonly service: VariantService) { }

    /** GET /admin/products/:id/variants */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listVariantsQuerySchema.parse(req.query);
        res.json({ data: await this.service.list(req.params.id as string, query.includeArchived) });
    });

    /** POST /admin/products/:id/variants */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createVariantsSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(req.params.id as string, dto) });
    });

    /** POST /admin/products/:id/variants/generate — 200 on a dry run, 201 when written. */
    generate: RequestHandler = asyncHandler(async (req, res) => {
        const dto = generateVariantsSchema.parse(req.body);
        const result = await this.service.generate(req.params.id as string, dto);
        res.status(result.dryRun ? 200 : 201).json({ data: result });
    });

    /** PATCH /admin/products/:id/variants/:variantId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateVariantSchema.parse(req.body);
        res.json({
            data: await this.service.update(req.params.id as string, req.params.variantId as string, dto),
        });
    });

    /** DELETE /admin/products/:id/variants/:variantId — deletes, or archives if referenced. */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.remove(req.params.id as string, req.params.variantId as string),
        });
    });
}

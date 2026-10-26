import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    createDropTypeSchema,
    dimensionInputSchema,
    dimensionValueInputSchema,
    listDropTypesQuerySchema,
    updateDimensionSchema,
    updateDimensionValueSchema,
    updateDropTypeSchema,
} from './drop-type.dto';
import type { DropTypeService } from './drop-type.service';

/** HTTP for /api/v1/admin/drop-types. Parse, delegate, respond — nothing else. */
export class DropTypeController {
    constructor(private readonly service: DropTypeService) { }

    /** GET /admin/drop-types */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listDropTypesQuerySchema.parse(req.query);
        res.json({ data: await this.service.list(query.includeInactive) });
    });

    /** GET /admin/drop-types/:code */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.get(req.params.code as string) });
    });

    /** POST /admin/drop-types */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createDropTypeSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(dto) });
    });

    /** PATCH /admin/drop-types/:code */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateDropTypeSchema.parse(req.body);
        res.json({ data: await this.service.update(req.params.code as string, dto) });
    });

    /** POST /admin/drop-types/:code/dimensions */
    addDimension: RequestHandler = asyncHandler(async (req, res) => {
        const dto = dimensionInputSchema.parse(req.body);
        res.status(201).json({ data: await this.service.addDimension(req.params.code as string, dto) });
    });

    /** PATCH /admin/drop-types/:code/dimensions/:dimension */
    updateDimension: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateDimensionSchema.parse(req.body);
        res.json({
            data: await this.service.updateDimension(
                req.params.code as string,
                req.params.dimension as string,
                dto,
            ),
        });
    });

    /** DELETE /admin/drop-types/:code/dimensions/:dimension — archives */
    archiveDimension: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.setDimensionArchived(
                req.params.code as string,
                req.params.dimension as string,
                true,
            ),
        });
    });

    /** POST /admin/drop-types/:code/dimensions/:dimension/restore */
    restoreDimension: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.setDimensionArchived(
                req.params.code as string,
                req.params.dimension as string,
                false,
            ),
        });
    });

    /** POST /admin/drop-types/:code/dimensions/:dimension/values */
    addValue: RequestHandler = asyncHandler(async (req, res) => {
        const dto = dimensionValueInputSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.addValue(req.params.code as string, req.params.dimension as string, dto),
        });
    });

    /** PATCH /admin/drop-types/:code/dimensions/:dimension/values/:value */
    updateValue: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateDimensionValueSchema.parse(req.body);
        res.json({
            data: await this.service.updateValue(
                req.params.code as string,
                req.params.dimension as string,
                req.params.value as string,
                dto,
            ),
        });
    });

    /** DELETE /admin/drop-types/:code/dimensions/:dimension/values/:value — archives */
    archiveValue: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.setValueArchived(
                req.params.code as string,
                req.params.dimension as string,
                req.params.value as string,
                true,
            ),
        });
    });

    /** POST /admin/drop-types/:code/dimensions/:dimension/values/:value/restore */
    restoreValue: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.setValueArchived(
                req.params.code as string,
                req.params.dimension as string,
                req.params.value as string,
                false,
            ),
        });
    });
}

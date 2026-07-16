import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    createProductSchema,
    listProductsQuerySchema,
    updateProductSchema,
} from '../dto/product.dto';
import type { ProductService } from '../service/product.service';

export class ProductController {
    constructor(private readonly service: ProductService) { }

    /** GET /products */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listProductsQuerySchema.parse(req.query);
        const result = await this.service.list(query);
        res.json({ data: result.items, meta: result.meta });
    });

    /** GET /products/code/:productCode */
    getByCode: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getByProductCode(req.params.productCode as string) });
    });

    /** GET /products/:id */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getById(req.params.id as string) });
    });

    /** POST /products */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createProductSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(dto) });
    });

    /** PATCH /products/:id */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateProductSchema.parse(req.body);
        res.json({ data: await this.service.update(req.params.id as string, dto) });
    });

    /** DELETE /products/:id — soft archive */
    archive: RequestHandler = asyncHandler(async (req, res) => {
        await this.service.archive(req.params.id as string);
        res.status(204).send();
    });
}

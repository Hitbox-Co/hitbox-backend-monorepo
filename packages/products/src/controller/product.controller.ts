import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    attachProductImagesSchema,
    createProductSchema,
    listProductsQuerySchema,
    productDetailQuerySchema,
    replaceProductImagesSchema,
    setProductPricesSchema,
    updateProductImageSchema,
    updateProductPriceSchema,
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

    /**
     * GET /products/code/:groupCode
     *
     * The NFC routes that used to sit here (`/tag/:tagId` and
     * `/tag/:tagId/history`) are gone: tags moved to `Sku.tagId` and the
     * `ProductHistory` model was removed. The claims module's
     * `/api/v1/verify` and `/api/v1/ledger` own that surface now.
     */
    getByCode: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getByGroupCode(req.params.groupCode as string) });
    });

    /** GET /products/:id */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getById(req.params.id as string) });
    });

    /**
     * GET /admin/products/:id — the detail screen.
     *
     * Catalog record + performance aggregates + a page of serialized units,
     * in one call. `skuPage`/`skuLimit` paginate the units; a 10,000-unit
     * edition is a legitimate drop.
     */
    getDetail: RequestHandler = asyncHandler(async (req, res) => {
        const query = productDetailQuerySchema.parse(req.query);
        res.json({
            data: await this.service.getDetail({
                id: req.params.id as string,
                skuPage: query.skuPage,
                skuLimit: query.skuLimit,
                claimedStatus: query.claimedStatus,
            }),
        });
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

    // ── Prices ──────────────────────────────────────────────────────────
    //
    // Like the gallery, every mutation returns the WHOLE price list: a drop's
    // pricing is read as a table, and a response carrying one row leaves the
    // client re-fetching to render the change it just made.

    /** GET /admin/products/:id/prices */
    listPrices: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.listPrices(req.params.id as string) });
    });

    /** PUT /admin/products/:id/prices — replace the price list */
    setPrices: RequestHandler = asyncHandler(async (req, res) => {
        const dto = setProductPricesSchema.parse(req.body);
        res.json({ data: await this.service.setPrices(req.params.id as string, dto) });
    });

    /** PATCH /admin/products/:id/prices/:priceId */
    updatePrice: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateProductPriceSchema.parse(req.body);
        res.json({
            data: await this.service.updatePrice(
                req.params.id as string,
                req.params.priceId as string,
                dto,
            ),
        });
    });

    /** DELETE /admin/products/:id/prices/:priceId */
    removePrice: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.removePrice(
                req.params.id as string,
                req.params.priceId as string,
            ),
        });
    });

    // ── Gallery ─────────────────────────────────────────────────────────
    //
    // Every mutation returns the WHOLE gallery, not just the row it touched.
    // Positions and the primary flag are cross-row invariants, so a response
    // carrying one row would leave the client guessing what happened to the
    // others — and guessing wrong every time a reorder cascaded.

    /** GET /admin/products/:id/images */
    listImages: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.listImages(req.params.id as string) });
    });

    /** POST /admin/products/:id/images — append */
    attachImages: RequestHandler = asyncHandler(async (req, res) => {
        const dto = attachProductImagesSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.attachImages(req.params.id as string, dto),
        });
    });

    /** PUT /admin/products/:id/images — replace the gallery wholesale */
    replaceImages: RequestHandler = asyncHandler(async (req, res) => {
        const dto = replaceProductImagesSchema.parse(req.body);
        res.json({ data: await this.service.replaceImages(req.params.id as string, dto) });
    });

    /** PATCH /admin/products/:id/images/:imageId */
    updateImage: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateProductImageSchema.parse(req.body);
        res.json({
            data: await this.service.updateImage(
                req.params.id as string,
                req.params.imageId as string,
                dto,
            ),
        });
    });

    /** DELETE /admin/products/:id/images/:imageId */
    removeImage: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.removeImage(
                req.params.id as string,
                req.params.imageId as string,
            ),
        });
    });
}

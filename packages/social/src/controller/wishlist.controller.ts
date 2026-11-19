import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    addWishlistItemSchema,
    itemIdParamSchema,
    listWishlistQuerySchema,
    productIdParamSchema,
    removeByProductQuerySchema,
    updateWishlistItemSchema,
} from '../dto/wishlist.dto';
import type { WishlistService } from '../service/wishlist.service';

/** The signed-in account. Read structurally so this module does not depend on auth. */
function userIdOf(req: Request): string {
    const id = (req as Request & { auth?: { accountId?: string } }).auth?.accountId;
    if (!id) throw AppError.unauthorized();
    return id;
}

export class WishlistController {
    constructor(private readonly service: WishlistService) { }

    /** GET /wishlist 🔒 */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listWishlistQuerySchema.parse(req.query);
        const { items, total } = await this.service.list(userIdOf(req), query);
        res.json({
            data: items,
            meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
        });
    });

    /** POST /wishlist 🔒 — 201 when added, 200 when it was already saved. */
    add: RequestHandler = asyncHandler(async (req, res) => {
        const dto = addWishlistItemSchema.parse(req.body);
        const { item, created } = await this.service.add(userIdOf(req), dto);
        res.status(created ? 201 : 200).json({ data: item });
    });

    /** PATCH /wishlist/:itemId 🔒 */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const { itemId } = itemIdParamSchema.parse(req.params);
        const dto = updateWishlistItemSchema.parse(req.body);
        res.json({ data: await this.service.update(userIdOf(req), itemId, dto) });
    });

    /** DELETE /wishlist/:itemId 🔒 */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        const { itemId } = itemIdParamSchema.parse(req.params);
        await this.service.remove(userIdOf(req), itemId);
        res.status(204).end();
    });

    /** DELETE /wishlist/products/:productId 🔒 — the heart's "off" by drop id. */
    removeByProduct: RequestHandler = asyncHandler(async (req, res) => {
        const { productId } = productIdParamSchema.parse(req.params);
        const { variantId } = removeByProductQuerySchema.parse(req.query);
        res.json({ data: await this.service.removeByProduct(userIdOf(req), productId, variantId) });
    });
}

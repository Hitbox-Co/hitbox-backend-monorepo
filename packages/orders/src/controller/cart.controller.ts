import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { addCartItemSchema, cartItemIdParamSchema } from '../dto/cart.dto';
import type { CartService } from '../service/cart.service';
import type { OrderBuyerResolver } from './order-shipment.controller';

export class CartController {
    constructor(
        private readonly service: CartService,
        private readonly resolveBuyer: OrderBuyerResolver,
    ) { }

    private userIdOf(req: Request): string {
        return this.resolveBuyer(req);
    }

    /** GET /cart 🔒 */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.get(this.userIdOf(req)) });
    });

    /** POST /cart 🔒 — 201 when added, 200 when it was already in the cart. */
    add: RequestHandler = asyncHandler(async (req, res) => {
        const dto = addCartItemSchema.parse(req.body);
        const { item, created } = await this.service.add(this.userIdOf(req), dto);
        res.status(created ? 201 : 200).json({ data: item });
    });

    /** DELETE /cart/:itemId 🔒 */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        const { itemId } = cartItemIdParamSchema.parse(req.params);
        await this.service.remove(this.userIdOf(req), itemId);
        res.status(204).end();
    });

    /** DELETE /cart 🔒 */
    clear: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.clear(this.userIdOf(req)) });
    });
}

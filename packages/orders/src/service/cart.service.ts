import { Prisma } from '@hitbox/database';
import type { CartItem } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { CART_MAX_ITEMS, ORDERS_ERROR_CODES } from '../constants/orders.constant';
import type { CartDropCard, ICartCatalog } from '../domain/interfaces/cart-catalog.interface';
import type { AddCartItemDto, CartItemView, CartView } from '../dto/cart.dto';
import type { CartRepository } from '../repository/cart.repository';

interface CartServiceDeps {
    cart: CartRepository;
    catalog: ICartCatalog;
    logger: Logger;
}

/**
 * The mobile cart: a list of drops the buyer means to buy.
 *
 * It reserves nothing and stores no price. An order is exactly one
 * serialized unit, so the app checks each row out with `POST /checkout`;
 * `markPaid` deletes the matching row in the same transaction.
 */
export class CartService {
    constructor(private readonly deps: CartServiceDeps) { }

    /** GET /cart — every row with live price and availability, plus a summary. */
    async get(userId: string, marketId?: string | null): Promise<CartView> {
        const rows = await this.deps.cart.list(userId);
        const cards = new Map(
            (await this.deps.catalog.findCards(rows.map((row) => row.productId), marketId)).map((card) => [card.id, card]),
        );
        const items = rows.map((row) => this.toView(row, cards.get(row.productId) ?? null));
        return { items, summary: summarise(items) };
    }

    /**
     * POST /cart — idempotent. Adding a drop (and variant) already in the cart
     * returns the existing row with `created: false`.
     *
     * Only something checkout would accept right now can be added; anything
     * else (not on sale, closed, unpriced) is the same 400
     * `ORDERS_NOT_PURCHASABLE` / `ORDERS_NO_PRICE` checkout would give.
     */
    async add(
        userId: string,
        dto: AddCartItemDto,
        marketId?: string | null,
    ): Promise<{ item: CartItemView; created: boolean }> {
        const variantId = dto.variantId ?? null;
        const card = await this.requirePurchasable(dto.productId, variantId, marketId);

        const existing = await this.deps.cart.findOne(userId, dto.productId, variantId);
        if (existing) return { item: this.toView(existing, card), created: false };

        if ((await this.deps.cart.count(userId)) >= CART_MAX_ITEMS) {
            throw AppError.conflict(
                `Your cart can hold at most ${CART_MAX_ITEMS} items.`,
                ORDERS_ERROR_CODES.CART_FULL,
                { max: CART_MAX_ITEMS },
            );
        }

        try {
            const row = await this.deps.cart.create({ userId, productId: dto.productId, variantId });
            return { item: this.toView(row, card), created: true };
        } catch (error) {
            // A double tap: the unique indexes let exactly one insert through.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const row = await this.deps.cart.findOne(userId, dto.productId, variantId);
                if (row) return { item: this.toView(row, card), created: false };
            }
            throw error;
        }
    }

    /** DELETE /cart/:itemId */
    async remove(userId: string, itemId: string): Promise<void> {
        if ((await this.deps.cart.deleteById(userId, itemId)) === 0) {
            throw AppError.notFound('Cart item not found.', ORDERS_ERROR_CODES.CART_ITEM_NOT_FOUND);
        }
    }

    /** DELETE /cart — empties the cart. */
    async clear(userId: string): Promise<{ removed: number }> {
        return { removed: await this.deps.cart.clear(userId) };
    }

    private async requirePurchasable(
        productId: string,
        variantId: string | null,
        marketId?: string | null,
    ): Promise<CartDropCard> {
        const [card] = await this.deps.catalog.findCards([productId], marketId);
        if (!card || !card.isViewable) {
            throw AppError.notFound('Drop not found.', ORDERS_ERROR_CODES.NOT_FOUND);
        }
        if (variantId && !card.variants.some((variant) => variant.id === variantId && variant.isActive)) {
            throw AppError.notFound('That variant does not belong to this drop.', ORDERS_ERROR_CODES.VARIANT_NOT_FOUND);
        }
        if (!card.isPurchasable) {
            const noPrice = card.unavailableReason === 'NO_PRICE' || card.unavailableReason === 'NOT_AVAILABLE_IN_REGION';
            throw AppError.badRequest(
                card.unavailableReason === 'NOT_AVAILABLE_IN_REGION'
                    ? 'This drop is not available in your region.'
                    : 'This drop cannot be bought right now.',
                noPrice ? ORDERS_ERROR_CODES.NO_PRICE : ORDERS_ERROR_CODES.NOT_PURCHASABLE,
                { status: card.status, reason: card.unavailableReason },
            );
        }
        return card;
    }

    private toView(row: CartItem, card: CartDropCard | null): CartItemView {
        return {
            id: row.id,
            productId: row.productId,
            variant: row.variantId
                ? { id: row.variantId, label: card?.variants.find((v) => v.id === row.variantId)?.label ?? '' }
                : null,
            addedAt: row.createdAt.toISOString(),
            product: card,
        };
    }
}

function summarise(items: CartItemView[]): CartView['summary'] {
    const totals = new Map<string, Prisma.Decimal>();
    let purchasableCount = 0;
    for (const item of items) {
        const card = item.product;
        if (!card?.isPurchasable || !card.price) continue;
        purchasableCount += 1;
        const current = totals.get(card.price.currency) ?? new Prisma.Decimal(0);
        totals.set(card.price.currency, current.plus(card.price.amount));
    }
    return {
        itemCount: items.length,
        purchasableCount,
        subtotals: [...totals].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
    };
}

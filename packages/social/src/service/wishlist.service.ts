import { Prisma } from '@hitbox/database';
import type { WishlistItem } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { SOCIAL_ERROR_CODES } from '../constants/social.constant';
import type { IWishlistCatalog, WishlistDropCard } from '../domain/interfaces/wishlist-catalog.interface';
import type {
    AddWishlistItemDto,
    ListWishlistQueryDto,
    UpdateWishlistItemDto,
    WishlistItemView,
} from '../dto/wishlist.dto';
import type { WishlistRepository } from '../repository/wishlist.repository';

interface WishlistServiceDeps {
    wishlist: WishlistRepository;
    catalog: IWishlistCatalog;
    logger: Logger;
}

export class WishlistService {
    constructor(private readonly deps: WishlistServiceDeps) { }

    /** GET /wishlist — newest first, each row with its drop card. */
    async list(userId: string, query: ListWishlistQueryDto): Promise<{ items: WishlistItemView[]; total: number }> {
        const { items, total } = await this.deps.wishlist.list(userId, (query.page - 1) * query.limit, query.limit);
        const cards = await this.cardsById(items.map((item) => item.productId));
        return { items: items.map((item) => this.toView(item, cards.get(item.productId) ?? null)), total };
    }

    /**
     * POST /wishlist — idempotent. Adding something already saved returns the
     * existing row (`created: false`), applying any `notifyOnAvailable` /
     * `note` sent with it.
     */
    async add(userId: string, dto: AddWishlistItemDto): Promise<{ item: WishlistItemView; created: boolean }> {
        const variantId = dto.variantId ?? null;
        const card = await this.requireViewableDrop(dto.productId, variantId);

        const existing = await this.deps.wishlist.findOne(userId, dto.productId, variantId);
        if (existing) {
            const updated = dto.notifyOnAvailable !== undefined || dto.note !== undefined
                ? await this.deps.wishlist.update(existing.id, {
                    ...(dto.notifyOnAvailable !== undefined && { notifyOnAvailable: dto.notifyOnAvailable }),
                    ...(dto.note !== undefined && { note: dto.note }),
                })
                : existing;
            return { item: this.toView(updated, card), created: false };
        }

        try {
            const row = await this.deps.wishlist.create({
                userId,
                productId: dto.productId,
                variantId,
                notifyOnAvailable: dto.notifyOnAvailable ?? false,
                note: dto.note ?? null,
            });
            return { item: this.toView(row, card), created: true };
        } catch (error) {
            // Two taps racing on the same heart: the unique index lets one in.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const row = await this.deps.wishlist.findOne(userId, dto.productId, variantId);
                if (row) return { item: this.toView(row, card), created: false };
            }
            throw error;
        }
    }

    /** PATCH /wishlist/:itemId */
    async update(userId: string, itemId: string, dto: UpdateWishlistItemDto): Promise<WishlistItemView> {
        const row = await this.deps.wishlist.findById(userId, itemId);
        if (!row) throw this.itemNotFound();
        const updated = await this.deps.wishlist.update(row.id, {
            ...(dto.notifyOnAvailable !== undefined && { notifyOnAvailable: dto.notifyOnAvailable }),
            ...(dto.note !== undefined && { note: dto.note }),
        });
        const cards = await this.cardsById([updated.productId]);
        return this.toView(updated, cards.get(updated.productId) ?? null);
    }

    /** DELETE /wishlist/:itemId */
    async remove(userId: string, itemId: string): Promise<void> {
        if ((await this.deps.wishlist.deleteById(userId, itemId)) === 0) throw this.itemNotFound();
    }

    /**
     * DELETE /wishlist/products/:productId — the heart's "off". Idempotent:
     * removing something not saved is not an error, so a double tap is safe.
     */
    async removeByProduct(userId: string, productId: string, variantId?: string): Promise<{ removed: number }> {
        return { removed: await this.deps.wishlist.deleteByProduct(userId, productId, variantId) };
    }

    private async requireViewableDrop(productId: string, variantId: string | null): Promise<WishlistDropCard> {
        const [card] = await this.deps.catalog.findCards([productId]);
        if (!card || !card.isViewable) {
            throw AppError.notFound('Drop not found.', SOCIAL_ERROR_CODES.PRODUCT_NOT_FOUND);
        }
        if (variantId && !card.variants.some((variant) => variant.id === variantId)) {
            throw AppError.notFound('That variant does not belong to this drop.', SOCIAL_ERROR_CODES.VARIANT_NOT_FOUND);
        }
        return card;
    }

    private async cardsById(ids: string[]): Promise<Map<string, WishlistDropCard>> {
        const cards = await this.deps.catalog.findCards(ids);
        return new Map(cards.map((card) => [card.id, card]));
    }

    private toView(row: WishlistItem, card: WishlistDropCard | null): WishlistItemView {
        const variant = row.variantId
            ? { id: row.variantId, label: card?.variants.find((v) => v.id === row.variantId)?.label ?? '' }
            : null;
        return {
            id: row.id,
            productId: row.productId,
            variant,
            notifyOnAvailable: row.notifyOnAvailable,
            note: row.note,
            addedAt: row.createdAt.toISOString(),
            product: card,
        };
    }

    private itemNotFound(): AppError {
        return AppError.notFound('Wishlist item not found.', SOCIAL_ERROR_CODES.WISHLIST_ITEM_NOT_FOUND);
    }
}

/**
 * @hitbox/social
 *
 * Social graph — artist/organization follows and wishlist items. This module
 * owns its Prisma partial under ./prisma, which shared/database merges into
 * the generated schema. The wishlist API is built (docs/mobile-app/wishlist-api.md);
 * follows are still schema-only.
 */
export const MODULE_NAME = 'social' as const;

export { createSocialModule } from './module';
export type { SocialModule, SocialModuleDeps } from './module';

export { SOCIAL_ERROR_CODES, SOCIAL_MODULE } from './constants/social.constant';
export type { IWishlistCatalog, WishlistDropCard } from './domain/interfaces/wishlist-catalog.interface';
export type { WishlistItemView } from './dto/wishlist.dto';

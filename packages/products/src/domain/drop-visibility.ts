/**
 * The two rules other screens need about one drop, kept in one place.
 *
 * Viewable — whether the public detail routes may show it. Wider than the
 * feeds' PUBLIC_PRODUCT_WHERE (ACTIVE only) on purpose: a buyer who owns a
 * unit of a drop that has since ENDED still opens its detail from their
 * collection, and a PUBLISHED drop can be previewed before its release window
 * opens. Drafts, anything in review or rejected, archived drops and drops
 * behind the `isActive` kill switch are never public.
 *
 * Purchasable — whether `POST /checkout` would accept it right now. Mirrors
 * the checks in orders' `placeOrder`; stock is not part of it (that is decided
 * unit by unit at checkout).
 */

const PUBLIC_DETAIL_STATUSES: ReadonlySet<string> = new Set(['PUBLISHED', 'ACTIVE', 'ENDED']);
const ON_SALE_STATUSES: ReadonlySet<string> = new Set(['PUBLISHED', 'ACTIVE']);

interface DropState {
    status: string;
    isActive: boolean;
    /** A Date from Prisma, or an ISO string when read back from the cache. */
    archivedAt: Date | string | null;
}

export function isPubliclyViewable(drop: DropState): boolean {
    return drop.isActive && drop.archivedAt === null && PUBLIC_DETAIL_STATUSES.has(drop.status);
}

/** Why a drop cannot be bought right now; null when it can. */
export type UnavailableReason = 'REMOVED' | 'NOT_ON_SALE' | 'NOT_RELEASED_YET' | 'CLOSED' | 'NO_PRICE';

export function unavailableReason(
    drop: DropState & { releaseStart: Date | string | null; releaseEnd: Date | string | null; hasPrice: boolean },
    now: Date,
): UnavailableReason | null {
    if (!drop.isActive || drop.archivedAt !== null) return 'REMOVED';
    if (!ON_SALE_STATUSES.has(drop.status)) return 'NOT_ON_SALE';
    if (drop.releaseStart && new Date(drop.releaseStart) > now) return 'NOT_RELEASED_YET';
    if (drop.releaseEnd && new Date(drop.releaseEnd) <= now) return 'CLOSED';
    if (!drop.hasPrice) return 'NO_PRICE';
    return null;
}

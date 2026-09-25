import { AppError } from '@hitbox/shared';
import { SKUS_ERROR_CODES } from '../constants/skus.constant';
import { Visibility } from './sku-access';
import type { SkuAccess } from './sku-access';

/**
 * A filter is a read of the column it names.
 *
 * This is the rule the rest of this file exists to enforce, and it is easy to
 * miss: the response projection in `sku.service.ts` carefully omits a tag UID
 * from a caller without `nfc-tag-claim` — and then a query string of
 * `?tagId=04A39B2C5D6E80` hands the same caller the answer anyway. One row
 * back means "that tag is on this unit". Zero rows means "it is not". The
 * filter did not return the secret; it let the caller ask yes/no questions
 * about it until they had it.
 *
 * So every filter naming a gated column is gated by the same grant that gates
 * the column in the response, and the two live next to each other so they
 * cannot drift apart.
 *
 * ## What is NOT gated, and why
 *
 * - `tagged`, `tagLifecycleState` — population facts, not identifying ones.
 *   "How many units are still waiting for a tag" is the documented way a Drop
 *   Manager drives a partial rollout, and no amount of asking it yields a UID.
 * - `hasOwner` — `claimedStatus=CLAIMED` already answers exactly this, so
 *   gating one and not the other would be theatre.
 * - Serial ranges, dates, product and variant ids — catalog facts, already in
 *   every response the caller can reach.
 */

/** Filters that only a caller who can see the tag block may use. */
const TAG_FILTERS = ['vendorId', 'provisioningBatchId'] as const;

/** Filters that additionally need the UID itself to be readable. */
const TAG_FULL_FILTERS = ['tagId'] as const;

/** Filters over the trust block, which a masked caller does not receive. */
const TRUST_FILTERS = ['resaleBlocked', 'tamperStatus', 'tampered'] as const;

/** Filters over buyer identity. FULL only — a masked caller sees `u-77213f…`. */
const BUYER_FULL_FILTERS = ['ownerId'] as const;

/** Any filter key this module gates, for documentation and tests. */
export const GATED_FILTERS = [
    ...TAG_FILTERS,
    ...TAG_FULL_FILTERS,
    ...TRUST_FILTERS,
    ...BUYER_FULL_FILTERS,
] as const;

type Query = Record<string, unknown>;

const used = (query: Query, key: string): boolean => query[key] !== undefined;

/**
 * Every gated filter in this query the caller may not use.
 *
 * Returned rather than thrown so the caller can be told the whole list at
 * once — a dashboard sending four filters should not need four round trips to
 * discover which two it may keep.
 */
export function forbiddenFilters(query: Query, access: SkuAccess): string[] {
    const refused: string[] = [];

    if (!access.tag) {
        refused.push(...TAG_FILTERS.filter((key) => used(query, key)));
    }
    if (!access.tag || access.tag.visibility !== Visibility.FULL) {
        refused.push(...TAG_FULL_FILTERS.filter((key) => used(query, key)));
    }
    if (access.instance.visibility !== Visibility.FULL) {
        refused.push(...TRUST_FILTERS.filter((key) => used(query, key)));
    }
    if (!access.buyer || access.buyer.visibility !== Visibility.FULL) {
        refused.push(...BUYER_FULL_FILTERS.filter((key) => used(query, key)));
    }

    return refused;
}

export function assertFiltersPermitted(query: Query, access: SkuAccess): void {
    const refused = forbiddenFilters(query, access);
    if (refused.length === 0) return;
    throw AppError.forbidden(
        `You may not filter by ${refused.join(', ')}: filtering a column is a read ` +
        'of it, and these are not shown to you.',
        SKUS_ERROR_CODES.FILTER_FORBIDDEN,
    );
}

/**
 * May the free-text `search` box match a full tag UID?
 *
 * The search term is matched against `skuCode`, the serial number and — for a
 * caller who may see tags — the normalised UID. Left ungated, `?search=04A3…`
 * would be `?tagId=04A3…` spelled differently, which is the same oracle the
 * rest of this file closes.
 */
export function searchMayMatchTag(access: SkuAccess): boolean {
    return access.tag !== null && access.tag.visibility === Visibility.FULL;
}

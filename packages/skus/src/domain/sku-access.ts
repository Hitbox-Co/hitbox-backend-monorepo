import { AppError } from '@hitbox/shared';
import { SKUS_ERROR_CODES } from '../constants/skus.constant';

/**
 * Turns "what the caller holds" into "how much of a serialized unit this
 * response may contain".
 *
 * A SKU row is the most sensitive record in the platform: it carries the
 * physical tag UID that proves an object is genuine, the identity of the person
 * holding that object, and the money they paid for it. Those are three
 * different secrets with three different audiences, so they are gated by three
 * different resources rather than by one "can you see SKUs" flag:
 *
 *   `collectible-instance` — the unit itself (serial, claim state, trust flags)
 *   `nfc-tag-claim`        — the tag UID and its custody chain
 *   `buyer-profile`        — who holds it
 *   `order` / `payment-royalty` — what it sold for
 *
 * The consequence worth stating out loud: a Brand Admin holds
 * `collectible-instance:manage:organization` but no `nfc-tag-claim` grant at
 * all, so they see every unit of their own drop and not one tag UID. That is
 * intended. Brands own the edition; HitBox owns the anti-counterfeiting
 * material.
 *
 * Nothing in this file names a role.
 */

/** How much of each reached record is visible. */
export const Visibility = {
    FULL: 'FULL',
    PARTIAL: 'PARTIAL',
    MASKED: 'MASKED',
    PUBLIC: 'PUBLIC',
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** Where a grant reaches. */
export const ReadScope = {
    GLOBAL: 'GLOBAL',
    ORGANIZATION: 'ORGANIZATION',
    OWN: 'OWN',
} as const;
export type ReadScope = (typeof ReadScope)[keyof typeof ReadScope];

export interface ResourceAccess {
    scope: ReadScope;
    visibility: Visibility;
}

/** The authenticated caller, as the guard describes them. */
export interface SkuPrincipal {
    userId: string;
    /** Canonical permission keys, e.g. `collectible-instance:manage:global`. */
    permissions: string[];
    roles: { roleId: string; roleName: string; organizationId: string | null }[];
}

const SCOPE_RANK: Record<string, number> = {
    own: 1,
    organization: 2,
    public: 3,
    masked: 4,
    masked_partial: 5,
    global: 6,
};

const SCOPE_TO_READ: Record<string, ReadScope> = {
    own: ReadScope.OWN,
    organization: ReadScope.ORGANIZATION,
    // The masking scopes reach every record; they differ in visibility only.
    public: ReadScope.GLOBAL,
    masked: ReadScope.GLOBAL,
    masked_partial: ReadScope.GLOBAL,
    global: ReadScope.GLOBAL,
};

const SCOPE_TO_VISIBILITY: Record<string, Visibility> = {
    own: Visibility.FULL,
    organization: Visibility.FULL,
    global: Visibility.FULL,
    masked_partial: Visibility.PARTIAL,
    masked: Visibility.MASKED,
    public: Visibility.PUBLIC,
};

/** `MANAGE` covers CRUD, so it satisfies a `read` question. */
const ACTION_SATISFIES_READ = new Set(['read', 'manage']);

/**
 * The strongest access the caller holds for `resource:action`, or null.
 *
 * Scope comes from the grant, never from the request — there is no parameter a
 * client can send to widen its own view.
 */
export function resolveAccess(
    principal: SkuPrincipal,
    resource: string,
    action = 'read',
): ResourceAccess | null {
    let best: { scope: string; rank: number } | null = null;

    for (const key of principal.permissions) {
        const [keyResource, keyAction, keyScope] = key.split(':');
        if (keyResource !== resource || !keyAction || !keyScope) continue;

        const satisfies =
            keyAction === action ||
            (action === 'read' && ACTION_SATISFIES_READ.has(keyAction));
        if (!satisfies) continue;

        const rank = SCOPE_RANK[keyScope] ?? 0;
        if (!best || rank > best.rank) best = { scope: keyScope, rank };
    }

    if (!best) return null;
    return {
        scope: SCOPE_TO_READ[best.scope] ?? ReadScope.OWN,
        visibility: SCOPE_TO_VISIBILITY[best.scope] ?? Visibility.FULL,
    };
}

/** The resolved view for one request. */
export interface SkuAccess {
    userId: string;
    /** The unit itself. Never null and never PUBLIC — see buildSkuAccess. */
    instance: ResourceAccess;
    /** Tag UID + custody chain, or null to omit the whole block. */
    tag: ResourceAccess | null;
    /** Holder identity, or null to omit the whole block. */
    buyer: ResourceAccess | null;
    /** Order linkage, or null to omit the whole block. */
    order: ResourceAccess | null;
    /** True when monetary figures may appear at all. */
    canSeeMoney: boolean;
    /** True when the caller may bind or rewrite a physical tag UID. */
    canManageTags: boolean;
    /**
     * True when the caller may edit a unit's own record — trust flags, variant,
     * listing state, archival.
     *
     * Resolved from `collectible-instance:manage` specifically, not from the
     * read grant: `HITBOX_CONTENT_MANAGER` holds
     * `collectible-instance:update:global`, and `update` neither implies `read`
     * nor is implied by it. The route guard checks the same capability, so this
     * is the second half of the same answer — asked here because the batch
     * endpoints have to refuse a field, not a route.
     */
    canManageUnits: boolean;
    /**
     * Organizations every query must be confined to, or null for an
     * unrestricted caller. Derived from the caller's own ORG assignments.
     */
    organizationIds: string[] | null;
}

/**
 * Builds the request's view, and refuses the two cases a plain capability
 * check would wave through.
 *
 * **PUBLIC is refused.** `BUYER_COLLECTOR` holds
 * `collectible-instance:read:public`, and PUBLIC scope has ALL breadth — so a
 * bare `requirePermission('collectible-instance:read')` on an admin route
 * admits every signed-in buyer on the platform. The route guard cannot tell
 * the difference; this can, because it looks at the scope of the grant that
 * matched rather than at the fact that one did.
 *
 * **OWN is refused** for the same reason in the other direction: an own-scoped
 * grant is a buyer reading their own shelf, which is the collections module's
 * job, not an operator surface.
 */
export function buildSkuAccess(principal: SkuPrincipal): SkuAccess {
    const instance = resolveAccess(principal, 'collectible-instance');
    if (
        !instance ||
        instance.visibility === Visibility.PUBLIC ||
        instance.scope === ReadScope.OWN
    ) {
        throw AppError.forbidden(
            'You do not have operator access to serialized units.',
            SKUS_ERROR_CODES.FORBIDDEN,
        );
    }

    const organizationIds =
        instance.scope === ReadScope.GLOBAL
            ? null
            : [
                ...new Set(
                    principal.roles
                        .map((role) => role.organizationId)
                        .filter((id): id is string => id !== null),
                ),
            ];

    return {
        userId: principal.userId,
        instance,
        tag: resolveAccess(principal, 'nfc-tag-claim'),
        buyer: resolveAccess(principal, 'buyer-profile'),
        order: resolveAccess(principal, 'order'),
        canSeeMoney: resolveAccess(principal, 'payment-royalty') !== null,
        canManageTags: resolveAccess(principal, 'nfc-tag-claim', 'manage') !== null,
        canManageUnits: resolveAccess(principal, 'collectible-instance', 'manage') !== null,
        organizationIds,
    };
}

// ── Masking ─────────────────────────────────────────────────────────────────

/** `u-77213f2a-…` -> `u-77213f…`; enough to correlate, not to identify. */
export function maskId(id: string): string {
    return `${id.slice(0, 8)}…`;
}

/**
 * `jane.doe@example.com` -> `j***@e***.com` (PARTIAL) or `***@***` (MASKED).
 *
 * PARTIAL keeps the first character of each half so an operator reading a
 * ticket can confirm "yes, that is the address the buyer quoted" without the
 * address itself ever being readable from the response.
 */
export function maskEmail(email: string, visibility: Visibility): string {
    if (visibility === Visibility.FULL) return email;
    if (visibility !== Visibility.PARTIAL) return '***@***';

    const at = email.indexOf('@');
    if (at <= 0) return '***@***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${local[0]}***@${domain[0]}***${tld}`;
}

/**
 * `04:A3:9B:2C:5D:6E:80` -> `04:A3…80`.
 *
 * A masked tag UID is still useful — it correlates two reports of the same tag
 * — but it cannot be written to a blank tag, which is the attack it exists to
 * prevent.
 */
export function maskTag(tagId: string): string {
    if (tagId.length <= 8) return '…';
    return `${tagId.slice(0, 5)}…${tagId.slice(-2)}`;
}

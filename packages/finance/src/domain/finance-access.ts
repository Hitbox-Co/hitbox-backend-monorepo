import { AppError } from '@hitbox/shared';
import { FINANCE_ERROR_CODES } from '../constants/finance.constant';

/**
 * Turns "what the caller holds" into "whose money this response may contain".
 *
 * The design document's RBAC requirement is one sentence — *"Artist can only
 * see own royalties, HitBox Admin sees all"* — and it is the single most
 * consequential rule in this module, because the thing being leaked is another
 * party's revenue. So it is resolved here, from the grant, and never from a
 * query parameter: there is no `?artistId=` a client can send to widen its own
 * view. The service applies the returned filter unconditionally.
 *
 * Nothing in this file names a role.
 */

export const FinanceScope = {
    /** `payment-royalty:read:global` — every payee, every order. */
    GLOBAL: 'GLOBAL',
    /** `:organization` — confined to the caller's own organizations. */
    ORGANIZATION: 'ORGANIZATION',
    /** `:own` — an artist reading their own accrual and nothing else. */
    OWN: 'OWN',
} as const;
export type FinanceScope = (typeof FinanceScope)[keyof typeof FinanceScope];

/** The authenticated caller, as the guard describes them. */
export interface FinancePrincipal {
    userId: string;
    /** Canonical permission keys, e.g. `payment-royalty:read:global`. */
    permissions: string[];
    roles: { roleId: string; roleName: string; organizationId: string | null }[];
}

export interface FinanceAccess {
    userId: string;
    scope: FinanceScope;
    /** Organizations the caller reaches, or null when unrestricted. */
    organizationIds: string[] | null;
    /** May create rules, schedule payouts, post adjustments. */
    canManage: boolean;
    /** May reverse a posting outside the normal calculation. */
    canOverride: boolean;
}

const SCOPE_RANK: Record<string, number> = { own: 1, organization: 2, global: 3 };

/** `manage` and `override` both imply `read`; `read` implies neither. */
const IMPLIES_READ = new Set(['read', 'manage', 'override', 'configure']);

function strongestScope(
    principal: FinancePrincipal,
    resource: string,
    action: string,
): string | null {
    let best: { scope: string; rank: number } | null = null;

    for (const key of principal.permissions) {
        const [keyResource, keyAction, keyScope] = key.split(':');
        if (keyResource !== resource || !keyAction || !keyScope) continue;

        const satisfies =
            keyAction === action || (action === 'read' && IMPLIES_READ.has(keyAction));
        if (!satisfies) continue;

        const rank = SCOPE_RANK[keyScope] ?? 0;
        if (!best || rank > best.rank) best = { scope: keyScope, rank };
    }
    return best?.scope ?? null;
}

/**
 * Builds the request's view, or refuses.
 *
 * A caller with no `payment-royalty` grant at all is refused outright rather
 * than handed an empty list: an empty page and a forbidden response mean very
 * different things to whoever is reading the screen, and "you have no
 * royalties" is a claim we should only make when it is true.
 */
export function buildFinanceAccess(principal: FinancePrincipal): FinanceAccess {
    const read = strongestScope(principal, 'payment-royalty', 'read');
    if (!read) {
        throw AppError.forbidden(
            'You do not have access to payment and royalty records.',
            FINANCE_ERROR_CODES.FORBIDDEN,
        );
    }

    const scope =
        read === 'global'
            ? FinanceScope.GLOBAL
            : read === 'organization'
                ? FinanceScope.ORGANIZATION
                : FinanceScope.OWN;

    const organizationIds =
        scope === FinanceScope.GLOBAL
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
        scope,
        organizationIds,
        canManage: strongestScope(principal, 'payment-royalty', 'manage') === 'global',
        canOverride: strongestScope(principal, 'payment-royalty', 'override') === 'global',
    };
}

/**
 * Refuses anything an ORG- or OWN-scoped caller must not do.
 *
 * Scheduling a payout, posting an adjustment and writing a rule are all
 * platform-level acts: they move money that is not the caller's and they are
 * global-only in the permission catalog. The route guard already checks the
 * capability, but a capability check alone cannot tell `:organization` from
 * `:global` — this can, and does.
 */
export function requireManage(access: FinanceAccess, action: string): void {
    if (!access.canManage) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            FINANCE_ERROR_CODES.FORBIDDEN,
        );
    }
}

export function requireOverride(access: FinanceAccess, action: string): void {
    if (!access.canOverride) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            FINANCE_ERROR_CODES.FORBIDDEN,
        );
    }
}

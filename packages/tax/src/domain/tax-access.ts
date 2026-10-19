import { AppError } from '@hitbox/shared';
import { TAX_ERROR_CODES } from '../constants/tax.constant';

/**
 * Turns "what the caller holds" into "whose tax records this response may
 * contain".
 *
 * Deliberately the same shape as `buildFinanceAccess`, because it answers the
 * same question about the same capability family — but it carries one extra
 * axis finance does not need: a **buyer**.
 *
 * A buyer is not a finance principal. They hold `order:read:own` and nothing in
 * the `payment-royalty` family at all, yet they must be able to fetch the
 * invoice for their own order — it is their legal receipt. So `TaxAccess` has a
 * `BUYER` scope that reaches exactly the invoices whose `buyerId` is the
 * caller, and no tax configuration, no filings, no other party's documents.
 * The buyer routes are mounted separately and resolve access through
 * `buildBuyerTaxAccess`, which cannot return anything wider.
 *
 * Nothing in this file names a role.
 */

export const TaxScope = {
    /** `payment-royalty:read:global` — every invoice, every filing. */
    GLOBAL: 'GLOBAL',
    /** `:organization` — confined to the caller's own organizations. */
    ORGANIZATION: 'ORGANIZATION',
    /** `:own` — an artist reading their own tax documents and filings. */
    OWN: 'OWN',
    /** `order:read:own` — a buyer reading the invoice for their own order. */
    BUYER: 'BUYER',
} as const;
export type TaxScope = (typeof TaxScope)[keyof typeof TaxScope];

/** The authenticated caller, as the guard describes them. */
export interface TaxPrincipal {
    userId: string;
    /** Canonical permission keys, e.g. `payment-royalty:read:global`. */
    permissions: string[];
    roles: { roleId: string; roleName: string; organizationId: string | null }[];
}

export interface TaxAccess {
    userId: string;
    scope: TaxScope;
    /** Organizations the caller reaches, or null when unrestricted. */
    organizationIds: string[] | null;
    /** May write tax configuration, issue/void invoices, create filings. */
    canManage: boolean;
    /** May approve a correction to an already-issued statutory figure. */
    canOverride: boolean;
    /** May export a return dataset out of the platform. */
    canExport: boolean;
}

const SCOPE_RANK: Record<string, number> = { own: 1, organization: 2, global: 3 };

/** `manage`, `override` and `configure` all imply `read`; `read` implies none. */
const IMPLIES_READ = new Set(['read', 'manage', 'override', 'configure']);

function strongestScope(
    principal: TaxPrincipal,
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

function organizationsOf(principal: TaxPrincipal): string[] {
    return [
        ...new Set(
            principal.roles
                .map((role) => role.organizationId)
                .filter((id): id is string => id !== null),
        ),
    ];
}

/**
 * The operator/artist view, for the `/admin/tax` surface.
 *
 * A caller with no `payment-royalty` grant is refused outright rather than
 * handed an empty list, same reasoning as finance: "you have no invoices" is a
 * claim worth only making when it is true.
 */
export function buildTaxAccess(principal: TaxPrincipal): TaxAccess {
    const read = strongestScope(principal, 'payment-royalty', 'read');
    if (!read) {
        throw AppError.forbidden(
            'You do not have access to tax and invoicing records.',
            TAX_ERROR_CODES.FORBIDDEN,
        );
    }

    const scope =
        read === 'global'
            ? TaxScope.GLOBAL
            : read === 'organization'
                ? TaxScope.ORGANIZATION
                : TaxScope.OWN;

    return {
        userId: principal.userId,
        scope,
        organizationIds: scope === TaxScope.GLOBAL ? null : organizationsOf(principal),
        canManage: strongestScope(principal, 'payment-royalty', 'manage') === 'global',
        canOverride: strongestScope(principal, 'payment-royalty', 'override') === 'global',
        canExport: strongestScope(principal, 'reports-dashboards', 'export') === 'global',
    };
}

/**
 * The buyer view, for the `/invoices` surface.
 *
 * Always BUYER scope and never anything else, even for a caller who also holds
 * `payment-royalty:read:global`. A finance operator browsing the buyer-facing
 * routes gets their own invoices there and uses `/admin/tax/invoices` for
 * everyone else's — which keeps "the widest grant wins" out of a surface whose
 * whole contract is "your own receipts".
 */
export function buildBuyerTaxAccess(principal: TaxPrincipal): TaxAccess {
    return {
        userId: principal.userId,
        scope: TaxScope.BUYER,
        organizationIds: [],
        canManage: false,
        canOverride: false,
        canExport: false,
    };
}

/**
 * Refuses anything an ORG-, OWN- or BUYER-scoped caller must not do.
 *
 * Writing a tax rate, issuing an invoice and marking a return filed are all
 * platform-level acts against a government, and they are global-only in the
 * permission catalog. The route guard already checks the capability, but a
 * capability check alone cannot tell `:organization` from `:global` — this can.
 */
export function requireTaxManage(access: TaxAccess, action: string): void {
    if (!access.canManage) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            TAX_ERROR_CODES.FORBIDDEN,
        );
    }
}

export function requireTaxOverride(access: TaxAccess, action: string): void {
    if (!access.canOverride) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            TAX_ERROR_CODES.FORBIDDEN,
        );
    }
}

export function requireTaxExport(access: TaxAccess, action: string): void {
    if (!access.canExport) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            TAX_ERROR_CODES.FORBIDDEN,
        );
    }
}

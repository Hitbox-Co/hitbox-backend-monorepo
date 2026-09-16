import { AppError } from '@hitbox/shared';
import { PAYMENTS_ERROR_CODES } from '../constants/payments.constant';

/**
 * Who may see and do what with money records.
 *
 * The design document is explicit that the refund workflow is HitBox-only —
 * *"Only HitBox Admins see refund workflow; Artist cannot access"* — and that
 * gateway configuration is narrower still. Both are resolved here from the
 * caller's grants rather than from a role name, so adding a role never means
 * editing this file.
 */

export const PaymentScope = {
    GLOBAL: 'GLOBAL',
    ORGANIZATION: 'ORGANIZATION',
    OWN: 'OWN',
} as const;
export type PaymentScope = (typeof PaymentScope)[keyof typeof PaymentScope];

export interface PaymentPrincipal {
    userId: string;
    permissions: string[];
    roles: { roleId: string; roleName: string; organizationId: string | null }[];
}

export interface PaymentAccess {
    userId: string;
    scope: PaymentScope;
    organizationIds: string[] | null;
    /** `payment-royalty:manage:global` — review a charge, resolve a dispute. */
    canManage: boolean;
    /** `payment-royalty:configure:global` — gateway credentials binding. */
    canConfigure: boolean;
    /** `order:refund:global` — approve and execute a refund. */
    canRefund: boolean;
}

const SCOPE_RANK: Record<string, number> = { own: 1, organization: 2, global: 3 };
const IMPLIES_READ = new Set(['read', 'manage', 'configure', 'override', 'refund']);

function strongestScope(
    principal: PaymentPrincipal,
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

export function buildPaymentAccess(principal: PaymentPrincipal): PaymentAccess {
    const read = strongestScope(principal, 'payment-royalty', 'read');
    if (!read) {
        throw AppError.forbidden(
            'You do not have access to payment records.',
            PAYMENTS_ERROR_CODES.FORBIDDEN,
        );
    }

    const scope =
        read === 'global'
            ? PaymentScope.GLOBAL
            : read === 'organization'
                ? PaymentScope.ORGANIZATION
                : PaymentScope.OWN;

    return {
        userId: principal.userId,
        scope,
        organizationIds:
            scope === PaymentScope.GLOBAL
                ? null
                : [
                    ...new Set(
                        principal.roles
                            .map((role) => role.organizationId)
                            .filter((id): id is string => id !== null),
                    ),
                ],
        canManage: strongestScope(principal, 'payment-royalty', 'manage') === 'global',
        canConfigure: strongestScope(principal, 'payment-royalty', 'configure') === 'global',
        canRefund: strongestScope(principal, 'order', 'refund') === 'global',
    };
}

export function requireManage(access: PaymentAccess, action: string): void {
    if (!access.canManage) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            PAYMENTS_ERROR_CODES.FORBIDDEN,
        );
    }
}

export function requireConfigure(access: PaymentAccess, action: string): void {
    if (!access.canConfigure) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            PAYMENTS_ERROR_CODES.FORBIDDEN,
        );
    }
}

/**
 * The refund gate. Separate from `manage` on purpose: reviewing a parked
 * charge and sending money back out of the platform are different powers, and
 * the permission catalog already keeps `order:refund:global` apart from
 * `payment-royalty:manage:global` for exactly that reason.
 */
export function requireRefund(access: PaymentAccess, action: string): void {
    if (!access.canRefund) {
        throw AppError.forbidden(
            `You do not have permission to ${action}.`,
            PAYMENTS_ERROR_CODES.FORBIDDEN,
        );
    }
}

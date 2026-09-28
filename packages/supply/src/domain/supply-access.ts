import { AppError } from '@hitbox/shared';
import { SUPPLY_ERROR_CODES } from '../constants/supply.constant';

/**
 * Turns "what the caller holds" into "how much of the supply chain this
 * response may contain".
 *
 * Three different secrets live in this module, with three different audiences,
 * so they are gated by three resources rather than by one "can you see supply"
 * flag:
 *
 *   `drop`            — consignment headers: who shipped what, when, how many
 *   `nfc-tag-claim`   — the chip inventory itself: UIDs, QC verdicts, custody
 *   `reports-dashboards` — the aggregate rollup, with no row-level detail
 *
 * The consequence worth stating out loud: `HITBOX_DROP_MANAGER` holds
 * `drop:manage:global` and no `nfc-tag-claim` grant at all, so they see every
 * consignment on the platform and not one chip record. That is intended.
 * Whoever plans the drop needs to know 5,000 chips arrived; they do not need
 * to know which 5,000.
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
export interface SupplyPrincipal {
    userId: string;
    /** Canonical permission keys, e.g. `nfc-tag-claim:manage:global`. */
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
    principal: SupplyPrincipal,
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
export interface SupplyAccess {
    userId: string;
    /**
     * Consignment headers. Null when the caller reaches none — the vendor and
     * batch routes then refuse, and the metrics rollup omits those blocks.
     */
    consignment: ResourceAccess | null;
    /** The chip inventory, or null to omit the whole block. */
    tag: ResourceAccess | null;
    /** The aggregate rollup, or null to refuse the metrics route outright. */
    reporting: ResourceAccess | null;
    /** True when the caller may record intake — vendors, batches, manifests, QC. */
    canWrite: boolean;
    /**
     * Organizations every query must be confined to, or null for an
     * unrestricted caller. Derived from the caller's own ORG assignments.
     */
    organizationIds: string[] | null;
}

/**
 * Builds the request's view.
 *
 * The one thing this does that a route guard cannot: it looks at the **scope
 * of the grant that matched**, not merely at the fact that one did.
 *
 * That matters because `BUYER_COLLECTOR` holds `drop:read:public`, and PUBLIC
 * scope has ALL breadth in this system — visibility is what PUBLIC narrows,
 * not reach. So a bare `requirePermission('drop:read')` on an operator route
 * admits every signed-in buyer on the platform. `PUBLIC` and `OWN` are
 * therefore discarded here rather than trusted, and a caller left holding
 * nothing is refused by the callers below.
 */
export function buildSupplyAccess(principal: SupplyPrincipal): SupplyAccess {
    const consignment = operatorGrade(resolveAccess(principal, 'drop'));
    const tag = operatorGrade(resolveAccess(principal, 'nfc-tag-claim'));
    const reporting = resolveAccess(principal, 'reports-dashboards');

    // Unrestricted only when some grant the caller actually holds reaches
    // GLOBAL. Resolved across all three so an org-scoped `drop` grant plus a
    // global reporting grant does not silently confine the rollup.
    const hasGlobalReach = [consignment, tag, reporting].some(
        (entry) => entry?.scope === ReadScope.GLOBAL,
    );

    const organizationIds = hasGlobalReach
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
        consignment,
        tag,
        reporting,
        canWrite: resolveAccess(principal, 'nfc-tag-claim', 'manage') !== null,
        organizationIds,
    };
}

/**
 * Discards a grant that is not an operator grant.
 *
 * PUBLIC is a storefront grant and OWN is a buyer reading their own shelf;
 * neither is a reason to see who manufactures the platform's chips.
 */
function operatorGrade(access: ResourceAccess | null): ResourceAccess | null {
    if (!access) return null;
    if (access.visibility === Visibility.PUBLIC) return null;
    if (access.scope === ReadScope.OWN) return null;
    return access;
}

/** Refuses a caller who reaches no consignment at all. */
export function requireConsignmentAccess(access: SupplyAccess): ResourceAccess {
    if (!access.consignment) {
        throw AppError.forbidden(
            'You do not have operator access to supply consignments.',
            SUPPLY_ERROR_CODES.FORBIDDEN,
        );
    }
    return access.consignment;
}

/**
 * Refuses a caller who reaches consignments but not the whole platform.
 *
 * The vendor directory is platform-level and stays that way. A brand may see
 * the consignments ordered for *their own drops* — that is their supply — but
 * who HitBox buys chips from, on what terms and at which contact address is a
 * commercial relationship of the platform's, not of theirs. Confining the
 * directory to "vendors who have shipped to you" would still disclose the
 * relationship, so the directory is refused outright instead.
 */
export function requireGlobalConsignmentAccess(access: SupplyAccess): ResourceAccess {
    const consignment = requireConsignmentAccess(access);
    if (consignment.scope !== ReadScope.GLOBAL) {
        throw AppError.forbidden(
            'The vendor directory is platform-wide; your access is limited to your own organization.',
            SUPPLY_ERROR_CODES.FORBIDDEN,
        );
    }
    return consignment;
}

/** Refuses a caller who reaches no chip inventory. */
export function requireTagAccess(access: SupplyAccess): ResourceAccess {
    if (!access.tag) {
        throw AppError.forbidden(
            'You do not have operator access to the NFC tag inventory.',
            SUPPLY_ERROR_CODES.FORBIDDEN,
        );
    }
    return access.tag;
}

/** Refuses a caller who holds no reporting grant. */
export function requireReportingAccess(access: SupplyAccess): ResourceAccess {
    if (!access.reporting) {
        throw AppError.forbidden(
            'You do not have permission to view supply metrics.',
            SUPPLY_ERROR_CODES.FORBIDDEN,
        );
    }
    return access.reporting;
}

/** Refuses a caller who may read intake but not record it. */
export function requireWrite(access: SupplyAccess): void {
    if (!access.canWrite) {
        throw AppError.forbidden(
            'You do not have permission to record supply intake.',
            SUPPLY_ERROR_CODES.FORBIDDEN,
        );
    }
}

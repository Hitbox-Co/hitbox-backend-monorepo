import { RoleScopeType } from '@hitbox/database';
import type { PermissionAction, PermissionScope, ResourceType } from '@hitbox/database';
import {
    SCOPE_REACH,
    ScopeBreadth,
    VISIBILITY_RANK,
    actionSatisfies,
} from '../domain/permission-catalog';
import type { ScopeVisibility } from '../domain/permission-catalog';
import { formatCapability } from '../domain/permission-key';
import type { Principal, PrincipalGrant } from '../domain/interfaces/principal-grants.interface';

/**
 * THE AUTHORIZATION ENGINE.
 *
 * One pure function decides every access question in the platform. It is
 * deliberately free of Express, Prisma and role names: given a principal's
 * grants and a description of the thing being touched, it answers ALLOW or
 * DENY and — when allowed — *how much* of the record the caller may reveal.
 *
 * Design rules it implements:
 *   • Default deny. No grant matched ⇒ denied. There is no bypass, no
 *     super-user short-circuit, no role-name special case.
 *   • Capability, not role. Callers ask for `order:refund`; the engine finds
 *     whichever of the principal's grants satisfies it.
 *   • Scope is resolved, not dictated. The same endpoint serves a buyer
 *     holding `order:read:own` and an admin holding `order:read:global`.
 *   • Best visibility wins. A principal holding a capability at two
 *     visibilities gets the more revealing one, and the decision reports it
 *     so the controller can mask consistently.
 */

/** What is being accessed. Omitted fields mean "not applicable". */
export interface AccessContext {
    /**
     * Organization the target record belongs to. Required for an ORG-scoped
     * grant to match; absent means the resource is not org-owned.
     */
    organizationId?: string | null;
    /**
     * User who owns the target record. Required for an OWN-scoped grant to
     * match.
     */
    ownerId?: string | null;
}

export interface AccessRequest {
    resource: ResourceType;
    action: PermissionAction;
    context?: AccessContext;
}

export interface AccessGrantDetail {
    /** The PermissionScope of the grant that allowed this. */
    scope: PermissionScope;
    /** Derived from the scope — what the caller may reveal. */
    visibility: ScopeVisibility;
    roleName: string;
    roleId: string;
    /** Organization the matching assignment was scoped to, if any. */
    organizationId: string | null;
    /** Column-level narrowing, empty when unrestricted. */
    fieldAllowlist: string[];
}

export type AccessDecision =
    | ({ allowed: true; reason: string } & AccessGrantDetail)
    | { allowed: false; reason: string };

/**
 * Does this grant reach the record described by `context`?
 *
 * Breadth only — visibility is not a gate, it is the *result* of a match
 * (a masked grant still reaches the record, it just reveals less of it).
 */
function reaches(
    grant: PrincipalGrant,
    principalUserId: string,
    context: AccessContext,
): { ok: true } | { ok: false; reason: string } {
    const { breadth } = SCOPE_REACH[grant.scope];

    switch (breadth) {
        case ScopeBreadth.ALL:
            // A GLOBAL-breadth permission still has to arrive through an
            // assignment wide enough to carry it: an ORG-scoped assignment
            // cannot confer platform-wide reach. This is what stops a brand
            // admin from being granted a global role "within" their org.
            if (grant.assignmentScopeType === RoleScopeType.ORGANIZATION) {
                return {
                    ok: false,
                    reason: `grant ${grant.roleName} is platform-scoped but was assigned only within an organization`,
                };
            }
            return { ok: true };

        case ScopeBreadth.ORGANIZATION: {
            if (grant.assignmentScopeType === RoleScopeType.GLOBAL) {
                // A globally-assigned role carrying an ORG-scoped permission
                // reaches every organization (e.g. HitBox staff roles).
                return { ok: true };
            }
            if (!grant.assignmentScopeId) {
                return {
                    ok: false,
                    reason: `organization-scoped assignment of ${grant.roleName} has no organization id`,
                };
            }
            if (!context.organizationId) {
                return {
                    ok: false,
                    reason: 'organization-scoped grant requires an organization context',
                };
            }
            if (grant.assignmentScopeId !== context.organizationId) {
                return {
                    ok: false,
                    reason: 'record belongs to a different organization',
                };
            }
            return { ok: true };
        }

        case ScopeBreadth.SELF: {
            if (!context.ownerId) {
                return {
                    ok: false,
                    reason: 'own-scoped grant requires an owner context',
                };
            }
            if (context.ownerId !== principalUserId) {
                return { ok: false, reason: 'record belongs to another user' };
            }
            return { ok: true };
        }
    }
}

/** Turn a matching grant into the allowed decision's payload. */
function toDetail(grant: PrincipalGrant): AccessGrantDetail {
    return {
        scope: grant.scope,
        visibility: SCOPE_REACH[grant.scope].visibility,
        roleName: grant.roleName,
        roleId: grant.roleId,
        organizationId: grant.assignmentScopeId,
        fieldAllowlist: grant.fieldAllowlist,
    };
}

/**
 * The decision. Pure — no I/O, no clock, no globals — so it is exhaustively
 * testable and safe to call several times per request.
 */
export function decide(principal: Principal, request: AccessRequest): AccessDecision {
    const context = request.context ?? {};
    const capability = formatCapability(request);

    // Candidates: grants for this resource whose action covers the request.
    const candidates = principal.grants.filter(
        (grant) =>
            grant.resource === request.resource &&
            actionSatisfies(grant.action, request.action),
    );

    if (candidates.length === 0) {
        return {
            allowed: false,
            reason: `no grant for ${capability}`,
        };
    }

    let best: PrincipalGrant | null = null;
    const rejections: string[] = [];

    for (const grant of candidates) {
        const reach = reaches(grant, principal.userId, context);
        if (!reach.ok) {
            rejections.push(reach.reason);
            continue;
        }
        if (
            best === null ||
            VISIBILITY_RANK[SCOPE_REACH[grant.scope].visibility] >
            VISIBILITY_RANK[SCOPE_REACH[best.scope].visibility]
        ) {
            best = grant;
        }
    }

    if (!best) {
        return {
            allowed: false,
            // Distinct from "no grant": the principal HAS the capability but
            // not for this record. Worth separating in the audit trail.
            reason: `holds ${capability} but out of scope — ${[...new Set(rejections)].join('; ')}`,
        };
    }

    return {
        allowed: true,
        reason: `granted by ${best.roleName} at ${best.scope}`,
        ...toDetail(best),
    };
}

/** Convenience boolean for call sites that do not need the scope back. */
export function can(principal: Principal, request: AccessRequest): boolean {
    return decide(principal, request).allowed;
}

/**
 * Every capability the principal holds, as canonical permission keys. Backs
 * `GET /authz/me` so a client can drive its own UI without guessing.
 */
export function effectivePermissionKeys(principal: Principal): string[] {
    const keys = new Set<string>();
    for (const grant of principal.grants) {
        keys.add(
            `${formatCapability(grant)}:${grant.scope.toLowerCase().replace(/_/g, '-')}`,
        );
    }
    return [...keys].sort();
}

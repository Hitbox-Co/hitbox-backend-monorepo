import { AppError } from '@hitbox/shared';
import { ACCESS_CONTROL_ERROR_CODES } from '../constants/access-control.constant';

/**
 * May this administrator hand out this role?
 *
 * The rule is **no privilege escalation**: you cannot grant a permission you do
 * not hold yourself. Without it, the weakest holder of
 * `employee-role-mgmt:assign` could mint an account with more power than their
 * own and then sign in as it — which turns "can manage their own team" into
 * "can become a platform administrator" in two API calls.
 *
 * ## Why this is needed even though the engine already checks scope
 *
 * `authorization-engine.ts` refuses to let an ORGANIZATION-scoped assignment
 * confer platform-wide reach, so a Brand Admin who granted someone
 * `HITBOX_SYSTEM_ADMIN` inside their own organization would produce an
 * assignment whose permissions all fail at use time — every permission in that
 * particular role happens to be `:global`.
 *
 * That is a real mitigation, but it is an accident of one role's contents
 * rather than a rule. A role holding `:organization`-breadth permissions the
 * granter lacks would escalate successfully, and nothing today stops a future
 * role being defined that way. So the check belongs where the decision is made,
 * stated as the rule it is.
 *
 * ## What it deliberately does NOT do
 *
 * It does not compare roles, seniority, or names — there is no hierarchy in
 * this system and inventing one here would contradict §15. It compares
 * *permission sets*: the granter's effective keys against the role's. Two
 * administrators with identical permissions can grant each other's roles freely;
 * a narrower one simply cannot widen anybody.
 */

/** A permission key as the catalog writes it: `resource:action:scope`. */
type PermissionKey = string;

const SCOPE_RANK: Record<string, number> = {
    own: 1,
    'masked': 1,
    'masked-partial': 2,
    public: 1,
    organization: 2,
    global: 3,
};

/** `MANAGE` contains the four CRUD verbs — the one implication in the system. */
const ACTION_IMPLIES: Record<string, string[]> = {
    manage: ['create', 'read', 'update', 'delete'],
};

function parse(key: PermissionKey): { resource: string; action: string; scope: string } | null {
    const [resource, action, scope] = key.split(':');
    if (!resource || !action || !scope) return null;
    return { resource, action, scope };
}

/**
 * Does the granter's permission set cover this single required permission?
 *
 * Two ways to cover, and the second one is the interesting half:
 *
 *   **Hold it.** Same resource, an action that satisfies the required one
 *   (identical, or `manage` covering a CRUD verb), at a scope at least as wide.
 *
 *   **Administer it, and delegate narrower.** Holding `manage` on the resource
 *   at a *strictly wider* scope covers any action on it. This is what lets a
 *   platform administrator staff a brand: `HITBOX_SYSTEM_ADMIN` holds
 *   `release-approval:manage:global` but deliberately not
 *   `release-approval:approve:*` — approving a release is the brand's job, not
 *   the platform's — and without this clause it could not grant `BRAND_ADMIN`,
 *   which is most of what it exists to do.
 *
 * The "strictly wider" part is what keeps that from becoming a hole.
 * `payment-royalty:manage:global` does NOT cover
 * `payment-royalty:override:global`: override is a separate power at the same
 * scope, and letting manage confer it would mean anyone who administers
 * payments could grant themselves the ability to override one. Delegating
 * downwards is administration; acquiring a sibling power at your own level is
 * escalation.
 */
function covers(held: PermissionKey[], required: PermissionKey): boolean {
    const want = parse(required);
    if (!want) return false;

    // A SELF-scoped permission acts only on the holder's own records — the
    // engine refuses it without an owner context that matches the caller. So it
    // confers nothing over anybody else and cannot be an escalation vector:
    // granting someone the right to organise their own collection does not
    // widen the granter's reach or the grantee's reach over others.
    //
    // Without this, `HITBOX_SYSTEM_ADMIN` could not grant the ordinary buyer
    // role, because it holds `my-collections:read:global` (view any buyer's
    // collection) and deliberately not `my-collections:manage:own` — it has no
    // collection of its own to organise.
    if (want.scope === 'own') return true;

    const wantRank = SCOPE_RANK[want.scope] ?? 0;

    return held.some((key) => {
        const have = parse(key);
        if (!have || have.resource !== want.resource) return false;
        const haveRank = SCOPE_RANK[have.scope] ?? 0;

        const actionOk =
            have.action === want.action ||
            (ACTION_IMPLIES[have.action] ?? []).includes(want.action);
        if (actionOk) return haveRank >= wantRank;

        // Administering a resource platform-wide lets you delegate any power
        // over it at a narrower scope — but never at your own.
        return have.action === 'manage' && haveRank > wantRank;
    });
}

/**
 * Every permission in `rolePermissions` that the granter cannot cover.
 *
 * Returned rather than thrown so the caller can log the full list once and
 * surface a couple of examples — an administrator told only "denied" will file
 * a ticket, and one told which permissions they are short of will not.
 */
export function uncoveredPermissions(
    granterPermissions: PermissionKey[],
    rolePermissions: PermissionKey[],
): PermissionKey[] {
    return rolePermissions.filter((required) => !covers(granterPermissions, required));
}

/**
 * Refuses the grant unless the granter holds everything the role confers.
 *
 * `roleName` is only used in the message; the decision is made on permissions.
 */
export function assertCanGrantRole(input: {
    granterPermissions: PermissionKey[];
    roleName: string;
    rolePermissions: PermissionKey[];
}): void {
    const missing = uncoveredPermissions(input.granterPermissions, input.rolePermissions);
    if (missing.length === 0) return;

    const examples = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` (and ${missing.length - 3} more)` : '';
    throw AppError.forbidden(
        `You cannot grant ${input.roleName}: it carries permissions you do not hold ` +
        `yourself — ${examples}${rest}. Ask an administrator who holds them.`,
        ACCESS_CONTROL_ERROR_CODES.FORBIDDEN,
    );
}

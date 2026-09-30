import { actionSatisfies, decide } from '@hitbox/access-control';
import { parseCapability, parsePermissionKeyOrThrow } from '@hitbox/access-control';
import { ROLE_CATALOG } from '@hitbox/access-control';
import {
    RELEASE_DECISION_CAPABILITIES,
    RELEASE_OVERRIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASE_SUBMIT_CAPABILITY,
} from '../src/constants/releases.constant';

/**
 * Does the role catalog actually let the right people through the route gates?
 *
 * This exists because it did not. The decision route was gated on
 * `release-approval:manage`, and `approve` neither is nor implies `manage` —
 * so ARTIST and BRAND_ADMIN, the two roles the whole authority rule exists to
 * serve, got a 403 before the service was ever reached. A unit test of
 * `canApprove` could not catch it: that function was correct, and unreachable.
 */

const permissionsOf = (roleName: string): string[] =>
    ROLE_CATALOG.find((role) => role.name === roleName)?.permissions ?? [];

/** Would the guard let this role through a route requiring any of these? */
function passes(roleName: string, capabilities: readonly string[]): boolean {
    const held = permissionsOf(roleName).map((key) => parsePermissionKeyOrThrow(key));
    return capabilities.some((capability) => {
        const required = parseCapability(capability);
        if (!required) throw new Error(`"${capability}" is not a valid capability.`);
        return held.some(
            (grant) =>
                grant.resource === required.resource &&
                actionSatisfies(grant.action, required.action),
        );
    });
}

describe('the decision route admits everyone the authority rule needs', () => {
    it.each(['ARTIST', 'BRAND_ADMIN'])(
        'lets %s reach the decision endpoint',
        (role) => {
            // The regression. These roles hold approve/reject and NOT manage.
            expect(passes(role, RELEASE_DECISION_CAPABILITIES)).toBe(true);
        },
    );

    it('lets HITBOX_SYSTEM_ADMIN reach it', () => {
        expect(passes('HITBOX_SYSTEM_ADMIN', RELEASE_DECISION_CAPABILITIES)).toBe(true);
    });

    it('keeps BRAND_EMPLOYEE out — read-only on releases by design', () => {
        expect(passes('BRAND_EMPLOYEE', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('keeps HITBOX_DROP_MANAGER out of deciding', () => {
        // They manage drops, not approvals. They can submit, not sign off.
        expect(passes('HITBOX_DROP_MANAGER', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('keeps a buyer out', () => {
        expect(passes('BUYER_COLLECTOR', RELEASE_DECISION_CAPABILITIES)).toBe(false);
    });

    it('would have BLOCKED artists under the old manage-only gate', () => {
        // Locks in the reason this file exists, so nobody "simplifies" the
        // route back to a single capability.
        expect(passes('ARTIST', ['release-approval:manage'])).toBe(false);
        expect(passes('BRAND_ADMIN', ['release-approval:manage'])).toBe(false);
    });
});

describe('the submit route admits everyone who owns a drop', () => {
    it.each(['ARTIST', 'BRAND_ADMIN', 'BRAND_EMPLOYEE', 'HITBOX_DROP_MANAGER', 'HITBOX_SYSTEM_ADMIN'])(
        'lets %s submit a drop for review',
        (role) => {
            expect(passes(role, [RELEASE_SUBMIT_CAPABILITY])).toBe(true);
        },
    );

    it('keeps a buyer out', () => {
        // `drop:read:public` is not `drop:manage`.
        expect(passes('BUYER_COLLECTOR', [RELEASE_SUBMIT_CAPABILITY])).toBe(false);
    });

    it('would have BLOCKED the Drop Manager under the old release-capability gate', () => {
        expect(passes('HITBOX_DROP_MANAGER', ['release-approval:manage'])).toBe(false);
    });
});

describe('reopen stays a platform-only power', () => {
    it('admits HITBOX_SYSTEM_ADMIN alone', () => {
        const admitted = ROLE_CATALOG
            .filter((role) => passes(role.name, [RELEASE_OVERRIDE_CAPABILITY]))
            .map((role) => role.name);
        expect(admitted).toEqual(['HITBOX_SYSTEM_ADMIN']);
    });
});

describe('the read route', () => {
    it.each(['ARTIST', 'BRAND_ADMIN', 'BRAND_EMPLOYEE', 'HITBOX_DROP_MANAGER', 'HITBOX_SYSTEM_ADMIN'])(
        'admits %s',
        (role) => {
            expect(passes(role, [RELEASE_READ_CAPABILITY])).toBe(true);
        },
    );
});

/**
 * Holding the capability is not reaching the route.
 *
 * The tests above ask "does this role hold something that satisfies the gate",
 * and answer yes for ARTIST — which is why they passed while an artist still
 * could not approve anything. They compare resource and action and *ignore
 * scope*, and scope is where the second failure lived.
 *
 * `requirePermission(capability)` with no `context` hands the engine `{}`, and
 * `reaches()` then rejects every non-global grant: an organization-scoped grant
 * "requires an organization context", an own-scoped one "requires an owner
 * context". So the whole releases router admitted platform staff only. ARTIST
 * and BRAND_ADMIN hold `release-approval:*` at `:organization`, so the roles
 * the authority rule exists to serve were locked out one layer above it —
 * the same shape of bug as the one this file was written for, one level down.
 *
 * These run the real engine, so they fail if a route ever drops its context
 * again.
 */
describe('an organization-scoped role reaches the route only with a context', () => {
    const ORG = 'org-1';

    /** The grants a role assigned within one organization actually carries. */
    const grantsFor = (roleName: string, assignment: 'ORGANIZATION' | 'GLOBAL') =>
        permissionsOf(roleName)
            .map((key) => parsePermissionKeyOrThrow(key))
            .map((permission) => ({
                resource: permission.resource,
                action: permission.action,
                scope: permission.scope,
                domain: 'BUSINESS',
                roleId: 'role-1',
                roleName,
                roleDomain: 'BUSINESS',
                assignmentScopeType: assignment,
                assignmentScopeId: assignment === 'ORGANIZATION' ? ORG : null,
                fieldAllowlist: [],
            }));

    const reaches = (
        roleName: string,
        capabilities: readonly string[],
        context: Record<string, string | null>,
        assignment: 'ORGANIZATION' | 'GLOBAL' = 'ORGANIZATION',
    ): boolean => {
        const principal = { userId: 'user-1', grants: grantsFor(roleName, assignment) };
        return capabilities.some((capability) => {
            const parsed = parseCapability(capability);
            if (!parsed) throw new Error(`"${capability}" is not a valid capability.`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return decide(principal as any, { ...parsed, context } as any).allowed;
        });
    };

    it.each(['ARTIST', 'BRAND_ADMIN'])(
        '%s is refused the decision route when it states no context',
        (role) => {
            // The regression: this is what every route in the module did.
            expect(reaches(role, RELEASE_DECISION_CAPABILITIES, {})).toBe(false);
        },
    );

    it.each(['ARTIST', 'BRAND_ADMIN'])(
        '%s reaches the decision route once the record names its organization',
        (role) => {
            expect(reaches(role, RELEASE_DECISION_CAPABILITIES, { organizationId: ORG })).toBe(true);
        },
    );

    it('still refuses a role acting for a different organization', () => {
        expect(
            reaches('ARTIST', RELEASE_DECISION_CAPABILITIES, { organizationId: 'org-someone-else' }),
        ).toBe(false);
    });

    it.each([
        ['the review queue', [RELEASE_READ_CAPABILITY]],
        ['submission', [RELEASE_SUBMIT_CAPABILITY]],
    ])('ARTIST reaches %s only with an organization context', (_label, capabilities) => {
        expect(reaches('ARTIST', capabilities, {})).toBe(false);
        expect(reaches('ARTIST', capabilities, { organizationId: ORG })).toBe(true);
    });

    it('platform staff are unaffected — a global grant needs no context', () => {
        // Which is exactly why this went unnoticed: every test and every
        // manual check ran as an administrator.
        expect(reaches('HITBOX_SYSTEM_ADMIN', RELEASE_DECISION_CAPABILITIES, {}, 'GLOBAL')).toBe(true);
    });
});

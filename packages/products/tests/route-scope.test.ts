import { decide, parseCapability, parsePermissionKeyOrThrow, ROLE_CATALOG } from '@hitbox/access-control';
import {
    PRODUCT_READ_CAPABILITY,
    PRODUCT_WRITE_CAPABILITY,
} from '../src/constants/products.constant';

/**
 * Can the people who own a drop actually open it?
 *
 * `GET /admin/products/:id` was guarded with the bare `drop:read` capability
 * and no context. The engine rejects an organization-scoped grant when the
 * request names no organization, so the detail screen admitted platform staff
 * only — and an artist could be asked to approve a drop and then get a 403
 * trying to look at it, which is what happened.
 *
 * Two things make this easy to get wrong and worth pinning:
 *
 *   - **No `drop:read:organization` exists in the catalog.** An artist and a
 *     Brand Admin reach `drop:read` only through `drop:manage:organization`,
 *     via the single sanctioned MANAGE ⇒ READ implication. A test that checks
 *     "does this role hold drop:read" would therefore say no and be wrong, and
 *     a test that checks resource+action while ignoring scope would say yes
 *     and also be wrong. Only the real engine answers it.
 *
 *   - **Writes must stay platform-only.** They are `globalOnly`, which is
 *     checked after the decision, so an organization-scoped MANAGE grant that
 *     now reaches the guard must still be refused.
 */

const ORG = 'org-1';

const grantsFor = (roleName: string, assignment: 'ORGANIZATION' | 'GLOBAL' = 'ORGANIZATION') =>
    (ROLE_CATALOG.find((role) => role.name === roleName)?.permissions ?? [])
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

function attempt(
    roleName: string,
    capability: string,
    context: Record<string, string | null>,
    assignment: 'ORGANIZATION' | 'GLOBAL' = 'ORGANIZATION',
) {
    const parsed = parseCapability(capability);
    if (!parsed) throw new Error(`"${capability}" is not a valid capability.`);
    const principal = { userId: 'user-1', grants: grantsFor(roleName, assignment) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return decide(principal as any, { ...parsed, context } as any);
}

describe('the drop detail screen is reachable by the drop’s own people', () => {
    it.each(['ARTIST', 'BRAND_ADMIN'])(
        '%s is refused when the route states no context',
        (role) => {
            // The regression this file exists for.
            expect(attempt(role, PRODUCT_READ_CAPABILITY, {}).allowed).toBe(false);
        },
    );

    it.each(['ARTIST', 'BRAND_ADMIN'])(
        '%s reads it once the route names the drop’s organization',
        (role) => {
            expect(attempt(role, PRODUCT_READ_CAPABILITY, { organizationId: ORG }).allowed).toBe(
                true,
            );
        },
    );

    it('reads it through MANAGE, since no drop:read:organization exists', () => {
        const held = (ROLE_CATALOG.find((r) => r.name === 'ARTIST')?.permissions ?? []);
        expect(held).toContain('drop:manage:organization');
        expect(held).not.toContain('drop:read:organization');

        const decision = attempt('ARTIST', PRODUCT_READ_CAPABILITY, { organizationId: ORG });
        expect(decision.allowed).toBe(true);
    });

    it('still refuses another organization’s drop', () => {
        expect(
            attempt('ARTIST', PRODUCT_READ_CAPABILITY, { organizationId: 'org-someone-else' })
                .allowed,
        ).toBe(false);
    });

    it('lets platform staff through with no context at all', () => {
        // Why this went unnoticed: every check ran as an administrator, and a
        // platform-wide grant needs no context.
        expect(attempt('HITBOX_SYSTEM_ADMIN', PRODUCT_READ_CAPABILITY, {}, 'GLOBAL').allowed).toBe(
            true,
        );
    });
});

describe('catalog writes stay platform-wide', () => {
    it('an organization-scoped MANAGE grant matches only at ORGANIZATION', () => {
        // The write routes pass `globalOnly`, which is checked after the
        // decision — so what must hold is that the grant an artist matches on
        // is NOT global, and the guard then refuses it.
        const decision = attempt('ARTIST', PRODUCT_WRITE_CAPABILITY, { organizationId: ORG });
        expect(decision.allowed).toBe(true);
        expect((decision as { scope?: string }).scope).toBe('ORGANIZATION');
        expect((decision as { scope?: string }).scope).not.toBe('GLOBAL');
    });

    it('a platform administrator matches at GLOBAL and passes globalOnly', () => {
        const decision = attempt('HITBOX_SYSTEM_ADMIN', PRODUCT_WRITE_CAPABILITY, {}, 'GLOBAL');
        expect(decision.allowed).toBe(true);
        expect((decision as { scope?: string }).scope).toBe('GLOBAL');
    });
});

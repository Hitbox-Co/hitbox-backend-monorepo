import type { Request } from 'express';
import { AppError } from '@hitbox/shared';
import { ACCESS_CONTROL_ERROR_CODES } from '../src/constants/access-control.constant';
import { ScopeVisibility } from '../src/domain/permission-catalog';
import { createRequirePermission } from '../src/middleware/require-permission.middleware';
import type { PrincipalGrant } from '../src/domain/interfaces/principal-grants.interface';
import { ORG_A, ORG_B, OTHER_USER, USER, grantsForRole } from './helpers';

/**
 * The guard business modules actually mount. What matters here is that a
 * route names a capability and never a role, and that a missing identity is a
 * 401 rather than a silent deny.
 */

/** `principalId: null` models an unauthenticated request. */
function makeGuard(grants: PrincipalGrant[], principalId: string | null = USER) {
    const findGrantsByUserId = jest.fn().mockResolvedValue(grants);
    const guard = createRequirePermission({
        grants: { findGrantsByUserId },
        resolvePrincipalId: () => principalId ?? undefined,
    });
    return { guard, findGrantsByUserId };
}

function makeReq(overrides: Partial<Request> = {}): Request {
    return { headers: {}, params: {}, query: {}, body: {}, ...overrides } as unknown as Request;
}

async function run(handler: ReturnType<ReturnType<typeof makeGuard>['guard']['requirePermission']>, req: Request) {
    const next = jest.fn();
    await (handler as unknown as (r: Request, res: unknown, n: jest.Mock) => Promise<void>)(
        req,
        {},
        next,
    );
    return next;
}

describe('requirePermission', () => {
    it('calls next() with no error when the capability is held', async () => {
        const { guard } = makeGuard(grantsForRole('HITBOX_ORDER_MANAGER'));
        const req = makeReq();
        const next = await run(guard.requirePermission('order:refund'), req);

        expect(next).toHaveBeenCalledWith();
        expect(req.authz).toBeDefined();
        expect(req.authz?.capability).toBe('order:refund');
        expect(req.authz?.roleName).toBe('HITBOX_ORDER_MANAGER');
        expect(req.authz?.userId).toBe(USER);
    });

    it('rejects with 403 FORBIDDEN when the capability is missing', async () => {
        const { guard } = makeGuard(grantsForRole('HITBOX_SUPPORT'));
        const next = await run(guard.requirePermission('order:refund'), makeReq());

        const error = next.mock.calls[0]?.[0] as AppError;
        expect(error).toBeInstanceOf(AppError);
        expect(error.statusCode).toBe(403);
        expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODES.FORBIDDEN);
    });

    it('rejects with 401 when the route was mounted without requireAuth', async () => {
        // A wiring bug must be loud, not a quiet 403.
        const { guard } = makeGuard(grantsForRole('HITBOX_SYSTEM_ADMIN'), null);
        const next = await run(guard.requirePermission('order:refund'), makeReq());

        const error = next.mock.calls[0]?.[0] as AppError;
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe(ACCESS_CONTROL_ERROR_CODES.NO_PRINCIPAL);
    });

    it('does not leak which permission was missing', async () => {
        const { guard } = makeGuard([]);
        const next = await run(guard.requirePermission('payment-royalty:manage'), makeReq());
        const error = next.mock.calls[0]?.[0] as AppError;
        expect(error.message).not.toContain('payment-royalty');
    });

    it('throws at router-build time on a malformed capability', () => {
        const { guard } = makeGuard([]);
        // A typo in a guard should crash at boot, not deny forever in silence.
        expect(() => guard.requirePermission('order:refund:global')).toThrow(/not a valid capability/);
        expect(() => guard.requirePermission('nonsense:read')).toThrow(/not a valid capability/);
    });

    it('reports the granted visibility so the controller can mask', async () => {
        const { guard } = makeGuard(grantsForRole('HITBOX_SUPPORT'));
        const req = makeReq();
        await run(guard.requirePermission('buyer-profile:read'), req);
        expect(req.authz?.visibility).toBe(ScopeVisibility.MASKED);
    });

    it('loads the principal once per request across several checks', async () => {
        const { guard, findGrantsByUserId } = makeGuard(grantsForRole('HITBOX_SYSTEM_ADMIN'));
        const req = makeReq();

        await run(guard.requirePermission('order:read'), req);
        await run(guard.requirePermission('order:refund'), req);
        await guard.authorize(req, 'drop:read', {});

        expect(findGrantsByUserId).toHaveBeenCalledTimes(1);
    });
});

describe('requirePermission with an organization context', () => {
    const brandAdminAtA = grantsForRole('BRAND_ADMIN', { scopeId: ORG_A });

    const guardFor = (grants: PrincipalGrant[]) => makeGuard(grants).guard;

    it('allows an action inside the assignment organization', async () => {
        const guard = guardFor(brandAdminAtA);
        const handler = guard.requirePermission('drop:update', {
            context: (req) => ({ organizationId: (req.body as { organizationId: string }).organizationId }),
        });
        const next = await run(handler, makeReq({ body: { organizationId: ORG_A } }));
        expect(next).toHaveBeenCalledWith();
    });

    it('denies the same action in another organization', async () => {
        const guard = guardFor(brandAdminAtA);
        const handler = guard.requirePermission('drop:update', {
            context: (req) => ({ organizationId: (req.body as { organizationId: string }).organizationId }),
        });
        const next = await run(handler, makeReq({ body: { organizationId: ORG_B } }));
        const error = next.mock.calls[0]?.[0] as AppError;
        expect(error.statusCode).toBe(403);
    });

    it('supports an async context resolver', async () => {
        const guard = guardFor(brandAdminAtA);
        const handler = guard.requirePermission('drop:update', {
            context: async () => Promise.resolve({ organizationId: ORG_A }),
        });
        const next = await run(handler, makeReq());
        expect(next).toHaveBeenCalledWith();
    });
});

describe('authorize() — the check-after-load half', () => {
    it('passes when the loaded record is in scope', async () => {
        const { guard } = makeGuard(grantsForRole('BUYER_COLLECTOR'));
        const result = await guard.authorize(makeReq(), 'order:read', { ownerId: USER });
        expect(result.capability).toBe('order:read');
        expect(result.visibility).toBe(ScopeVisibility.FULL);
    });

    it('throws 403 when the loaded record belongs to someone else', async () => {
        const { guard } = makeGuard(grantsForRole('BUYER_COLLECTOR'));
        await expect(
            guard.authorize(makeReq(), 'order:read', { ownerId: OTHER_USER }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('describePrincipal() — GET /authz/me', () => {
    it('returns the union of permissions and each role once per scope', async () => {
        const grants = [
            ...grantsForRole('ARTIST', { scopeId: ORG_A }),
            ...grantsForRole('HITBOX_FULL_STACK_ENGINEER'),
        ];
        const { guard } = makeGuard(grants);

        const described = await guard.describePrincipal(makeReq());

        expect(described.userId).toBe(USER);
        expect(described.roles.map((r) => r.roleName).sort()).toEqual([
            'ARTIST',
            'HITBOX_FULL_STACK_ENGINEER',
        ]);
        expect(described.permissions).toContain('application:debug:global');
        expect(described.permissions).toContain('drop:manage:organization');
        // Sorted and deduplicated so a client can diff it cheaply.
        expect(described.permissions).toEqual([...described.permissions].sort());
        expect(new Set(described.permissions).size).toBe(described.permissions.length);
    });

    it('reports an organization-scoped role with its organization', async () => {
        const { guard } = makeGuard(grantsForRole('BRAND_ADMIN', { scopeId: ORG_A }));
        const described = await guard.describePrincipal(makeReq());
        expect(described.roles[0]?.organizationId).toBe(ORG_A);
    });

    it('returns nothing for a user with no assignments', async () => {
        const { guard } = makeGuard([]);
        const described = await guard.describePrincipal(makeReq());
        expect(described.permissions).toEqual([]);
        expect(described.roles).toEqual([]);
    });
});

import { PermissionCache } from '../src/cache/permission-cache';
import { AuthorizationService } from '../src/service/authorization.service';
import { PermissionScope } from '../src/domain/enums/permission-scope.enum';
import type { AuthzRepository } from '../src/repository/authz.repository';
import { ORG_A, ORG_B, USER_ID, principal } from './helpers/principal';

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as unknown as import('pino').Logger;

function makeCache(localTtlMs = 5_000): PermissionCache {
    // No REDIS_URL in tests, so this exercises the in-process tier and the
    // "cache miss must fall through to the database" path.
    return new PermissionCache({ redis: null, logger, ttlSeconds: 300, localTtlMs });
}

function makeService(
    snapshot = principal(['product:update:own']),
    cache = makeCache(),
) {
    const loadPrincipal = jest.fn().mockResolvedValue(snapshot);
    const repository = { loadPrincipal } as unknown as AuthzRepository;
    const service = new AuthorizationService({ repository, cache, logger });
    return { service, loadPrincipal, cache };
}

describe('principal caching', () => {
    it('reads the database once, then serves from cache', async () => {
        const { service, loadPrincipal } = makeService();

        await service.getPrincipal(USER_ID);
        await service.getPrincipal(USER_ID);
        await service.getPrincipal(USER_ID);

        expect(loadPrincipal).toHaveBeenCalledTimes(1);
    });

    it('re-reads after a targeted invalidation', async () => {
        const { service, loadPrincipal } = makeService();

        await service.getPrincipal(USER_ID);
        await service.invalidate(USER_ID);
        await service.getPrincipal(USER_ID);

        expect(loadPrincipal).toHaveBeenCalledTimes(2);
    });

    it('re-reads everything after a global (epoch) invalidation', async () => {
        const { service, loadPrincipal } = makeService();

        await service.getPrincipal(USER_ID);
        // A role's permission set changed — every snapshot is now suspect.
        await service.invalidateEverything();
        await service.getPrincipal(USER_ID);

        expect(loadPrincipal).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache entirely when asked for a fresh read', async () => {
        const { service, loadPrincipal } = makeService();

        await service.getPrincipal(USER_ID);
        // What role administration does: a few seconds of staleness is not
        // acceptable when the actor's own authority may have just been revoked.
        await service.getPrincipal(USER_ID, { fresh: true });

        expect(loadPrincipal).toHaveBeenCalledTimes(2);
    });

    it('always hits the database when the local tier is disabled', async () => {
        const { service, loadPrincipal } = makeService(
            principal(['product:update:own']),
            makeCache(0),
        );

        await service.getPrincipal(USER_ID);
        await service.getPrincipal(USER_ID);

        expect(loadPrincipal).toHaveBeenCalledTimes(2);
    });

    it('expires local entries after the TTL', async () => {
        jest.useFakeTimers();
        try {
            const { service, loadPrincipal } = makeService(
                principal(['product:update:own']),
                makeCache(1_000),
            );

            await service.getPrincipal(USER_ID);
            jest.advanceTimersByTime(1_500);
            await service.getPrincipal(USER_ID);

            expect(loadPrincipal).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('requirePermission (service level)', () => {
    it('throws 403 PERMISSION_DENIED when the capability is absent', () => {
        const { service } = makeService();
        try {
            service.requirePermission(principal([]), {
                resource: 'product',
                action: 'update',
                organizationId: null,
            });
            throw new Error('should have thrown');
        } catch (error) {
            expect(error).toMatchObject({
                statusCode: 403,
                code: 'AUTHZ_PERMISSION_DENIED',
            });
        }
    });

    it('passes when the capability is held', () => {
        const { service } = makeService();
        expect(() =>
            service.requirePermission(principal(['product:update:own']), {
                resource: 'product',
                action: 'update',
                organizationId: null,
            }),
        ).not.toThrow();
    });
});

describe('requireResourceAccess (service level)', () => {
    const request = { resource: 'product', action: 'update', organizationId: null };

    it('distinguishes "no capability" from "not your row"', () => {
        const { service } = makeService();

        // No grant at all -> PERMISSION_DENIED
        try {
            service.requireResourceAccess(principal([]), request, { ownerId: USER_ID });
            throw new Error('should have thrown');
        } catch (error) {
            expect(error).toMatchObject({ code: 'AUTHZ_PERMISSION_DENIED' });
        }

        // Grant held, wrong row -> RESOURCE_FORBIDDEN. The distinction matters
        // operationally: one is a misconfigured role, the other is somebody
        // reaching for data that is not theirs.
        try {
            service.requireResourceAccess(principal(['product:update:own']), request, {
                ownerId: 'someone_else',
            });
            throw new Error('should have thrown');
        } catch (error) {
            expect(error).toMatchObject({ code: 'AUTHZ_RESOURCE_FORBIDDEN' });
        }
    });
});

describe('hasPermissionAtScope', () => {
    it('is satisfied by a wider scope than the one requested', () => {
        const { service } = makeService();
        const user = principal(['organization:read:any']);
        const request = { resource: 'organization', action: 'read', organizationId: null };

        expect(service.hasPermissionAtScope(user, request, PermissionScope.ANY)).toBe(true);
        expect(service.hasPermissionAtScope(user, request, PermissionScope.OWN)).toBe(true);
    });

    it('is not satisfied by a narrower scope', () => {
        const { service } = makeService();
        const user = principal(['organization:read:organization@' + ORG_A]);
        const request = { resource: 'organization', action: 'read', organizationId: ORG_A };

        expect(service.hasPermissionAtScope(user, request, PermissionScope.ANY)).toBe(false);
    });
});

describe('the frontend manifest', () => {
    it('lists permissions and the widest scope per capability', () => {
        const { service } = makeService();
        const user = principal(
            [
                'product:read:any',
                'product:update:own',
                `product:update:organization@${ORG_A}`,
                `order:read:organization@${ORG_A}`,
            ],
            {
                platformRoles: ['USER', 'ARTIST'],
                organizations: [{ id: ORG_A, slug: 'acme', name: 'Acme', roles: ['PRODUCT_MANAGER'] }],
            },
        );

        const manifest = service.describe(user);

        expect(manifest.userId).toBe(USER_ID);
        expect(manifest.platformRoles).toEqual(['USER', 'ARTIST']);
        expect(manifest.organizations[0]).toMatchObject({ slug: 'acme', roles: ['PRODUCT_MANAGER'] });
        expect(manifest.permissions).toContain('product:update:organization');
        // Widest scope wins, so a client can ask "can I edit anything, or only
        // my own?" without parsing scope strings itself.
        expect(manifest.capabilities['product:update']).toBe('organization');
        expect(manifest.capabilities['product:read']).toBe('any');
        expect(manifest.capabilities['order:read']).toBe('organization');
    });

    it('omits capabilities the user does not hold', () => {
        const { service } = makeService();
        const manifest = service.describe(principal(['product:read:any']));
        expect(manifest.capabilities['product:delete']).toBeUndefined();
        expect(manifest.permissions).not.toContain('product:delete:any');
    });

    it('does not leak grants from tenants the user is not acting in', () => {
        // The manifest lists everything the user holds anywhere — but each
        // grant stays tagged, and the decision path filters by active tenant.
        const { service } = makeService();
        const user = principal([`product:update:organization@${ORG_B}`]);
        expect(
            service.hasPermission(user, {
                resource: 'product',
                action: 'update',
                organizationId: ORG_A,
            }),
        ).toBe(false);
    });
});

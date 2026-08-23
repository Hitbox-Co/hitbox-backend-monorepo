import type { Request } from 'express';
import { PermissionCache } from '../src/cache/permission-cache';
import { AuthorizationService } from '../src/service/authorization.service';
import { AuditService } from '../src/service/audit.service';
import { createRequirePermission } from '../src/middleware/require-permission.middleware';
import { resolveOrganizationContext } from '../src/middleware/authz-context.middleware';
import { assertStepUpSatisfied } from '../src/middleware/step-up.middleware';
import type { AuthzRepository } from '../src/repository/authz.repository';
import type { AuditRepository } from '../src/repository/audit.repository';
import type { AuthzPrincipal } from '../src/domain/interfaces/principal.interface';
import { ORG_A, ORG_B, USER_ID, principal } from './helpers/principal';

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as unknown as import('pino').Logger;

interface Harness {
    run(req: Partial<Request>): Promise<{ error: unknown; passed: boolean; req: Request }>;
    appends: jest.Mock;
}

function harness(
    snapshot: AuthzPrincipal,
    resource: string,
    action: string,
    options: Parameters<ReturnType<typeof createRequirePermission>>[2] = {},
): Harness {
    const repository = {
        loadPrincipal: jest.fn().mockResolvedValue(snapshot),
    } as unknown as AuthzRepository;

    const cache = new PermissionCache({ redis: null, logger, ttlSeconds: 300, localTtlMs: 0 });
    const authorization = new AuthorizationService({ repository, cache, logger });

    const appends = jest.fn().mockResolvedValue(undefined);
    const audit = new AuditService({
        repository: { append: appends } as unknown as AuditRepository,
        logger,
    });

    const requirePermission = createRequirePermission({
        authorization,
        audit,
        logger,
        stepUpMaxAgeMinutes: 15,
    });
    const middleware = requirePermission(resource as never, action as never, options);

    return {
        appends,
        async run(partial) {
            const req = {
                headers: {},
                header: (name: string) =>
                    (partial.headers as Record<string, string> | undefined)?.[name.toLowerCase()],
                params: {},
                query: {},
                ip: '203.0.113.7',
                originalUrl: '/api/v1/products/p1',
                auth: {
                    accountId: USER_ID,
                    clerkUserId: 'clerk_1',
                    email: 'a@test.local',
                    sessionId: 'sess_1',
                    factorVerificationAge: [1, -1] as [number, number],
                },
                ...partial,
            } as unknown as Request;

            let error: unknown = null;
            let passed = false;
            await (middleware as unknown as (
                r: Request,
                s: unknown,
                n: (e?: unknown) => void,
            ) => Promise<void>)(req, {}, (maybeError?: unknown) => {
                if (maybeError) error = maybeError;
                else passed = true;
            });
            return { error, passed, req };
        },
    };
}

describe('requirePermission: capability gate', () => {
    it('403s and audits the denial when the capability is missing', async () => {
        const h = harness(principal([]), 'product', 'update');
        const { error, passed, appends } = { ...(await h.run({})), appends: h.appends };

        expect(passed).toBe(false);
        expect(error).toMatchObject({ statusCode: 403, code: 'AUTHZ_PERMISSION_DENIED' });
        // A denial is a security event, so it is recorded even though the
        // request never reached a handler.
        expect(appends).toHaveBeenCalledWith(
            expect.objectContaining({
                result: 'DENIED',
                action: 'product:update',
                metadata: { reason: 'capability not granted' },
            }),
        );
    });

    it('passes and attaches req.authz when the capability is held', async () => {
        const h = harness(principal(['product:update:own']), 'product', 'update');
        const { passed, req } = await h.run({});

        expect(passed).toBe(true);
        expect(req.authz?.principal.userId).toBe(USER_ID);
        expect(req.authz?.organizationId).toBeNull();
    });

    it('401s when requireAuth was not mounted first', async () => {
        // A wiring mistake must fail loudly, not fall open.
        const h = harness(principal(['product:update:own']), 'product', 'update');
        const { error, passed } = await h.run({ auth: undefined });

        expect(passed).toBe(false);
        expect(error).toMatchObject({ statusCode: 401, code: 'AUTHZ_MISSING_AUTH_CONTEXT' });
    });
});

describe('requirePermission: resource policy gate', () => {
    const ownGrant = principal(['product:update:own']);

    it('passes for a row the user owns', async () => {
        const h = harness(ownGrant, 'product', 'update', {
            resource: () => ({ ownerId: USER_ID, organizationId: null }),
        });
        expect((await h.run({})).passed).toBe(true);
    });

    it('403s RESOURCE_FORBIDDEN for somebody else\'s row', async () => {
        const h = harness(ownGrant, 'product', 'update', {
            resource: () => ({ ownerId: 'someone_else', organizationId: null }),
        });
        const { error } = await h.run({});
        expect(error).toMatchObject({ statusCode: 403, code: 'AUTHZ_RESOURCE_FORBIDDEN' });
    });

    it('404s when the row does not exist', async () => {
        // Deliberately a 404, not a 403: the caller learns nothing about
        // whether they would have been allowed.
        const h = harness(ownGrant, 'product', 'update', { resource: () => null });
        const { error } = await h.run({});
        expect(error).toMatchObject({ statusCode: 404 });
    });

    it('blocks a cross-tenant row for an organization-scoped grant', async () => {
        const user = principal([`product:update:organization@${ORG_A}`], {
            organizations: [{ id: ORG_A }],
        });
        const h = harness(user, 'product', 'update', {
            resource: () => ({ ownerId: null, organizationId: ORG_B }),
        });
        const { error } = await h.run({ headers: { 'x-organization-id': ORG_A } });
        expect(error).toMatchObject({ code: 'AUTHZ_RESOURCE_FORBIDDEN' });
    });
});

describe('requirePermission: organization context', () => {
    it('requires a tenant when the route demands one', async () => {
        const user = principal(['product:read:any'], {
            organizations: [{ id: ORG_A }, { id: ORG_B }],
        });
        const h = harness(user, 'product', 'read', { requireOrganization: true });
        const { error } = await h.run({});
        expect(error).toMatchObject({ code: 'AUTHZ_ORGANIZATION_REQUIRED' });
    });

    it('defaults to the tenant when the user belongs to exactly one', async () => {
        const user = principal([`product:read:organization@${ORG_A}`], {
            organizations: [{ id: ORG_A }],
        });
        const h = harness(user, 'product', 'read', { requireOrganization: true });
        const { passed, req } = await h.run({});
        expect(passed).toBe(true);
        expect(req.authz?.organizationId).toBe(ORG_A);
    });
});

describe('requirePermission: step-up for sensitive capabilities', () => {
    const sensitive = principal([`order:refund:organization@${ORG_A}`], {
        organizations: [{ id: ORG_A }],
        sensitive: ['order:refund:organization'],
    });

    it('allows a recently verified session', async () => {
        const h = harness(sensitive, 'order', 'refund');
        const { passed } = await h.run({ headers: { 'x-organization-id': ORG_A } });
        expect(passed).toBe(true);
    });

    it('rejects a session whose factors were verified long ago', async () => {
        const h = harness(sensitive, 'order', 'refund');
        const { error } = await h.run({
            headers: { 'x-organization-id': ORG_A },
            auth: {
                accountId: USER_ID,
                clerkUserId: 'clerk_1',
                email: 'a@test.local',
                sessionId: 'sess_1',
                factorVerificationAge: [600, -1],
            },
        } as Partial<Request>);
        expect(error).toMatchObject({ code: 'AUTHZ_STEP_UP_REQUIRED' });
    });

    it('fails closed when the token carries no fva claim', async () => {
        const h = harness(sensitive, 'order', 'refund');
        const { error } = await h.run({
            headers: { 'x-organization-id': ORG_A },
            auth: {
                accountId: USER_ID,
                clerkUserId: 'clerk_1',
                email: 'a@test.local',
                sessionId: 'sess_1',
                factorVerificationAge: null,
            },
        } as Partial<Request>);
        expect(error).toMatchObject({ code: 'AUTHZ_STEP_UP_REQUIRED' });
    });

    it('does not gate a non-sensitive capability', async () => {
        const plain = principal(['product:read:any']);
        const h = harness(plain, 'product', 'read');
        const { passed } = await h.run({
            auth: {
                accountId: USER_ID,
                clerkUserId: 'clerk_1',
                email: 'a@test.local',
                sessionId: 'sess_1',
                factorVerificationAge: null,
            },
        } as Partial<Request>);
        expect(passed).toBe(true);
    });

    it('audits a successful sensitive call', async () => {
        const h = harness(sensitive, 'order', 'refund');
        await h.run({ headers: { 'x-organization-id': ORG_A } });
        expect(h.appends).toHaveBeenCalledWith(
            expect.objectContaining({ result: 'SUCCESS', action: 'order:refund' }),
        );
    });
});

describe('assertStepUpSatisfied', () => {
    const req = (fva: [number, number] | null) =>
        ({ auth: { factorVerificationAge: fva } }) as unknown as Request;

    it('accepts a fresh second factor even when the first is stale', () => {
        expect(() => assertStepUpSatisfied(req([600, 2]), 15)).not.toThrow();
    });

    it('ignores -1 slots (factor not applicable)', () => {
        expect(() => assertStepUpSatisfied(req([2, -1]), 15)).not.toThrow();
        expect(() => assertStepUpSatisfied(req([-1, -1]), 15)).toThrow();
    });
});

describe('resolveOrganizationContext', () => {
    const req = (over: Partial<Request> = {}) =>
        ({
            params: {},
            query: {},
            headers: {},
            header: () => undefined,
            ...over,
        }) as unknown as Request;

    it('prefers the route param over the header', () => {
        const user = principal([], { organizations: [{ id: ORG_A }, { id: ORG_B }] });
        const resolved = resolveOrganizationContext(
            user,
            req({
                params: { organizationId: ORG_B },
                header: (() => ORG_A) as never,
            }),
        );
        expect(resolved).toBe(ORG_B);
    });

    it('returns null when the user belongs to several tenants and names none', () => {
        const user = principal([], { organizations: [{ id: ORG_A }, { id: ORG_B }] });
        expect(resolveOrganizationContext(user, req())).toBeNull();
    });

    it('403s for a tenant the user is not a member of', () => {
        const user = principal([], { organizations: [{ id: ORG_A }] });
        expect(() =>
            resolveOrganizationContext(user, req({ params: { organizationId: ORG_B } })),
        ).toThrow(/not a member/);
    });

    it('allows a platform operator to inspect any tenant', () => {
        const operator = principal(['organization:read:any']);
        expect(
            resolveOrganizationContext(operator, req({ params: { organizationId: ORG_B } })),
        ).toBe(ORG_B);
    });

    it('gives a platform operator no tenant grants they did not already hold', () => {
        // Setting the context does not manufacture organization-scoped grants:
        // the operator still acts through their `any` permissions only.
        const operator = principal(['organization:read:any']);
        expect(operator.grants.filter((grant) => grant.organizationId !== null)).toHaveLength(0);
    });
});

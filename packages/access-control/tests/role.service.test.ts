import { AuthorizationDomain, RoleScopeType } from '@hitbox/database';
import type { AppError } from '@hitbox/shared';
import { ACCESS_CONTROL_ERROR_CODES } from '../src/constants/access-control.constant';
import { RoleService } from '../src/service/role.service';
import { RoleAssignmentService } from '../src/service/role-assignment.service';
import { ORG_A, USER } from './helpers';

/**
 * Service-level guards. The engine decides access; these tests cover the
 * rules that stop a bad role from being *created* in the first place —
 * cross-domain grants, edits to system roles, and deletes that would silently
 * revoke access.
 */

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
} as unknown as Parameters<typeof RoleService.prototype.constructor>[0]['logger'];

const eventBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

function roleRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'role_1',
        name: 'CUSTOM_ROLE',
        displayName: 'Custom Role',
        entityGroup: 'hitbox_seller_org',
        domain: AuthorizationDomain.BUSINESS,
        isSystem: false,
        isActive: true,
        createdAt: new Date('2026-01-01'),
        rolePermissions: [],
        ...overrides,
    };
}

function makeService(overrides: {
    role?: ReturnType<typeof roleRow> | null;
    byName?: ReturnType<typeof roleRow> | null;
    assignmentCount?: number;
    permissionRows?: { id: string; key: string }[];
} = {}) {
    const roles = {
        // `'role' in overrides` rather than `??` so an explicit null models
        // "no such role" instead of falling back to the default row.
        findById: jest.fn().mockResolvedValue('role' in overrides ? overrides.role : roleRow()),
        findByName: jest.fn().mockResolvedValue(overrides.byName ?? null),
        findAll: jest.fn().mockResolvedValue([roleRow()]),
        countAssignments: jest.fn().mockResolvedValue(overrides.assignmentCount ?? 0),
        create: jest.fn().mockResolvedValue(roleRow()),
        update: jest.fn().mockResolvedValue(roleRow()),
        replacePermissions: jest.fn().mockResolvedValue(roleRow()),
        delete: jest.fn().mockResolvedValue(undefined),
    };
    const permissions = {
        findByKeys: jest
            .fn()
            .mockImplementation(async (keys: string[]) =>
                overrides.permissionRows ?? keys.map((key, i) => ({ id: `perm_${i}`, key })),
            ),
        findAll: jest.fn().mockResolvedValue([]),
    };
    const cache = {
        invalidateUser: jest.fn().mockResolvedValue(undefined),
        invalidateAll: jest.fn().mockResolvedValue(undefined),
    };
    const service = new RoleService({
        roles: roles as never,
        permissions: permissions as never,
        eventBus: eventBus as never,
        cache,
        logger,
    });
    return { service, roles, permissions, cache };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('§5 — the domain boundary is enforced on write', () => {
    it('refuses to give a BUSINESS role a TECHNICAL permission', async () => {
        const { service, roles } = makeService();
        await expect(
            service.create({
                name: 'BRAND_DEPLOYER',
                displayName: 'Brand Deployer',
                entityGroup: 'brand_artist',
                domain: AuthorizationDomain.BUSINESS,
                permissions: ['drop:manage:organization', 'infrastructure:deploy:global'],
            }),
        ).rejects.toMatchObject({
            statusCode: 400,
            code: ACCESS_CONTROL_ERROR_CODES.DOMAIN_VIOLATION,
        });
        expect(roles.create).not.toHaveBeenCalled();
    });

    it('refuses to give a TECHNICAL role a BUSINESS permission', async () => {
        const { service, roles } = makeService();
        await expect(
            service.create({
                name: 'ENGINEER_WITH_REFUNDS',
                displayName: 'Engineer With Refunds',
                entityGroup: 'hitbox_seller_org',
                domain: AuthorizationDomain.TECHNICAL,
                permissions: ['application:deploy:global', 'order:refund:global'],
            }),
        ).rejects.toMatchObject({
            statusCode: 400,
            code: ACCESS_CONTROL_ERROR_CODES.DOMAIN_VIOLATION,
        });
        expect(roles.create).not.toHaveBeenCalled();
    });

    it('names the offending permissions in the error details', async () => {
        const { service } = makeService();
        const error = await service
            .create({
                name: 'MIXED_ROLE',
                displayName: 'Mixed',
                entityGroup: 'hitbox_seller_org',
                domain: AuthorizationDomain.TECHNICAL,
                permissions: ['order:refund:global', 'payment-royalty:manage:global'],
            })
            .catch((e: AppError) => e);
        expect((error as AppError).details).toMatchObject({
            domain: AuthorizationDomain.TECHNICAL,
            offendingPermissions: ['order:refund:global', 'payment-royalty:manage:global'],
        });
    });

    it('allows a same-domain permission set', async () => {
        const { service, roles } = makeService();
        await service.create({
            name: 'BRAND_CONTENT_EDITOR',
            displayName: 'Brand Content Editor',
            entityGroup: 'brand_artist',
            domain: AuthorizationDomain.BUSINESS,
            permissions: ['content-unlock:manage:organization', 'drop:manage:organization'],
        });
        expect(roles.create).toHaveBeenCalled();
        // Operator-created roles are never system roles.
        expect(roles.create.mock.calls[0]?.[0]).toMatchObject({ isSystem: false });
    });

    it('rejects a duplicate role name', async () => {
        const { service } = makeService({ byName: roleRow() });
        await expect(
            service.create({
                name: 'CUSTOM_ROLE',
                displayName: 'Dup',
                entityGroup: 'hitbox_seller_org',
                domain: AuthorizationDomain.BUSINESS,
                permissions: ['order:read:global'],
            }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.ROLE_NAME_TAKEN });
    });

    it('reports permissions missing from the database as a seed problem', async () => {
        const { service } = makeService({ permissionRows: [] });
        await expect(
            service.create({
                name: 'NEEDS_SEED',
                displayName: 'Needs Seed',
                entityGroup: 'hitbox_seller_org',
                domain: AuthorizationDomain.BUSINESS,
                permissions: ['order:read:global'],
            }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.UNKNOWN_PERMISSION });
    });
});

describe('system roles are protected', () => {
    const systemRole = roleRow({ name: 'HITBOX_SYSTEM_ADMIN', isSystem: true });

    it('refuses to edit a system role\'s permissions', async () => {
        const { service, roles } = makeService({ role: systemRole });
        await expect(
            service.update('role_1', { permissions: ['order:read:global'] }),
        ).rejects.toMatchObject({
            statusCode: 403,
            code: ACCESS_CONTROL_ERROR_CODES.ROLE_IMMUTABLE,
        });
        expect(roles.replacePermissions).not.toHaveBeenCalled();
    });

    it('refuses to delete a system role', async () => {
        const { service, roles } = makeService({ role: systemRole });
        await expect(service.delete('role_1')).rejects.toMatchObject({
            statusCode: 403,
            code: ACCESS_CONTROL_ERROR_CODES.ROLE_IMMUTABLE,
        });
        expect(roles.delete).not.toHaveBeenCalled();
    });

    it('still allows deactivating a system role', async () => {
        const { service, roles } = makeService({ role: systemRole });
        await service.update('role_1', { isActive: false });
        expect(roles.update).toHaveBeenCalledWith('role_1', { isActive: false });
    });
});

describe('operator-defined roles', () => {
    it('can have their permissions replaced', async () => {
        const { service, roles } = makeService();
        await service.update('role_1', { permissions: ['order:read:global'] });
        expect(roles.replacePermissions).toHaveBeenCalledWith('role_1', ['perm_0']);
    });

    it('cannot be given cross-domain permissions on update either', async () => {
        const { service } = makeService();
        await expect(
            service.update('role_1', { permissions: ['infrastructure:deploy:global'] }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.DOMAIN_VIOLATION });
    });

    it('cannot be deleted while still assigned', async () => {
        const { service, roles } = makeService({ assignmentCount: 3 });
        await expect(service.delete('role_1')).rejects.toMatchObject({
            statusCode: 409,
            code: ACCESS_CONTROL_ERROR_CODES.ROLE_IN_USE,
        });
        expect(roles.delete).not.toHaveBeenCalled();
    });

    it('can be deleted once no assignments remain', async () => {
        const { service, roles } = makeService({ assignmentCount: 0 });
        await service.delete('role_1');
        expect(roles.delete).toHaveBeenCalledWith('role_1');
    });

    it('flushes the grant cache when a permission set changes', async () => {
        const { service, cache } = makeService();
        await service.update('role_1', { permissions: ['order:read:global'] });
        // Role-shaped changes affect an unknown set of holders.
        expect(cache.invalidateAll).toHaveBeenCalled();
    });

    it('flushes the grant cache on delete', async () => {
        const { service, cache } = makeService({ assignmentCount: 0 });
        await service.delete('role_1');
        expect(cache.invalidateAll).toHaveBeenCalled();
    });

    it('does not flush on create — nobody holds a brand-new role yet', async () => {
        const { service, cache } = makeService();
        await service.create({
            name: 'FRESH_ROLE',
            displayName: 'Fresh',
            entityGroup: 'hitbox_seller_org',
            domain: AuthorizationDomain.BUSINESS,
            permissions: ['order:read:global'],
        });
        expect(cache.invalidateAll).not.toHaveBeenCalled();
    });

    it('does not flush when a write is rejected', async () => {
        const { service, cache } = makeService({ assignmentCount: 3 });
        await service.delete('role_1').catch(() => undefined);
        expect(cache.invalidateAll).not.toHaveBeenCalled();
    });

    it('404s on an unknown role', async () => {
        const { service } = makeService({ role: null });
        await expect(service.getById('nope')).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('role assignment', () => {
    function makeAssignmentService(overrides: {
        role?: ReturnType<typeof roleRow> | null;
        live?: unknown;
        userAssignments?: unknown[];
    } = {}) {
        const assignments = {
            findLive: jest.fn().mockResolvedValue(overrides.live ?? null),
            findByUserId: jest.fn().mockResolvedValue(overrides.userAssignments ?? []),
            findById: jest.fn(),
            create: jest.fn().mockImplementation(async (input: Record<string, unknown>) => ({
                id: 'assign_1',
                ...input,
                grantedAt: new Date(),
                revokedAt: null,
                role: overrides.role ?? roleRow(),
            })),
            revoke: jest.fn().mockImplementation(async () => ({
                id: 'assign_1',
                userId: USER,
                roleId: 'role_1',
                scopeType: RoleScopeType.GLOBAL,
                scopeId: null,
                grantedById: 'admin_1',
                grantedAt: new Date(),
                revokedAt: new Date(),
                role: overrides.role ?? roleRow(),
            })),
        };
        const roles = {
            findById: jest.fn().mockResolvedValue(overrides.role ?? roleRow()),
        };
        const cache = {
            invalidateUser: jest.fn().mockResolvedValue(undefined),
            invalidateAll: jest.fn().mockResolvedValue(undefined),
        };
        const service = new RoleAssignmentService({
            assignments: assignments as never,
            roles: roles as never,
            eventBus: eventBus as never,
            cache,
            logger,
        });
        return { service, assignments, cache };
    }

    it('defaults a brand role to organization scope', async () => {
        const { service, assignments } = makeAssignmentService({
            role: roleRow({ name: 'BRAND_ADMIN', entityGroup: 'brand_artist' }),
        });
        await service.assign({
            userId: USER,
            dto: { roleId: 'role_1', organizationId: ORG_A },
            grantedById: 'admin_1',
        });
        expect(assignments.create).toHaveBeenCalledWith(
            expect.objectContaining({ scopeType: RoleScopeType.ORGANIZATION, scopeId: ORG_A }),
        );
    });

    it('refuses an organization-scoped grant with no organization', async () => {
        const { service } = makeAssignmentService({
            role: roleRow({ name: 'BRAND_ADMIN', entityGroup: 'brand_artist' }),
        });
        await expect(
            service.assign({ userId: USER, dto: { roleId: 'role_1' }, grantedById: 'admin_1' }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.MISSING_ORG_SCOPE });
    });

    it('defaults a HitBox staff role to global scope with no organization', async () => {
        const { service, assignments } = makeAssignmentService({
            role: roleRow({ name: 'HITBOX_SUPPORT', entityGroup: 'hitbox_seller_org' }),
        });
        await service.assign({
            userId: USER,
            dto: { roleId: 'role_1' },
            grantedById: 'admin_1',
        });
        expect(assignments.create).toHaveBeenCalledWith(
            expect.objectContaining({ scopeType: RoleScopeType.GLOBAL, scopeId: null }),
        );
    });

    it('rejects a duplicate live assignment at the same scope', async () => {
        const { service } = makeAssignmentService({ live: { id: 'assign_existing' } });
        await expect(
            service.assign({ userId: USER, dto: { roleId: 'role_1' }, grantedById: 'admin_1' }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS });
    });

    it('refuses to assign a deactivated role', async () => {
        const { service } = makeAssignmentService({ role: roleRow({ isActive: false }) });
        await expect(
            service.assign({ userId: USER, dto: { roleId: 'role_1' }, grantedById: 'admin_1' }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("evicts the target user's cached grants on assign", async () => {
        const { service, cache } = makeAssignmentService();
        await service.assign({
            userId: USER,
            dto: { roleId: 'role_1' },
            grantedById: 'admin_1',
        });
        // Precise, not a full flush — only this user's grants changed.
        expect(cache.invalidateUser).toHaveBeenCalledWith(USER);
        expect(cache.invalidateAll).not.toHaveBeenCalled();
    });

    it("evicts the target user's cached grants on revoke", async () => {
        const { service, cache } = makeAssignmentService({
            userAssignments: [
                { id: 'assign_1', roleId: 'role_1', scopeId: null, role: roleRow() },
            ],
        });
        await service.revoke({ userId: USER, roleId: 'role_1', revokedById: 'admin_1' });
        expect(cache.invalidateUser).toHaveBeenCalledWith(USER);
    });

    it('does not evict when an assignment is rejected as a duplicate', async () => {
        const { service, cache } = makeAssignmentService({ live: { id: 'assign_existing' } });
        await service
            .assign({ userId: USER, dto: { roleId: 'role_1' }, grantedById: 'admin_1' })
            .catch(() => undefined);
        expect(cache.invalidateUser).not.toHaveBeenCalled();
    });

    it('records who granted the role', async () => {
        const { service, assignments } = makeAssignmentService();
        await service.assign({
            userId: USER,
            dto: { roleId: 'role_1' },
            grantedById: 'admin_42',
        });
        expect(assignments.create).toHaveBeenCalledWith(
            expect.objectContaining({ grantedById: 'admin_42' }),
        );
    });

    it('revokes softly rather than deleting, so the trail survives', async () => {
        const { service, assignments } = makeAssignmentService({
            userAssignments: [
                { id: 'assign_1', roleId: 'role_1', scopeId: null, role: roleRow() },
            ],
        });
        const result = await service.revoke({
            userId: USER,
            roleId: 'role_1',
            revokedById: 'admin_1',
        });
        expect(assignments.revoke).toHaveBeenCalledWith('assign_1');
        expect(result.revokedAt).not.toBeNull();
    });

    it('404s when revoking a role the user does not hold', async () => {
        const { service } = makeAssignmentService({ userAssignments: [] });
        await expect(
            service.revoke({ userId: USER, roleId: 'role_1', revokedById: 'admin_1' }),
        ).rejects.toMatchObject({ code: ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_NOT_FOUND });
    });
});

import { RoleAssignmentService } from '../src/service/role-assignment.service';
import { RoleKind } from '../src/domain/enums/role-kind.enum';
import { ROLE_BY_KEY, ROLE_KEYS } from '../src/domain/catalog/role-catalog';
import type { AuthzRepository, RoleSummary } from '../src/repository/authz.repository';
import type { AuthorizationService } from '../src/service/authorization.service';
import type { AuditService } from '../src/service/audit.service';
import type { IUserDirectory } from '../src/domain/interfaces/user-directory.interface';
import type { IEventBus } from '@hitbox/shared';
import { ORG_A, ORG_B, USER_ID, principal } from './helpers/principal';

const TARGET = 'user_bob';

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as unknown as import('pino').Logger;

/** Turns a catalog role into the DB-shaped summary the service works with. */
function roleSummary(key: string, id = `role_${key}`): RoleSummary {
    const definition = ROLE_BY_KEY.get(key);
    if (!definition) throw new Error(`unknown role ${key}`);
    return {
        id,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        kind: definition.kind,
        isPrivileged: definition.isPrivileged,
        isSystemManaged: true,
        permissionKeys: [...definition.permissions],
    };
}

function makeService(options: { holders?: string[] } = {}) {
    const grantRole = jest.fn().mockResolvedValue({ id: 'assignment_1', created: true });
    const revokeRole = jest.fn().mockResolvedValue(1);
    const listUserIdsWithRole = jest.fn().mockResolvedValue(options.holders ?? [USER_ID, TARGET]);

    const repository = {
        findRoleByKey: jest.fn(async (key: string) => {
            try {
                return roleSummary(key);
            } catch {
                return null;
            }
        }),
        grantRole,
        revokeRole,
        listUserIdsWithRole,
        listAssignmentsForUser: jest.fn().mockResolvedValue([]),
    } as unknown as AuthzRepository;

    const invalidate = jest.fn().mockResolvedValue(undefined);
    const authorization = { invalidate } as unknown as AuthorizationService;

    const record = jest.fn().mockResolvedValue(undefined);
    const audit = { record, emit: jest.fn() } as unknown as AuditService;

    const users: IUserDirectory = {
        findById: jest.fn(async (id: string) =>
            id === 'user_missing' ? null : { id, email: `${id}@test.local`, deleted: false },
        ),
        findByEmail: jest.fn(),
    };

    const eventBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as unknown as IEventBus;

    const service = new RoleAssignmentService({
        repository,
        authorization,
        audit,
        users,
        eventBus,
        logger,
    });

    return { service, grantRole, revokeRole, invalidate, record, eventBus };
}

/** An org admin acting inside ORG_A. */
const orgAdmin = () =>
    principal(
        (ROLE_BY_KEY.get(ROLE_KEYS.ORG_ADMIN)?.permissions ?? []).map((key) =>
            key.endsWith(':organization') ? `${key}@${ORG_A}` : key,
        ),
        { organizations: [{ id: ORG_A, roles: [ROLE_KEYS.ORG_ADMIN] }] },
    );

/** A super admin, holding every platform permission. */
const superAdmin = () =>
    principal([...(ROLE_BY_KEY.get(ROLE_KEYS.SUPER_ADMIN)?.permissions ?? [])], {
        platformRoles: [ROLE_KEYS.SUPER_ADMIN],
    });

/** A platform admin — broad, but deliberately without role management. */
const platformAdmin = () =>
    principal([...(ROLE_BY_KEY.get(ROLE_KEYS.PLATFORM_ADMIN)?.permissions ?? [])], {
        platformRoles: [ROLE_KEYS.PLATFORM_ADMIN],
    });

async function expectRejection(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject({ code });
}

describe('gate 1-2: role and target must exist', () => {
    it('rejects an unknown role', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: superAdmin(),
                targetUserId: TARGET,
                roleKey: 'WIZARD',
                organizationId: null,
            }),
            'AUTHZ_ROLE_NOT_FOUND',
        );
    });

    it('rejects a missing target user', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: superAdmin(),
                targetUserId: 'user_missing',
                roleKey: ROLE_KEYS.ARTIST,
                organizationId: null,
            }),
            'AUTHZ_ROLE_NOT_FOUND',
        );
    });
});

describe('gate 3: no self-assignment', () => {
    it('refuses even for SUPER_ADMIN', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: superAdmin(),
                targetUserId: USER_ID, // the actor themselves
                roleKey: ROLE_KEYS.ARTIST,
                organizationId: null,
            }),
            'AUTHZ_SELF_ASSIGNMENT_BLOCKED',
        );
    });

    it('refuses self-revocation too', async () => {
        const { service } = makeService();
        await expectRejection(
            service.revoke({
                actor: superAdmin(),
                targetUserId: USER_ID,
                roleKey: ROLE_KEYS.ARTIST,
                organizationId: null,
            }),
            'AUTHZ_SELF_ASSIGNMENT_BLOCKED',
        );
    });
});

describe('gate 4: role kind must match the context', () => {
    it('refuses a platform role scoped to an organization', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: superAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.ARTIST,
                organizationId: ORG_A,
            }),
            'AUTHZ_ROLE_NOT_ASSIGNABLE',
        );
    });

    it('refuses an organization role with no organization', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: superAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.PRODUCT_MANAGER,
                organizationId: null,
            }),
            'AUTHZ_ORGANIZATION_REQUIRED',
        );
    });
});

describe('gate 5-6: no escalation — the core guarantee', () => {
    it('an ORG_ADMIN can appoint a PRODUCT_MANAGER in their own tenant', async () => {
        // Delegation, not escalation: ORG_ADMIN does not personally hold
        // product:create:organization, but role:assign:organization is exactly
        // the authority to appoint people who do.
        const { service, grantRole, invalidate, record } = makeService();

        await service.assign({
            actor: orgAdmin(),
            targetUserId: TARGET,
            roleKey: ROLE_KEYS.PRODUCT_MANAGER,
            organizationId: ORG_A,
        });

        expect(grantRole).toHaveBeenCalledWith(
            expect.objectContaining({ userId: TARGET, organizationId: ORG_A }),
        );
        // The target's cached permissions must be dropped before we return.
        expect(invalidate).toHaveBeenCalledWith(TARGET);
        // ...and the grant must be accounted for.
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'role:assign', result: 'SUCCESS' }),
        );
    });

    it('an ORG_ADMIN cannot appoint into a DIFFERENT tenant', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: orgAdmin(), // admin of ORG_A only
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.PRODUCT_MANAGER,
                organizationId: ORG_B,
            }),
            'AUTHZ_PERMISSION_DENIED',
        );
    });

    it('an ORG_ADMIN cannot mint a PLATFORM_ADMIN', async () => {
        // The headline requirement: organization admin is not a stepping stone
        // to platform admin. It needs role:assign:any, which ORG_ADMIN lacks.
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: orgAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.PLATFORM_ADMIN,
                organizationId: null,
            }),
            'AUTHZ_ESCALATION_BLOCKED',
        );
    });

    it('an ORG_ADMIN cannot mint a SUPER_ADMIN', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: orgAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.SUPER_ADMIN,
                organizationId: null,
            }),
            'AUTHZ_ESCALATION_BLOCKED',
        );
    });

    it('an ORG_ADMIN cannot even grant the plain USER platform role', async () => {
        // Platform-wide grants of any kind require role:assign:any.
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: orgAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.USER,
                organizationId: null,
            }),
            'AUTHZ_ESCALATION_BLOCKED',
        );
    });

    it('a PLATFORM_ADMIN cannot grant any role — it holds no role:assign', async () => {
        const { service } = makeService();
        await expectRejection(
            service.assign({
                actor: platformAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.ARTIST,
                organizationId: null,
            }),
            'AUTHZ_ESCALATION_BLOCKED',
        );
    });

    it('a SUPER_ADMIN can grant platform roles, including SUPER_ADMIN', async () => {
        const { service, grantRole } = makeService();

        await service.assign({
            actor: superAdmin(),
            targetUserId: TARGET,
            roleKey: ROLE_KEYS.PLATFORM_ADMIN,
            organizationId: null,
        });
        await service.assign({
            actor: superAdmin(),
            targetUserId: TARGET,
            roleKey: ROLE_KEYS.SUPER_ADMIN,
            organizationId: null,
        });

        expect(grantRole).toHaveBeenCalledTimes(2);
    });

    it('blocks a privileged grant when the actor lacks one of its permissions', async () => {
        // Strict-superset rule for privileged/platform roles: an actor holding
        // role:assign:any but NOT user:suspend:any cannot hand out
        // PLATFORM_ADMIN, which carries it.
        const { service } = makeService();
        const partialSuperAdmin = principal(['role:assign:any', 'user:read:any'], {
            platformRoles: ['CUSTOM'],
        });

        await expectRejection(
            service.assign({
                actor: partialSuperAdmin,
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.PLATFORM_ADMIN,
                organizationId: null,
            }),
            'AUTHZ_ESCALATION_BLOCKED',
        );
    });
});

describe('lock-out protection', () => {
    it('refuses to revoke the last SUPER_ADMIN', async () => {
        const { service } = makeService({ holders: [TARGET] });
        await expectRejection(
            service.revoke({
                actor: superAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.SUPER_ADMIN,
                organizationId: null,
            }),
            'AUTHZ_ROLE_NOT_ASSIGNABLE',
        );
    });

    it('allows revocation while another holder remains', async () => {
        const { service, revokeRole } = makeService({ holders: [TARGET, 'user_carol'] });
        await service.revoke({
            actor: superAdmin(),
            targetUserId: TARGET,
            roleKey: ROLE_KEYS.SUPER_ADMIN,
            organizationId: null,
        });
        expect(revokeRole).toHaveBeenCalled();
    });
});

describe('revocation bookkeeping', () => {
    it('invalidates the target cache and records an audit row', async () => {
        const { service, invalidate, record } = makeService();
        await service.revoke({
            actor: orgAdmin(),
            targetUserId: TARGET,
            roleKey: ROLE_KEYS.PRODUCT_MANAGER,
            organizationId: ORG_A,
        });

        expect(invalidate).toHaveBeenCalledWith(TARGET);
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'role:revoke', result: 'SUCCESS' }),
        );
    });

    it('404s when the assignment does not exist', async () => {
        const { service, revokeRole } = makeService();
        (revokeRole as jest.Mock).mockResolvedValueOnce(0);

        await expectRejection(
            service.revoke({
                actor: orgAdmin(),
                targetUserId: TARGET,
                roleKey: ROLE_KEYS.PRODUCT_MANAGER,
                organizationId: ORG_A,
            }),
            'AUTHZ_ASSIGNMENT_NOT_FOUND',
        );
    });
});

describe('the system default-role path', () => {
    it('grants the baseline role with no actor and invalidates the cache', async () => {
        const { service, grantRole, invalidate } = makeService();
        await service.ensureDefaultRole(TARGET);

        expect(grantRole).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: TARGET,
                organizationId: null,
                grantedById: null,
            }),
        );
        expect(invalidate).toHaveBeenCalledWith(TARGET);
    });

    it('is idempotent — a replay does not re-invalidate', async () => {
        const { service, grantRole, invalidate } = makeService();
        (grantRole as jest.Mock).mockResolvedValueOnce({ id: 'a1', created: false });

        await service.ensureDefaultRole(TARGET);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('can only ever grant USER, never a role chosen by a caller', async () => {
        const { service, grantRole } = makeService();
        await service.ensureDefaultRole(TARGET);

        const call = (grantRole as jest.Mock).mock.calls[0]?.[0];
        expect(call.roleId).toBe(`role_${ROLE_KEYS.USER}`);
    });
});

describe('role kinds are as the catalog declares', () => {
    it('ORG_ADMIN is an organization role and not privileged', () => {
        const role = roleSummary(ROLE_KEYS.ORG_ADMIN);
        expect(role.kind).toBe(RoleKind.ORGANIZATION);
        expect(role.isPrivileged).toBe(false);
    });

    it('SUPER_ADMIN is a privileged platform role', () => {
        const role = roleSummary(ROLE_KEYS.SUPER_ADMIN);
        expect(role.kind).toBe(RoleKind.PLATFORM);
        expect(role.isPrivileged).toBe(true);
    });
});

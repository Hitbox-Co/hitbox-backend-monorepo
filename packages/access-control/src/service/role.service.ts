import type { AuthorizationDomain } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    ACCESS_CONTROL_ERROR_CODES,
    ACCESS_CONTROL_EVENTS,
} from '../constants/access-control.constant';
import type { IGrantsInvalidator } from '../domain/interfaces/grants-invalidator.interface';
import { findCatalogPermission } from '../domain/permission-catalog';
import type { CreateRoleDto, ListRolesQuery, UpdateRoleDto } from '../dto/access-control.dto';
import type { PermissionRepository } from '../repository/permission.repository';
import type { RoleRepository, RoleWithPermissions } from '../repository/role.repository';

export interface RoleResponse {
    id: string;
    name: string;
    displayName: string;
    entityGroup: string;
    domain: AuthorizationDomain;
    isSystem: boolean;
    isActive: boolean;
    createdAt: Date;
    permissions: { key: string; description: string | null }[];
}

export interface RoleServiceDeps {
    roles: RoleRepository;
    permissions: PermissionRepository;
    eventBus: IEventBus;
    /**
     * Editing or retiring a role changes what an unknown set of users may do,
     * so these paths flush the whole cache rather than guess the set.
     */
    cache: IGrantsInvalidator;
    logger: Logger;
}

export class RoleService {
    constructor(private readonly deps: RoleServiceDeps) { }

    async list(query: ListRolesQuery): Promise<RoleResponse[]> {
        const roles = await this.deps.roles.findAll(query);
        return roles.map(toResponse);
    }

    async getById(id: string): Promise<RoleResponse> {
        return toResponse(await this.mustFind(id));
    }

    async create(dto: CreateRoleDto): Promise<RoleResponse> {
        if (await this.deps.roles.findByName(dto.name)) {
            throw AppError.conflict(
                `A role named ${dto.name} already exists`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_NAME_TAKEN,
            );
        }

        const permissionIds = await this.resolvePermissions(dto.permissions, dto.domain);
        const role = await this.deps.roles.create({
            name: dto.name,
            displayName: dto.displayName,
            entityGroup: dto.entityGroup,
            domain: dto.domain,
            // Only the seeder creates system roles; anything made through the
            // API is operator-defined and therefore editable and deletable.
            isSystem: false,
            permissionIds,
        });

        this.deps.logger.info(
            { roleId: role.id, name: role.name, domain: role.domain },
            'role created',
        );
        await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_CREATED, {
            roleId: role.id,
            name: role.name,
            domain: role.domain,
        });
        return toResponse(role);
    }

    async update(id: string, dto: UpdateRoleDto): Promise<RoleResponse> {
        const existing = await this.mustFind(id);

        // System roles are the platform's floor. Their permission sets come
        // from the code catalog, so editing them here would be silently
        // reverted by the next seed run — and deleting HITBOX_SYSTEM_ADMIN
        // would lock everyone out. Deactivating one is still allowed.
        if (existing.isSystem && dto.permissions) {
            throw AppError.forbidden(
                `${existing.name} is a system role; its permissions are defined in the role catalog and cannot be edited through the API`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_IMMUTABLE,
            );
        }

        let role = existing;
        const { permissions, ...metadata } = dto;

        if (Object.keys(metadata).length > 0) {
            role = await this.deps.roles.update(id, metadata);
        }
        if (permissions) {
            const permissionIds = await this.resolvePermissions(permissions, existing.domain);
            role = await this.deps.roles.replacePermissions(id, permissionIds);
        }

        // A changed permission set or a deactivated role re-authorises every
        // holder, and we do not know who they are without a query. Role
        // definitions change rarely, so an O(1) flush is the right trade.
        await this.deps.cache.invalidateAll(`role ${role.name} updated`);

        this.deps.logger.info({ roleId: id, name: role.name }, 'role updated');
        await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_UPDATED, {
            roleId: id,
            name: role.name,
        });
        return toResponse(role);
    }

    async delete(id: string): Promise<void> {
        const role = await this.mustFind(id);

        if (role.isSystem) {
            throw AppError.forbidden(
                `${role.name} is a system role and cannot be deleted`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_IMMUTABLE,
            );
        }

        // Deleting a role that people still hold would revoke access as a
        // side effect, with no assignment record left to explain why. Force
        // the operator to revoke the assignments first.
        const live = await this.deps.roles.countAssignments(id);
        if (live > 0) {
            throw AppError.conflict(
                `${role.name} is still assigned to ${live} user(s). Revoke those assignments first.`,
                ACCESS_CONTROL_ERROR_CODES.ROLE_IN_USE,
                { activeAssignments: live },
            );
        }

        await this.deps.roles.delete(id);
        await this.deps.cache.invalidateAll(`role ${role.name} deleted`);

        this.deps.logger.info({ roleId: id, name: role.name }, 'role deleted');
        await this.deps.eventBus.publish(ACCESS_CONTROL_EVENTS.ROLE_DELETED, {
            roleId: id,
            name: role.name,
        });
    }

    private async mustFind(id: string): Promise<RoleWithPermissions> {
        const role = await this.deps.roles.findById(id);
        if (!role) {
            throw AppError.notFound('Role not found', ACCESS_CONTROL_ERROR_CODES.ROLE_NOT_FOUND);
        }
        return role;
    }

    /**
     * Maps catalog keys to permission row ids, enforcing the domain boundary
     * (§5) on the way through.
     *
     * This is the single chokepoint that makes the boundary real rather than
     * documentary: whatever an administrator selects in the UI, a BUSINESS
     * role cannot be given `infrastructure:deploy:global` and a TECHNICAL
     * role cannot be given `order:refund:global`.
     */
    private async resolvePermissions(
        keys: string[],
        domain: AuthorizationDomain,
    ): Promise<string[]> {
        const crossDomain = keys.filter((key) => {
            const catalogEntry = findCatalogPermission(key);
            return catalogEntry !== undefined && catalogEntry.domain !== domain;
        });
        if (crossDomain.length > 0) {
            throw AppError.badRequest(
                `A ${domain} role cannot hold ${crossDomain.length === 1 ? 'the' : ''} ` +
                `permission(s) ${crossDomain.join(', ')} — they belong to the other authorization domain.`,
                ACCESS_CONTROL_ERROR_CODES.DOMAIN_VIOLATION,
                { domain, offendingPermissions: crossDomain },
            );
        }

        const rows = await this.deps.permissions.findByKeys(keys);
        if (rows.length !== keys.length) {
            const found = new Set(rows.map((row) => row.key));
            const missing = keys.filter((key) => !found.has(key));
            // In the catalog but not in the table => the seed has not been
            // run against this database.
            throw AppError.badRequest(
                `Permission(s) ${missing.join(', ')} are not present in the database. Run the access-control seed.`,
                ACCESS_CONTROL_ERROR_CODES.UNKNOWN_PERMISSION,
                { missing },
            );
        }
        return rows.map((row) => row.id);
    }
}

function toResponse(role: RoleWithPermissions): RoleResponse {
    return {
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        entityGroup: role.entityGroup,
        domain: role.domain,
        isSystem: role.isSystem,
        isActive: role.isActive,
        createdAt: role.createdAt,
        permissions: role.rolePermissions.map((rp) => ({
            key: rp.permission.key,
            description: rp.permission.description,
        })),
    };
}

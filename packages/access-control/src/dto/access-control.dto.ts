import { AuthorizationDomain, RoleScopeType } from '@hitbox/database';
import { z } from 'zod';
import { isCatalogPermission } from '../domain/permission-catalog';

/**
 * Role names are machine identifiers: SCREAMING_SNAKE_CASE, so they read the
 * same in code, in the database and in an audit line.
 */
const roleNameSchema = z
    .string()
    .min(3)
    .max(64)
    .regex(
        /^[A-Z][A-Z0-9_]*$/,
        'Role name must be SCREAMING_SNAKE_CASE (e.g. BRAND_CONTENT_EDITOR)',
    );

/**
 * §10 in one line: a permission is only acceptable if the backend catalog
 * already contains it. An administrator selects from the catalog; they cannot
 * invent `delete-everything`.
 */
const permissionKeySchema = z.string().refine(isCatalogPermission, {
    message: 'Unknown permission. Choose from GET /admin/authz/permissions.',
});

const permissionKeysSchema = z
    .array(permissionKeySchema)
    .min(1, 'A role must grant at least one permission')
    .max(200)
    .refine((keys) => new Set(keys).size === keys.length, {
        message: 'Duplicate permissions in the list',
    });

export const createRoleSchema = z.object({
    name: roleNameSchema,
    displayName: z.string().min(1).max(120),
    entityGroup: z.enum(['end_user', 'brand_artist', 'hitbox_seller_org']),
    domain: z.nativeEnum(AuthorizationDomain),
    permissions: permissionKeysSchema,
});
export type CreateRoleDto = z.infer<typeof createRoleSchema>;

/**
 * `domain` is absent by design — a role's domain is immutable. Flipping a
 * BUSINESS role to TECHNICAL would silently re-authorise everyone already
 * holding it. Retire the role and create a new one instead.
 */
export const updateRoleSchema = z
    .object({
        displayName: z.string().min(1).max(120).optional(),
        entityGroup: z.enum(['end_user', 'brand_artist', 'hitbox_seller_org']).optional(),
        isActive: z.boolean().optional(),
        permissions: permissionKeysSchema.optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, {
        message: 'Provide at least one field to update',
    });
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

export const listRolesQuerySchema = z.object({
    domain: z.nativeEnum(AuthorizationDomain).optional(),
});
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;

export const listPermissionsQuerySchema = z.object({
    domain: z.nativeEnum(AuthorizationDomain).optional(),
    /** `grouped` returns the §12 resource-grouped shape for the admin UI. */
    shape: z.enum(['flat', 'grouped']).default('grouped'),
});
export type ListPermissionsQuery = z.infer<typeof listPermissionsQuerySchema>;

/**
 * Assigning a role. `organizationId` is required for ORG scope and forbidden
 * otherwise — enforced here rather than in the service so a malformed grant
 * never reaches the database.
 */
export const assignRoleSchema = z
    .object({
        roleId: z.string().uuid(),
        scopeType: z.nativeEnum(RoleScopeType).optional(),
        organizationId: z.string().uuid().nullish(),
    })
    .superRefine((dto, ctx) => {
        if (dto.scopeType === RoleScopeType.ORGANIZATION && !dto.organizationId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['organizationId'],
                message: 'organizationId is required for an ORG-scoped assignment',
            });
        }
        if (dto.scopeType && dto.scopeType !== RoleScopeType.ORGANIZATION && dto.organizationId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['organizationId'],
                message: `organizationId is only valid for ORG scope, not ${dto.scopeType}`,
            });
        }
    });
export type AssignRoleDto = z.infer<typeof assignRoleSchema>;

export const revokeRoleQuerySchema = z.object({
    organizationId: z.string().uuid().optional(),
});
export type RevokeRoleQuery = z.infer<typeof revokeRoleQuerySchema>;

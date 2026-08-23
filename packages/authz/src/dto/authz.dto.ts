import { z } from 'zod';
import { AuditResult } from '../domain/enums/audit.enum';

const cuid = z.string().min(1).max(64);

export const assignRoleSchema = z.object({
    roleKey: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Z][A-Z0-9_]*$/, 'roleKey must be UPPER_SNAKE_CASE'),
    /** Omit (or null) for platform roles. */
    organizationId: cuid.nullish(),
    /** Optional temporary elevation — ISO 8601, must be in the future. */
    expiresAt: z.coerce
        .date()
        .refine((date) => date.getTime() > Date.now(), 'expiresAt must be in the future')
        .nullish(),
});
export type AssignRoleDto = z.infer<typeof assignRoleSchema>;

export const revokeRoleSchema = z.object({
    roleKey: z.string().min(1).max(64),
    organizationId: cuid.nullish(),
});
export type RevokeRoleDto = z.infer<typeof revokeRoleSchema>;

export const createOrganizationSchema = z.object({
    slug: z
        .string()
        .min(2)
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
    name: z.string().min(2).max(160),
});
export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
    .object({
        name: z.string().min(2).max(160).optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateOrganizationDto = z.infer<typeof updateOrganizationSchema>;

export const addMemberSchema = z.object({
    email: z.string().email().max(255),
});
export type AddMemberDto = z.infer<typeof addMemberSchema>;

export const auditQuerySchema = z.object({
    actorUserId: cuid.optional(),
    resource: z.string().max(64).optional(),
    resourceId: cuid.optional(),
    result: z.nativeEnum(AuditResult).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: cuid.optional(),
});
export type AuditQueryDto = z.infer<typeof auditQuerySchema>;

export const listRolesQuerySchema = z.object({
    kind: z.enum(['PLATFORM', 'ORGANIZATION']).optional(),
});
export type ListRolesQueryDto = z.infer<typeof listRolesQuerySchema>;

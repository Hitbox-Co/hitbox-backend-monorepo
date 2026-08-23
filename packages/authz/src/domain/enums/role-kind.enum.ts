/**
 * Where a role may be assigned. Mirrors the Prisma `RoleKind` enum.
 *
 * PLATFORM     — assigned with organizationId = null. Covers both ordinary
 *                platform-wide roles (USER, ARTIST) and privileged ones
 *                (PLATFORM_ADMIN, SUPER_ADMIN).
 * ORGANIZATION — assigned inside exactly one organization. Its permissions are
 *                confined to that tenant (see the scope rules in scope-policy).
 */
export enum RoleKind {
    PLATFORM = 'PLATFORM',
    ORGANIZATION = 'ORGANIZATION',
}

export function isRoleKind(value: unknown): value is RoleKind {
    return value === RoleKind.PLATFORM || value === RoleKind.ORGANIZATION;
}

/**
 * How wide a capability reaches. Mirrors the Prisma `PermissionScope` enum
 * (same string values) but is declared here so the domain layer does not
 * depend on the generated client.
 */
export enum PermissionScope {
    /** Rows the acting user owns: `resource.ownerId === user.id`. */
    OWN = 'OWN',
    /** Rows belonging to the organization the request is acting in. */
    ORGANIZATION = 'ORGANIZATION',
    /** Any row on the platform. Reserved for platform-level roles. */
    ANY = 'ANY',
}

/**
 * Ordering used when reporting the *widest* scope a user holds (e.g. to the
 * frontend). It is deliberately NOT used to decide access: a user holding both
 * `own` and `organization` is evaluated against each grant independently, so a
 * wider grant can never mask a narrower one that would have allowed the call.
 */
export const PERMISSION_SCOPE_RANK: Record<PermissionScope, number> = {
    [PermissionScope.OWN]: 1,
    [PermissionScope.ORGANIZATION]: 2,
    [PermissionScope.ANY]: 3,
};

export function isPermissionScope(value: unknown): value is PermissionScope {
    return typeof value === 'string' && value in PERMISSION_SCOPE_RANK;
}

/** Returns the widest of the given scopes, or null when the list is empty. */
export function widestScope(scopes: readonly PermissionScope[]): PermissionScope | null {
    let widest: PermissionScope | null = null;
    for (const scope of scopes) {
        if (widest === null || PERMISSION_SCOPE_RANK[scope] > PERMISSION_SCOPE_RANK[widest]) {
            widest = scope;
        }
    }
    return widest;
}

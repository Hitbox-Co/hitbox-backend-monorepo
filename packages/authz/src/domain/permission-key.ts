import { PermissionScope, isPermissionScope } from './enums/permission-scope.enum';

/**
 * PERMISSION NAMING CONVENTION
 * ============================
 *
 *   <resource>:<action>:<scope>
 *
 *   product:update:own
 *   order:refund:organization
 *   user:read:any
 *
 * Rules (enforced by `parsePermissionKey` and the catalog test):
 *   - exactly three colon-separated segments
 *   - `resource` is a lowercase, kebab-case noun (singular): `product`,
 *     `artist-profile`, `financial-report`
 *   - `action`  is a lowercase, kebab-case verb: `read`, `create`, `publish`,
 *     `reconcile`. NEVER a UI concept (`show-delete-button` is forbidden).
 *   - `scope`   is one of own | organization | any (lowercase on the wire,
 *     uppercase in the database enum)
 *
 * The wire/display form is lowercase so it can be handed to frontends and put
 * in JWTs or logs verbatim; the DB stores the scope as the Prisma enum.
 */

const SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PermissionParts {
    resource: string;
    action: string;
    scope: PermissionScope;
}

/** `{ product, update, OWN }` -> `"product:update:own"` */
export function formatPermissionKey(parts: PermissionParts): string {
    return `${parts.resource}:${parts.action}:${parts.scope.toLowerCase()}`;
}

/** The capability half of a key, ignoring scope: `"product:update"`. */
export function formatCapabilityKey(resource: string, action: string): string {
    return `${resource}:${action}`;
}

/**
 * Strict parse. Throws on anything that does not match the convention so a
 * typo in a route definition fails at boot (catalog validation) rather than
 * silently denying — or worse, silently allowing — at request time.
 */
export function parsePermissionKey(key: string): PermissionParts {
    const segments = key.split(':');
    if (segments.length !== 3) {
        throw new Error(
            `Invalid permission key "${key}": expected exactly "resource:action:scope".`,
        );
    }
    const [resource, action, rawScope] = segments as [string, string, string];

    for (const [label, segment] of [
        ['resource', resource],
        ['action', action],
    ] as const) {
        if (!SEGMENT_PATTERN.test(segment)) {
            throw new Error(
                `Invalid permission key "${key}": ${label} "${segment}" must be lowercase kebab-case.`,
            );
        }
    }

    const scope = rawScope.toUpperCase();
    if (!isPermissionScope(scope)) {
        throw new Error(
            `Invalid permission key "${key}": scope "${rawScope}" must be own | organization | any.`,
        );
    }

    return { resource, action, scope };
}

/** Non-throwing variant, for validating client/DB input. */
export function tryParsePermissionKey(key: string): PermissionParts | null {
    try {
        return parsePermissionKey(key);
    } catch {
        return null;
    }
}

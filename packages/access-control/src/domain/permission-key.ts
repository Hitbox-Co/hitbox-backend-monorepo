import { PermissionAction, PermissionScope, ResourceType } from '@hitbox/database';

/**
 * Permission keys are the one string form of a capability:
 *
 *     resource:action:scope        e.g. "order:refund:global"
 *
 * The three segments are kebab-case renderings of the ResourceType,
 * PermissionAction and PermissionScope enums. The enums stay the source of
 * truth — this module is only the (de)serialiser, so a typo in a route guard
 * fails at parse time rather than silently never matching.
 */

const RESOURCE_TOKENS = Object.values(ResourceType).map(
    (value) => [toToken(value), value] as const,
);
const ACTION_TOKENS = Object.values(PermissionAction).map(
    (value) => [toToken(value), value] as const,
);
const SCOPE_TOKENS = Object.values(PermissionScope).map(
    (value) => [toToken(value), value] as const,
);

/** ENUM_VALUE -> enum-value */
function toToken(enumValue: string): string {
    return enumValue.toLowerCase().replace(/_/g, '-');
}

const RESOURCE_BY_TOKEN = new Map<string, ResourceType>(RESOURCE_TOKENS);
const ACTION_BY_TOKEN = new Map<string, PermissionAction>(ACTION_TOKENS);
const SCOPE_BY_TOKEN = new Map<string, PermissionScope>(SCOPE_TOKENS);

/**
 * Accepted spellings that are NOT the canonical token. Kept deliberately
 * small: aliases exist so the wording used in the requirements matrix and in
 * the API examples both resolve, not as a general synonym system.
 *
 *   "any" — the matrix writes `:any` where the enum says GLOBAL
 *   "org" — shorthand for the canonical `:organization`
 */
const SCOPE_ALIASES: Record<string, PermissionScope> = {
    any: PermissionScope.GLOBAL,
    org: PermissionScope.ORGANIZATION,
};

export interface ParsedPermissionKey {
    resource: ResourceType;
    action: PermissionAction;
    scope: PermissionScope;
}

/** The canonical string for a permission triple. */
export function formatPermissionKey(parsed: ParsedPermissionKey): string {
    return [
        toToken(parsed.resource),
        toToken(parsed.action),
        toToken(parsed.scope),
    ].join(':');
}

/** Canonical scope token, e.g. MASKED_PARTIAL -> "masked-partial". */
export function scopeToken(scope: PermissionScope): string {
    return toToken(scope);
}

/** Canonical resource token, e.g. CONTENT_UNLOCK -> "content-unlock". */
export function resourceToken(resource: ResourceType): string {
    return toToken(resource);
}

/** Canonical action token. */
export function actionToken(action: PermissionAction): string {
    return toToken(action);
}

/**
 * Parses "resource:action:scope". Returns null rather than throwing so
 * callers choose their own failure mode (the catalog throws at module load;
 * the admin API returns a 422).
 */
export function parsePermissionKey(key: string): ParsedPermissionKey | null {
    const segments = key.split(':');
    if (segments.length !== 3) return null;
    const [resourceToken, actionToken, scopeToken] = segments as [string, string, string];

    const resource = RESOURCE_BY_TOKEN.get(resourceToken);
    const action = ACTION_BY_TOKEN.get(actionToken);
    const scope = SCOPE_BY_TOKEN.get(scopeToken) ?? SCOPE_ALIASES[scopeToken];
    if (!resource || !action || !scope) return null;

    return { resource, action, scope };
}

/** Parses, or throws with the offending key named. Used by the catalog. */
export function parsePermissionKeyOrThrow(key: string): ParsedPermissionKey {
    const parsed = parsePermissionKey(key);
    if (!parsed) {
        throw new Error(
            `Invalid permission key "${key}". Expected "resource:action:scope" ` +
            `using the ResourceType / PermissionAction / PermissionScope enums.`,
        );
    }
    return parsed;
}

/**
 * A capability without a scope — what a route guard names ("order:refund").
 * The engine resolves the scope from the principal's grants rather than the
 * route dictating it, which is what lets one endpoint serve a buyer at :own
 * and an admin at :global.
 */
export interface ParsedCapability {
    resource: ResourceType;
    action: PermissionAction;
}

export function parseCapability(capability: string): ParsedCapability | null {
    const segments = capability.split(':');
    if (segments.length !== 2) return null;
    const [resourceTok, actionTok] = segments as [string, string];
    const resource = RESOURCE_BY_TOKEN.get(resourceTok);
    const action = ACTION_BY_TOKEN.get(actionTok);
    if (!resource || !action) return null;
    return { resource, action };
}

export function formatCapability(capability: ParsedCapability): string {
    return `${toToken(capability.resource)}:${toToken(capability.action)}`;
}

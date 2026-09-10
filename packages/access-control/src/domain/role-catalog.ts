import { AuthorizationDomain, RoleScopeType } from '@hitbox/database';
import { RESOURCE_DOMAIN, isCatalogPermission, findCatalogPermission } from './permission-catalog';

/**
 * THE ROLE CATALOG — the twelve system roles, each a named set of catalog
 * permission keys. Seeded into `roles` + `role_permissions` with
 * `isSystem = true`.
 *
 * Sourced from the RBAC requirements matrix (§A4 / Day 1-4 decision log).
 * Two deliberate departures from that document, both required by the
 * business/technical split:
 *
 *  1. `HITBOX_DB_ADMIN` is **not** here. Database administration is outside
 *     this application's authorization system — it belongs to cloud/IAM
 *     grants.
 *
 *  2. `HITBOX_SYSTEM_ADMIN` no longer holds `ops-dashboard-infra:read` or
 *     `platform-config:configure`. Those are TECHNICAL permissions and it is
 *     a BUSINESS role. The matrix itself flagged them as "recorded for audit
 *     visibility, not app-enforced" — so nothing enforced is lost, and the
 *     domain boundary stays absolute. An admin who genuinely needs them holds
 *     HITBOX_PLATFORM_ENGINEER as a second assignment.
 */

export type EntityGroup = 'end_user' | 'brand_artist' | 'hitbox_seller_org';

export interface RoleDefinition {
    /** Stable machine name; also the unique key in `roles`. */
    name: string;
    displayName: string;
    entityGroup: EntityGroup;
    domain: AuthorizationDomain;
    /** Default RoleAssignment.scopeType when this role is granted. */
    defaultScopeType: RoleScopeType;
    description: string;
    permissions: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// BUSINESS — end user
// ════════════════════════════════════════════════════════════════════════════

const BUYER_COLLECTOR: RoleDefinition = {
    name: 'BUYER_COLLECTOR',
    displayName: 'Buyer / Collector',
    entityGroup: 'end_user',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.OWN,
    description:
        "The mobile app's only role. Everything it can do is scoped to its own records or to public data.",
    permissions: [
        'self-profile:read:own',
        'self-profile:update:own',
        'my-collections:read:own',
        'my-collections:manage:own',
        'nfc-tag-claim:claim:own',
        'content-unlock:read:own',
        'order:create:own',
        'order:read:own',
        'address:manage:own',
        'notification-config:update:own',
        'drop:read:public',
        'collectible-instance:read:public',
        'search-discover:read:public',
        // Role administration is absent by design, not oversight: a buyer
        // hitting a role-management route must get 403, never a filtered 200.
    ],
};

// ════════════════════════════════════════════════════════════════════════════
// BUSINESS — brand / artist (organization-scoped)
// ════════════════════════════════════════════════════════════════════════════

const BRAND_ADMIN: RoleDefinition = {
    name: 'BRAND_ADMIN',
    displayName: 'Brand Admin',
    entityGroup: 'brand_artist',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.ORGANIZATION,
    description:
        'Runs a brand. Distinguished from Brand Employee by approval authority, brand revenue, royalties owed, artist profiles, organization settings and role assignment.',
    permissions: [
        'drop:manage:organization',
        'release-approval:read:organization',
        'release-approval:approve:organization',
        'release-approval:reject:organization',
        'collectible-instance:manage:organization',
        'assets-documents-upload:manage:organization',
        'content-unlock:manage:organization',
        'reports-dashboards:read:organization',
        'payment-royalty:read:organization',
        'brand-artist-record:read:organization',
        'brand-artist-record:update:organization',
        'employee-role-mgmt:read:organization',
        'employee-role-mgmt:assign:organization',
        'notification-config:update:organization',
        'order:read:organization',
    ],
};

const BRAND_EMPLOYEE: RoleDefinition = {
    name: 'BRAND_EMPLOYEE',
    displayName: 'Brand Employee',
    entityGroup: 'brand_artist',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.ORGANIZATION,
    description:
        'Same drop and content authoring rights as Brand Admin, but no approval authority, no monetary figures, no artist profile or organization settings, and cannot assign roles.',
    permissions: [
        'drop:manage:organization',
        // Sees the identical pending release, read-only, with no action.
        'release-approval:read:organization',
        'collectible-instance:manage:organization',
        'assets-documents-upload:manage:organization',
        'content-unlock:manage:organization',
        // Non-monetary performance metrics only — brand-level currency
        // figures are suppressed for this role.
        'reports-dashboards:read:organization',
        'notification-config:update:organization',
        'order:read:organization',
        // Withheld on purpose: payment-royalty (royalties owed hidden),
        // brand-artist-record (no artist profile / org settings),
        // employee-role-mgmt (assignment reserved to Brand Admin).
    ],
};

const ARTIST: RoleDefinition = {
    name: 'ARTIST',
    displayName: 'Artist',
    entityGroup: 'brand_artist',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.ORGANIZATION,
    description:
        'A creator managing their own drops. Can approve releases like a Brand Admin, but revenue and royalty visibility is artist-level (own), not brand-wide.',
    permissions: [
        'drop:manage:organization',
        'release-approval:read:organization',
        'release-approval:approve:organization',
        'release-approval:reject:organization',
        'collectible-instance:manage:organization',
        'assets-documents-upload:manage:organization',
        'content-unlock:manage:organization',
        // Artist-level, NOT brand-level — hence :own rather than :organization.
        'reports-dashboards:read:own',
        'payment-royalty:read:own',
        'brand-artist-record:read:own',
        'brand-artist-record:update:own',
        'notification-config:update:own',
    ],
};

// ════════════════════════════════════════════════════════════════════════════
// BUSINESS — HitBox seller org (platform-wide)
// ════════════════════════════════════════════════════════════════════════════

const HITBOX_SYSTEM_ADMIN: RoleDefinition = {
    name: 'HITBOX_SYSTEM_ADMIN',
    displayName: 'HitBox System Admin',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Highest-privilege business role and the only one that can create roles or grant them platform-wide. Every capability is an explicit permission — there is no bypass, and it holds no technical permissions.',
    permissions: [
        'self-profile:manage:global',
        'buyer-profile:manage:global',
        'drop:manage:global',
        'release-approval:manage:global',
        'release-approval:override:global',
        'collectible-instance:manage:global',
        'reports-dashboards:manage:global',
        'reports-dashboards:export:global',
        'my-collections:read:global',
        'order:manage:global',
        'order:override:global',
        'order:refund:global',
        'payment-royalty:manage:global',
        'payment-royalty:configure:global',
        'payment-royalty:override:global',
        'content-unlock:manage:global',
        'nfc-tag-claim:manage:global',
        'nfc-tag-claim:override:global',
        'brand-artist-record:manage:global',
        'employee-role-mgmt:manage:global',
        'employee-role-mgmt:assign:global',
        'employee-role-mgmt:delete:global',
        'audit-log:read:global',
        'notification-config:manage:global',
        'search-discover:manage:global',
        'assets-documents-upload:manage:global',
        // Precise GPS is never returned to any role, including this one.
        'general-location:read:masked',
        'age-specific-flag:read:global',
        'address:manage:global',
    ],
};

const HITBOX_DROP_MANAGER: RoleDefinition = {
    name: 'HITBOX_DROP_MANAGER',
    displayName: 'HitBox Drop Manager',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Manages drops across every brand, but nothing outside the drop domain. Scoped by resource type rather than by organization.',
    permissions: [
        'drop:manage:global',
        'release-approval:read:global',
        'collectible-instance:manage:global',
        'assets-documents-upload:manage:global',
        'general-location:read:masked',
        'search-discover:manage:global',
        'reports-dashboards:read:global',
    ],
};

const HITBOX_CONTENT_MANAGER: RoleDefinition = {
    name: 'HITBOX_CONTENT_MANAGER',
    displayName: 'HitBox Content Manager',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Manages exclusive content across every brand. Sees the age-restriction flag masked, unlike the System Admin.',
    permissions: [
        'content-unlock:manage:global',
        'assets-documents-upload:manage:global',
        'age-specific-flag:read:masked',
        'general-location:read:masked',
        'collectible-instance:update:global',
        'drop:read:global',
    ],
};

const HITBOX_ORDER_MANAGER: RoleDefinition = {
    name: 'HITBOX_ORDER_MANAGER',
    displayName: 'HitBox Order Manager',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Touches any order regardless of brand, but nothing outside orders. Buyer PII is partially masked — a deliberately different level from Support.',
    permissions: [
        'order:manage:global',
        'order:refund:global',
        'buyer-profile:read:masked-partial',
        'address:read:global',
        'nfc-tag-claim:read:global',
    ],
};

const HITBOX_FINANCE_ADMIN: RoleDefinition = {
    name: 'HITBOX_FINANCE_ADMIN',
    displayName: 'HitBox Finance Admin',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Reads finance records. Gateway configuration and the royalty ledger are System-Admin-only, so this role reads but never configures.',
    permissions: [
        'payment-royalty:read:global',
        'order:read:global',
        'reports-dashboards:read:global',
        // Withheld on purpose: payment-royalty:configure (gateway config) and
        // payment-royalty:manage (royalty ledger) are System Admin only.
    ],
};

const HITBOX_SUPPORT: RoleDefinition = {
    name: 'HITBOX_SUPPORT',
    displayName: 'HitBox Support',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.BUSINESS,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Resolves buyer cases with fully masked PII. Can still find a buyer by order id. There is no unmask path for this role.',
    permissions: [
        'buyer-profile:read:masked',
        'order:read:global',
        'collectible-instance:read:masked',
        'nfc-tag-claim:read:global',
        'nfc-tag-claim:update:global',
    ],
};

// ════════════════════════════════════════════════════════════════════════════
// TECHNICAL — platform engineering
//
// These roles hold ONLY technical permissions. None of them can read an
// order, issue a refund, see a financial report or suspend a user, and no
// amount of stacking them produces a business capability.
// ════════════════════════════════════════════════════════════════════════════

const HITBOX_PLATFORM_ENGINEER: RoleDefinition = {
    name: 'HITBOX_PLATFORM_ENGINEER',
    displayName: 'HitBox Platform Engineer',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.TECHNICAL,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Builds and operates the platform: deploys, diagnoses and configures the application and its infrastructure. Holds no business data access whatsoever.',
    permissions: [
        'application:read:global',
        'application:debug:global',
        'application:deploy:global',
        'application:configure:global',
        'infrastructure:read:global',
        'infrastructure:deploy:global',
        'infrastructure:restart:global',
        'infrastructure:configure:global',
        'ops-dashboard-infra:manage:global',
        'platform-config:read:global',
        'platform-config:configure:global',
    ],
};

const HITBOX_FULL_STACK_ENGINEER: RoleDefinition = {
    name: 'HITBOX_FULL_STACK_ENGINEER',
    displayName: 'HitBox Full Stack Engineer',
    entityGroup: 'hitbox_seller_org',
    domain: AuthorizationDomain.TECHNICAL,
    defaultScopeType: RoleScopeType.GLOBAL,
    description:
        'Read-and-diagnose access for application development. Cannot deploy, cannot change configuration, and holds no business permissions.',
    permissions: [
        'application:read:global',
        'application:debug:global',
        'infrastructure:read:global',
        'ops-dashboard-infra:read:global',
        'platform-config:read:global',
    ],
};

// ════════════════════════════════════════════════════════════════════════════
// Catalog
// ════════════════════════════════════════════════════════════════════════════

export const ROLE_CATALOG: readonly RoleDefinition[] = Object.freeze([
    BUYER_COLLECTOR,
    ARTIST,
    BRAND_ADMIN,
    BRAND_EMPLOYEE,
    HITBOX_SYSTEM_ADMIN,
    HITBOX_DROP_MANAGER,
    HITBOX_CONTENT_MANAGER,
    HITBOX_ORDER_MANAGER,
    HITBOX_FINANCE_ADMIN,
    HITBOX_SUPPORT,
    HITBOX_PLATFORM_ENGINEER,
    HITBOX_FULL_STACK_ENGINEER,
]);

export const ROLE_NAMES = ROLE_CATALOG.map((role) => role.name);

const ROLE_BY_NAME = new Map(ROLE_CATALOG.map((role) => [role.name, role]));

export function findRoleDefinition(name: string): RoleDefinition | undefined {
    return ROLE_BY_NAME.get(name);
}

/**
 * Fails fast at import time on the two mistakes that would silently break
 * authorization: a role referencing a permission that is not in the catalog,
 * and a role holding a permission from the other domain.
 *
 * This runs on module load, so a bad edit breaks the process at boot rather
 * than at 3am in a permission check.
 */
function assertCatalogIntegrity(): void {
    for (const role of ROLE_CATALOG) {
        const seen = new Set<string>();
        for (const key of role.permissions) {
            if (!isCatalogPermission(key)) {
                throw new Error(
                    `Role ${role.name} references "${key}", which is not in the permission catalog.`,
                );
            }
            if (seen.has(key)) {
                throw new Error(`Role ${role.name} lists "${key}" twice.`);
            }
            seen.add(key);

            const permission = findCatalogPermission(key)!;
            if (permission.domain !== role.domain) {
                throw new Error(
                    `Domain violation: ${role.domain} role ${role.name} cannot hold ` +
                    `"${key}", which is a ${permission.domain} permission ` +
                    `(resource ${permission.resource} is ${RESOURCE_DOMAIN[permission.resource]}).`,
                );
            }
        }
    }
}

assertCatalogIntegrity();

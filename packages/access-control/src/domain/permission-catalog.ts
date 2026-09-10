import {
    AuthorizationDomain,
    PermissionAction,
    PermissionScope,
    ResourceType,
} from '@hitbox/database';
import { formatPermissionKey, parsePermissionKeyOrThrow } from './permission-key';

/**
 * THE PERMISSION CATALOG — the backend's authority over which permissions
 * exist (§10). Administrators pick from this list; they never type a
 * permission string. Nothing outside this file may invent a capability, and
 * the seeder writes exactly these rows into `permissions`.
 */

// ────────────────────────────────────────────────────────────────────────────
// Domain classification
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every resource belongs to exactly one authorization domain, and a role may
 * only hold permissions from its own domain. The line drawn here is
 * **"operating the product" vs "operating the software"**:
 *
 *   BUSINESS  — drops, orders, money, buyers, content, brands, audit.
 *   TECHNICAL — releases, logs, nodes, app/platform configuration.
 *
 * Consequence worth knowing: HITBOX_SYSTEM_ADMIN is a BUSINESS role, so it
 * does NOT hold platform-config or ops-dashboard-infra. That is deliberate
 * (§5, §14) — a business administrator is not a deploy key. Someone who needs
 * both holds two role assignments.
 */
export const RESOURCE_DOMAIN: Record<ResourceType, AuthorizationDomain> = {
    [ResourceType.SELF_PROFILE]: AuthorizationDomain.BUSINESS,
    [ResourceType.BUYER_PROFILE]: AuthorizationDomain.BUSINESS,
    [ResourceType.DROP]: AuthorizationDomain.BUSINESS,
    [ResourceType.RELEASE_APPROVAL]: AuthorizationDomain.BUSINESS,
    [ResourceType.COLLECTIBLE_INSTANCE]: AuthorizationDomain.BUSINESS,
    [ResourceType.REPORTS_DASHBOARDS]: AuthorizationDomain.BUSINESS,
    [ResourceType.MY_COLLECTIONS]: AuthorizationDomain.BUSINESS,
    [ResourceType.ORDER]: AuthorizationDomain.BUSINESS,
    [ResourceType.PAYMENT_ROYALTY]: AuthorizationDomain.BUSINESS,
    [ResourceType.CONTENT_UNLOCK]: AuthorizationDomain.BUSINESS,
    [ResourceType.NFC_TAG_CLAIM]: AuthorizationDomain.BUSINESS,
    [ResourceType.BRAND_ARTIST_RECORD]: AuthorizationDomain.BUSINESS,
    [ResourceType.EMPLOYEE_ROLE_MGMT]: AuthorizationDomain.BUSINESS,
    [ResourceType.AUDIT_LOG]: AuthorizationDomain.BUSINESS,
    [ResourceType.NOTIFICATION_CONFIG]: AuthorizationDomain.BUSINESS,
    [ResourceType.SEARCH_DISCOVER]: AuthorizationDomain.BUSINESS,
    [ResourceType.ASSETS_DOCUMENTS_UPLOAD]: AuthorizationDomain.BUSINESS,
    [ResourceType.GENERAL_LOCATION]: AuthorizationDomain.BUSINESS,
    [ResourceType.AGE_SPECIFIC_FLAG]: AuthorizationDomain.BUSINESS,
    [ResourceType.ADDRESS]: AuthorizationDomain.BUSINESS,
    // ── Technical domain ────────────────────────────────────────────────────
    [ResourceType.APPLICATION]: AuthorizationDomain.TECHNICAL,
    [ResourceType.INFRASTRUCTURE]: AuthorizationDomain.TECHNICAL,
    [ResourceType.OPS_DASHBOARD_INFRA]: AuthorizationDomain.TECHNICAL,
    [ResourceType.PLATFORM_CONFIG]: AuthorizationDomain.TECHNICAL,
};

// ────────────────────────────────────────────────────────────────────────────
// Scope semantics — the two axes the engine resolves
// ────────────────────────────────────────────────────────────────────────────

/** Whose records a grant reaches. */
export const ScopeBreadth = {
    /** Every record, regardless of owner or organization. */
    ALL: 'ALL',
    /** Only records belonging to the assignment's organization. */
    ORGANIZATION: 'ORGANIZATION',
    /** Only records the acting user owns. */
    SELF: 'SELF',
} as const;
export type ScopeBreadth = (typeof ScopeBreadth)[keyof typeof ScopeBreadth];

/**
 * How much of each reached record is visible. Ordered — a higher rank is
 * strictly more revealing, which is how the engine picks the best grant when
 * a principal holds the same capability twice.
 */
export const ScopeVisibility = {
    /** Public fields only; the caller must also filter to published rows. */
    PUBLIC: 'PUBLIC',
    /** Heavily redacted PII, e.g. `j***@***.com` (HitBox Support). */
    MASKED: 'MASKED',
    /** Partially redacted PII (HitBox Order Manager). */
    PARTIAL: 'PARTIAL',
    /** Unredacted. */
    FULL: 'FULL',
} as const;
export type ScopeVisibility = (typeof ScopeVisibility)[keyof typeof ScopeVisibility];

export const VISIBILITY_RANK: Record<ScopeVisibility, number> = {
    [ScopeVisibility.PUBLIC]: 0,
    [ScopeVisibility.MASKED]: 1,
    [ScopeVisibility.PARTIAL]: 2,
    [ScopeVisibility.FULL]: 3,
};

export interface ScopeReach {
    breadth: ScopeBreadth;
    visibility: ScopeVisibility;
}

/** Decomposes each PermissionScope into its breadth + visibility. */
export const SCOPE_REACH: Record<PermissionScope, ScopeReach> = {
    [PermissionScope.GLOBAL]: {
        breadth: ScopeBreadth.ALL,
        visibility: ScopeVisibility.FULL,
    },
    [PermissionScope.ORGANIZATION]: {
        breadth: ScopeBreadth.ORGANIZATION,
        visibility: ScopeVisibility.FULL,
    },
    [PermissionScope.OWN]: {
        breadth: ScopeBreadth.SELF,
        visibility: ScopeVisibility.FULL,
    },
    [PermissionScope.MASKED_PARTIAL]: {
        breadth: ScopeBreadth.ALL,
        visibility: ScopeVisibility.PARTIAL,
    },
    [PermissionScope.MASKED]: {
        breadth: ScopeBreadth.ALL,
        visibility: ScopeVisibility.MASKED,
    },
    [PermissionScope.PUBLIC]: {
        breadth: ScopeBreadth.ALL,
        visibility: ScopeVisibility.PUBLIC,
    },
};

// ────────────────────────────────────────────────────────────────────────────
// Action implication
// ────────────────────────────────────────────────────────────────────────────

/**
 * The ONE sanctioned implication in the system, and it lives on the action,
 * not the role: `MANAGE` is documented on PermissionAction itself as the
 * superset of CREATE+READ+UPDATE+DELETE for its resource, and the role
 * catalog depends on it (Brand Admin holds `drop:manage:organization` and no
 * separate `drop:read`).
 *
 * This is NOT role inheritance (§15) — no role gains another role's
 * permissions. It is a single action expanding to the four it is defined to
 * contain, within one resource and one scope.
 */
export const ACTION_IMPLIES: Partial<Record<PermissionAction, PermissionAction[]>> = {
    [PermissionAction.MANAGE]: [
        PermissionAction.CREATE,
        PermissionAction.READ,
        PermissionAction.UPDATE,
        PermissionAction.DELETE,
    ],
};

/** Does holding `held` satisfy a request for `required`? */
export function actionSatisfies(
    held: PermissionAction,
    required: PermissionAction,
): boolean {
    if (held === required) return true;
    return (ACTION_IMPLIES[held] ?? []).includes(required);
}

// ────────────────────────────────────────────────────────────────────────────
// Display metadata (§12 — group permissions by resource, never raw strings)
// ────────────────────────────────────────────────────────────────────────────

export const RESOURCE_DISPLAY: Record<ResourceType, string> = {
    [ResourceType.SELF_PROFILE]: 'My Profile',
    [ResourceType.BUYER_PROFILE]: 'Buyer Profiles',
    [ResourceType.DROP]: 'Drops & Products',
    [ResourceType.RELEASE_APPROVAL]: 'Release Approvals',
    [ResourceType.COLLECTIBLE_INSTANCE]: 'Collectible Instances',
    [ResourceType.REPORTS_DASHBOARDS]: 'Reports & Dashboards',
    [ResourceType.MY_COLLECTIONS]: 'My Collections',
    [ResourceType.ORDER]: 'Orders',
    [ResourceType.PAYMENT_ROYALTY]: 'Payments & Royalties',
    [ResourceType.CONTENT_UNLOCK]: 'Exclusive Content',
    [ResourceType.NFC_TAG_CLAIM]: 'NFC Tags & Claims',
    [ResourceType.BRAND_ARTIST_RECORD]: 'Brands & Artists',
    [ResourceType.EMPLOYEE_ROLE_MGMT]: 'Roles & Access',
    [ResourceType.AUDIT_LOG]: 'Audit Log',
    [ResourceType.NOTIFICATION_CONFIG]: 'Notifications',
    [ResourceType.SEARCH_DISCOVER]: 'Search & Discover',
    [ResourceType.ASSETS_DOCUMENTS_UPLOAD]: 'Assets & Documents',
    [ResourceType.GENERAL_LOCATION]: 'Buyer Location',
    [ResourceType.AGE_SPECIFIC_FLAG]: 'Age-Restricted Flag',
    [ResourceType.ADDRESS]: 'Addresses',
    [ResourceType.APPLICATION]: 'Application',
    [ResourceType.INFRASTRUCTURE]: 'Infrastructure',
    [ResourceType.OPS_DASHBOARD_INFRA]: 'Ops Dashboards',
    [ResourceType.PLATFORM_CONFIG]: 'Platform Configuration',
};

const ACTION_DISPLAY: Record<PermissionAction, string> = {
    [PermissionAction.CREATE]: 'Create',
    [PermissionAction.READ]: 'Read',
    [PermissionAction.UPDATE]: 'Update',
    [PermissionAction.DELETE]: 'Delete',
    [PermissionAction.MANAGE]: 'Manage',
    [PermissionAction.APPROVE]: 'Approve',
    [PermissionAction.REJECT]: 'Reject',
    [PermissionAction.PUBLISH]: 'Publish',
    [PermissionAction.REFUND]: 'Refund',
    [PermissionAction.CLAIM]: 'Claim',
    [PermissionAction.TRANSFER]: 'Transfer',
    [PermissionAction.ASSIGN]: 'Assign',
    [PermissionAction.EXPORT]: 'Export',
    [PermissionAction.CONFIGURE]: 'Configure',
    [PermissionAction.OVERRIDE]: 'Override',
    [PermissionAction.DEBUG]: 'Debug',
    [PermissionAction.DEPLOY]: 'Deploy',
    [PermissionAction.RESTART]: 'Restart',
};

const SCOPE_DISPLAY: Record<PermissionScope, string> = {
    [PermissionScope.GLOBAL]: 'Platform-wide',
    [PermissionScope.ORGANIZATION]: 'Own organization',
    [PermissionScope.OWN]: 'Own records',
    [PermissionScope.PUBLIC]: 'Public data',
    [PermissionScope.MASKED]: 'Masked',
    [PermissionScope.MASKED_PARTIAL]: 'Partially masked',
};

// ────────────────────────────────────────────────────────────────────────────
// The catalog itself
// ────────────────────────────────────────────────────────────────────────────

export interface CatalogPermission {
    key: string;
    resource: ResourceType;
    action: PermissionAction;
    scope: PermissionScope;
    domain: AuthorizationDomain;
    description: string;
    /** §12 display group — the resource's human name. */
    group: string;
    actionLabel: string;
    scopeLabel: string;
}

/** key -> one-line description. The catalog is built from this map. */
const DEFINITIONS: Record<string, string> = {
    // ── Own account ─────────────────────────────────────────────────────────
    'self-profile:read:own': 'View your own profile.',
    'self-profile:update:own': 'Edit your own profile.',
    'self-profile:manage:global': 'Administer any user profile.',

    // ── Buyer PII (three visibility levels on ONE capability) ───────────────
    'buyer-profile:read:masked': 'Look up a buyer with PII fully masked.',
    'buyer-profile:read:masked-partial': 'Look up a buyer with PII partially masked.',
    'buyer-profile:manage:global': 'Full unmasked access to buyer records.',

    // ── Drops / products ────────────────────────────────────────────────────
    'drop:read:public': 'Browse published drops.',
    'drop:read:global': 'View any drop, including unpublished.',
    'drop:manage:organization': "Create, edit and retire your organization's drops.",
    'drop:manage:global': 'Create, edit and retire any drop on the platform.',

    // ── Release approval workflow ───────────────────────────────────────────
    'release-approval:read:organization': "View your organization's pending releases.",
    'release-approval:read:global': 'View any pending release.',
    'release-approval:approve:organization': "Approve your organization's releases.",
    'release-approval:reject:organization': "Reject your organization's releases.",
    'release-approval:manage:global': 'Administer the release approval queue.',
    'release-approval:override:global': 'Force a release past a stalled approval.',

    // ── Serialized items ────────────────────────────────────────────────────
    'collectible-instance:read:public': 'View public details of a collectible.',
    'collectible-instance:read:masked': 'View a collectible with owner details masked.',
    'collectible-instance:update:global': 'Edit collectible instance records.',
    'collectible-instance:manage:organization': "Manage your organization's collectibles.",
    'collectible-instance:manage:global': 'Manage any collectible instance.',

    // ── Reporting ───────────────────────────────────────────────────────────
    'reports-dashboards:read:own': 'View your own performance and revenue.',
    'reports-dashboards:read:organization': "View your organization's reports.",
    'reports-dashboards:read:global': 'View platform-wide reports.',
    'reports-dashboards:export:global': 'Export report data.',
    'reports-dashboards:manage:global': 'Administer reports and dashboards.',

    // ── Buyer collections ───────────────────────────────────────────────────
    'my-collections:read:own': 'View your own collection.',
    'my-collections:manage:own': 'Organise and share your own collection.',
    'my-collections:read:global': 'View any buyer collection.',

    // ── Orders ──────────────────────────────────────────────────────────────
    'order:create:own': 'Place an order.',
    'order:read:own': 'View your own orders.',
    'order:read:organization': "View your organization's orders.",
    'order:read:global': 'View any order.',
    'order:manage:global': 'Administer any order.',
    'order:refund:global': 'Issue a refund on any order.',
    'order:override:global': 'Override order state outside the normal flow.',

    // ── Money ───────────────────────────────────────────────────────────────
    'payment-royalty:read:own': 'View your own royalty accrual.',
    'payment-royalty:read:organization': "View your organization's royalties owed.",
    'payment-royalty:read:global': 'View platform payment and royalty records.',
    'payment-royalty:configure:global': 'Configure payment gateways.',
    'payment-royalty:manage:global': 'Administer payments and the royalty ledger.',
    'payment-royalty:override:global': 'Override a payment or royalty posting.',

    // ── Exclusive content ───────────────────────────────────────────────────
    'content-unlock:read:own': 'View content you have unlocked.',
    'content-unlock:manage:organization': "Manage your organization's content bundles.",
    'content-unlock:manage:global': 'Manage any content bundle.',

    // ── NFC tags ────────────────────────────────────────────────────────────
    'nfc-tag-claim:claim:own': 'Claim a collectible by tapping its tag.',
    'nfc-tag-claim:read:global': 'View any tag and claim status.',
    'nfc-tag-claim:update:global': 'Update tag state while resolving a case.',
    'nfc-tag-claim:manage:global': 'Administer tags and claims.',
    'nfc-tag-claim:override:global': 'Revoke a claim and flag a tag.',

    // ── Brands & artists ────────────────────────────────────────────────────
    'brand-artist-record:read:own': 'View your own artist profile.',
    'brand-artist-record:update:own': 'Edit your own artist profile.',
    'brand-artist-record:read:organization': "View your organization's brand and artist records.",
    'brand-artist-record:update:organization': 'Edit organization settings.',
    'brand-artist-record:manage:global': 'Administer any brand or artist record.',

    // ── Role administration ─────────────────────────────────────────────────
    'employee-role-mgmt:read:organization': "View your organization's role assignments.",
    'employee-role-mgmt:assign:organization': 'Assign roles within your own organization.',
    'employee-role-mgmt:assign:global': 'Assign any role at any scope.',
    'employee-role-mgmt:delete:global': 'Revoke any role assignment.',
    'employee-role-mgmt:manage:global': 'Create and edit roles and their permissions.',

    // ── Audit ───────────────────────────────────────────────────────────────
    'audit-log:read:global': 'Read the platform audit log.',

    // ── Notifications ───────────────────────────────────────────────────────
    'notification-config:update:own': 'Change your own notification preferences.',
    'notification-config:update:organization': "Change your organization's notification settings.",
    'notification-config:manage:global': 'Administer notification templates and channels.',

    // ── Search ──────────────────────────────────────────────────────────────
    'search-discover:read:public': 'Search public catalog data.',
    'search-discover:manage:global': 'Administer search and discovery.',

    // ── Uploads ─────────────────────────────────────────────────────────────
    'assets-documents-upload:manage:organization': "Upload and manage your organization's assets.",
    'assets-documents-upload:manage:global': 'Upload and manage any asset or document.',

    // ── Sensitive buyer attributes ──────────────────────────────────────────
    // Precise GPS is never returned to ANY role; `masked` is the widest that
    // exists for location, by design.
    'general-location:read:masked': 'View coarse buyer location for analytics.',
    'age-specific-flag:read:masked': 'See whether an item is age-restricted.',
    'age-specific-flag:read:global': 'View the full age-restriction value.',

    // ── Addresses ───────────────────────────────────────────────────────────
    'address:manage:own': 'Manage your own address book.',
    'address:read:global': 'View any address for fulfilment.',
    'address:manage:global': 'Administer any address.',

    // ══ TECHNICAL DOMAIN ════════════════════════════════════════════════════
    'application:read:global': 'View application health and release state.',
    'application:debug:global': 'Read logs and traces, run diagnostics.',
    'application:deploy:global': 'Deploy an application release.',
    'application:configure:global': 'Change application runtime configuration.',

    'infrastructure:read:global': 'View infrastructure state.',
    'infrastructure:deploy:global': 'Apply infrastructure changes.',
    'infrastructure:restart:global': 'Restart a service or node.',
    'infrastructure:configure:global': 'Change infrastructure configuration.',

    'ops-dashboard-infra:read:global': 'View operational dashboards.',
    'ops-dashboard-infra:manage:global': 'Administer operational dashboards.',

    'platform-config:read:global': 'View platform configuration and feature flags.',
    'platform-config:configure:global': 'Change platform configuration and feature flags.',
};

function build(): CatalogPermission[] {
    return Object.entries(DEFINITIONS).map(([key, description]) => {
        const { resource, action, scope } = parsePermissionKeyOrThrow(key);
        const canonical = formatPermissionKey({ resource, action, scope });
        if (canonical !== key) {
            throw new Error(
                `Permission "${key}" is not in canonical form (expected "${canonical}"). ` +
                `Catalog keys must be canonical so the seeder and route guards agree.`,
            );
        }
        return {
            key,
            resource,
            action,
            scope,
            domain: RESOURCE_DOMAIN[resource],
            description,
            group: RESOURCE_DISPLAY[resource],
            actionLabel: ACTION_DISPLAY[action],
            scopeLabel: SCOPE_DISPLAY[scope],
        };
    });
}

export const PERMISSION_CATALOG: readonly CatalogPermission[] = Object.freeze(build());

const CATALOG_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));

export function findCatalogPermission(key: string): CatalogPermission | undefined {
    return CATALOG_BY_KEY.get(key);
}

export function isCatalogPermission(key: string): boolean {
    return CATALOG_BY_KEY.has(key);
}

export function catalogPermissionsForDomain(
    domain: AuthorizationDomain,
): CatalogPermission[] {
    return PERMISSION_CATALOG.filter((p) => p.domain === domain);
}

/**
 * §12 — the catalog grouped by resource for the admin UI, so an administrator
 * picks "Orders → Refund" rather than typing `order:refund:global`.
 */
export interface PermissionGroup {
    resource: ResourceType;
    group: string;
    domain: AuthorizationDomain;
    permissions: CatalogPermission[];
}

export function permissionGroups(): PermissionGroup[] {
    const byResource = new Map<ResourceType, PermissionGroup>();
    for (const permission of PERMISSION_CATALOG) {
        let entry = byResource.get(permission.resource);
        if (!entry) {
            entry = {
                resource: permission.resource,
                group: permission.group,
                domain: permission.domain,
                permissions: [],
            };
            byResource.set(permission.resource, entry);
        }
        entry.permissions.push(permission);
    }
    return [...byResource.values()];
}

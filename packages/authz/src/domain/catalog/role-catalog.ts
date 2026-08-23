import { PermissionScope } from '../enums/permission-scope.enum';
import { RoleKind } from '../enums/role-kind.enum';
import { PERMISSION_CATALOG, PERMISSION_BY_KEY } from './permission-catalog';
import { formatPermissionKey } from '../permission-key';

/**
 * THE ROLE CATALOG — roles are *configuration*, not code. Nothing in the
 * application branches on a role key; business logic only ever asks for a
 * permission. Changing what PRODUCT_MANAGER can do means editing this file and
 * re-running the seeder — no application code changes, no redeploy of callers.
 *
 * Two kinds (see RoleKind):
 *   PLATFORM     — granted with organizationId = null
 *   ORGANIZATION — granted inside exactly one tenant
 *
 * A user holds MANY roles; their effective permission set is the union.
 */

export interface RoleDefinition {
    key: string;
    name: string;
    description: string;
    kind: RoleKind;
    /**
     * Privileged roles may only ever be granted by a holder of
     * `role:assign:any` — i.e. an organization administrator can never mint a
     * platform administrator (requirement: no vertical escalation).
     */
    isPrivileged: boolean;
    /**
     * Permission keys, or ALL_PLATFORM_PERMISSIONS for SUPER_ADMIN. The seeder
     * expands whatever is here into explicit role_permissions rows, so a
     * `SELECT` always shows exactly what a role can do — there is no wildcard
     * short-circuit anywhere in the request path.
     */
    permissions: readonly string[];
}

/**
 * Every catalog permission except the ORGANIZATION-scoped ones.
 *
 * ORGANIZATION scope is meaningless for a platform-wide assignment (there is
 * no tenant to compare against), and every organization-scoped capability has
 * an `any`-scoped counterpart that strictly supersedes it — so this is
 * complete, not a gap. See docs/authorization/09-security.md.
 */
export const ALL_PLATFORM_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.filter(
    (permission) => permission.scope !== PermissionScope.ORGANIZATION,
).map(formatPermissionKey);

export const ROLE_KEYS = {
    // Platform
    USER: 'USER',
    ARTIST: 'ARTIST',
    PLATFORM_ADMIN: 'PLATFORM_ADMIN',
    SUPER_ADMIN: 'SUPER_ADMIN',
    // Organization
    ORG_ADMIN: 'ORG_ADMIN',
    PRODUCT_MANAGER: 'PRODUCT_MANAGER',
    CONTENT_MANAGER: 'CONTENT_MANAGER',
    ORDER_MANAGER: 'ORDER_MANAGER',
    SUPPORT_AGENT: 'SUPPORT_AGENT',
    FINANCE_MANAGER: 'FINANCE_MANAGER',
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

/**
 * The role every authenticated person gets. Assigned automatically when the
 * users module projects a new Clerk identity (see the authz event subscriber),
 * so "signed in" and "has baseline permissions" never drift apart.
 */
export const DEFAULT_PLATFORM_ROLE: RoleKey = ROLE_KEYS.USER;

export const ROLE_CATALOG: readonly RoleDefinition[] = [
    // ======================================================= PLATFORM ROLES
    {
        key: ROLE_KEYS.USER,
        name: 'User',
        description:
            'Baseline role for every signed-in person: manage your own profile, collections, orders and reviews.',
        kind: RoleKind.PLATFORM,
        isPrivileged: false,
        permissions: [
            'profile:read:own',
            'profile:update:own',
            'product:read:any',
            'collection:read:any',
            'collection:create:own',
            'collection:update:own',
            'collection:delete:own',
            'order:create:own',
            'order:read:own',
            'order:cancel:own',
            'payment:read:own',
            'review:create:own',
            'review:update:own',
            'review:delete:own',
            'claim:create:own',
            'claim:read:own',
        ],
    },
    {
        key: ROLE_KEYS.ARTIST,
        name: 'Artist',
        description:
            'A creator publishing their own collectibles. Held IN ADDITION TO the USER role, never instead of it.',
        kind: RoleKind.PLATFORM,
        isPrivileged: false,
        permissions: [
            'product:read:any',
            'product:create:own',
            'product:update:own',
            'product:delete:own',
            'product:transfer:own',
            'artist-profile:read:any',
            'artist-profile:update:own',
            'collection:read:any',
            'order:read:own',
            'analytics:read:own',
        ],
    },
    {
        key: ROLE_KEYS.PLATFORM_ADMIN,
        name: 'Platform Administrator',
        description:
            'Platform-wide operations. Deliberately EXCLUDES role management, account deletion, organization deletion and anything that moves money — those need SUPER_ADMIN.',
        kind: RoleKind.PLATFORM,
        isPrivileged: true,
        permissions: [
            'profile:read:any',
            'user:read:any',
            'user:update:any',
            'user:suspend:any',
            'organization:read:any',
            'organization:create:any',
            'organization:update:any',
            'organization-member:read:any',
            'role:read:any',
            'permission:read:any',
            'product:read:any',
            'product:update:any',
            'product:delete:any',
            'product:publish:any',
            'category:read:any',
            'category:create:any',
            'category:update:any',
            'category:delete:any',
            'inventory:read:any',
            'inventory:update:any',
            'content:read:any',
            'content:create:any',
            'content:update:any',
            'content:delete:any',
            'content:publish:any',
            'review:delete:any',
            'order:read:any',
            'order:update:any',
            'order:cancel:any',
            'claim:read:any',
            'artist-profile:read:any',
            'artist-profile:approve:any',
            'payment:read:any',
            'transaction:read:any',
            'financial-report:read:any',
            'analytics:read:any',
            'audit-log:read:any',
        ],
    },
    {
        key: ROLE_KEYS.SUPER_ADMIN,
        name: 'Super Administrator',
        description:
            'Break-glass platform role. Expanded to explicit permission rows by the seeder (no wildcard in the request path), gated by step-up verification on every sensitive capability, and fully audited. Keep the holder count in single digits.',
        kind: RoleKind.PLATFORM,
        isPrivileged: true,
        permissions: ALL_PLATFORM_PERMISSIONS,
    },

    // =================================================== ORGANIZATION ROLES
    {
        key: ROLE_KEYS.ORG_ADMIN,
        name: 'Organization Administrator',
        description:
            'Runs one tenant: members, org-level roles, settings and its audit trail. Has NO platform-level capability — org admin is not a step towards platform admin.',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'organization:read:organization',
            'organization:update:organization',
            'organization-member:read:organization',
            'organization-member:invite:organization',
            'organization-member:delete:organization',
            'role:read:organization',
            'role:assign:organization',
            'role:revoke:organization',
            'user:read:organization',
            'user:update:organization',
            'user:suspend:organization',
            'audit-log:read:organization',
            'analytics:read:organization',
            'product:read:any',
        ],
    },
    {
        key: ROLE_KEYS.PRODUCT_MANAGER,
        name: 'Product Manager',
        description: 'Owns the tenant catalog: products, categories and stock.',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'product:read:any',
            'product:create:organization',
            'product:update:organization',
            'product:delete:organization',
            'product:publish:organization',
            'category:read:organization',
            'category:create:organization',
            'category:update:organization',
            'category:delete:organization',
            'inventory:read:organization',
            'inventory:update:organization',
        ],
    },
    {
        key: ROLE_KEYS.CONTENT_MANAGER,
        name: 'Content Manager',
        description: 'Owns editorial content and product copy for the tenant.',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'content:read:organization',
            'content:create:organization',
            'content:update:organization',
            'content:delete:organization',
            'content:publish:organization',
            'product:read:any',
            'product:update:organization',
        ],
    },
    {
        key: ROLE_KEYS.ORDER_MANAGER,
        name: 'Order Manager',
        description: 'Fulfilment for the tenant: order lifecycle, shipping and refunds.',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'order:read:organization',
            'order:update:organization',
            'order:cancel:organization',
            'order:refund:organization',
            'order:ship:organization',
        ],
    },
    {
        key: ROLE_KEYS.SUPPORT_AGENT,
        name: 'Support Agent',
        description:
            'Front-line support. Can look up customers and orders and raise refund requests, but cannot execute a refund itself (separation of duties).',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'customer:read:organization',
            'order:read:organization',
            'order:update:organization',
            'product:read:any',
            'refund:request:organization',
        ],
    },
    {
        key: ROLE_KEYS.FINANCE_MANAGER,
        name: 'Finance Manager',
        description:
            'Money movement and reconciliation for the tenant. Holds refund EXECUTION, which SUPPORT_AGENT deliberately does not.',
        kind: RoleKind.ORGANIZATION,
        isPrivileged: false,
        permissions: [
            'order:read:organization',
            'payment:read:organization',
            'refund:process:organization',
            'transaction:read:organization',
            'transaction:export:organization',
            'transaction:reconcile:organization',
            'financial-report:read:organization',
        ],
    },
];

export const ROLE_BY_KEY: ReadonlyMap<string, RoleDefinition> = new Map(
    ROLE_CATALOG.map((role) => [role.key, role]),
);

/** Resolves the permission definitions a catalog role carries. */
export function permissionsForRole(roleKey: string) {
    const role = ROLE_BY_KEY.get(roleKey);
    if (!role) return [];
    return role.permissions.flatMap((key) => {
        const definition = PERMISSION_BY_KEY.get(key);
        return definition ? [definition] : [];
    });
}

/**
 * The closed set of business resources authorization knows about.
 *
 * Adding a resource is a one-line change here plus its permissions in
 * permission-catalog.ts — no middleware, service or controller changes.
 * Keeping it closed means a typo in a route (`requirePermission('prodcut', …)`)
 * is a TYPE ERROR instead of a permission that no role can ever hold and that
 * therefore denies every caller silently.
 */
export const RESOURCES = {
    // Identity / account
    PROFILE: 'profile',
    USER: 'user',
    CUSTOMER: 'customer',

    // Catalog
    PRODUCT: 'product',
    CATEGORY: 'category',
    INVENTORY: 'inventory',
    COLLECTION: 'collection',
    ARTIST_PROFILE: 'artist-profile',
    CLAIM: 'claim',
    REVIEW: 'review',
    CONTENT: 'content',

    // Commerce
    ORDER: 'order',
    PAYMENT: 'payment',
    REFUND: 'refund',
    TRANSACTION: 'transaction',
    FINANCIAL_REPORT: 'financial-report',

    // Insight
    ANALYTICS: 'analytics',

    // Governance (authz itself)
    ORGANIZATION: 'organization',
    ORGANIZATION_MEMBER: 'organization-member',
    ROLE: 'role',
    PERMISSION: 'permission',
    AUDIT_LOG: 'audit-log',
} as const;

export type ResourceName = (typeof RESOURCES)[keyof typeof RESOURCES];

/**
 * The closed set of actions. Business capabilities only — never UI state.
 * `read` covers single-record and list reads; `search` is separate only where
 * it is a distinct, expensive capability worth granting on its own.
 */
export const ACTIONS = {
    READ: 'read',
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    PUBLISH: 'publish',
    APPROVE: 'approve',
    SUSPEND: 'suspend',
    CANCEL: 'cancel',
    REFUND: 'refund',
    SHIP: 'ship',
    PROCESS: 'process',
    REQUEST: 'request',
    EXPORT: 'export',
    RECONCILE: 'reconcile',
    ASSIGN: 'assign',
    REVOKE: 'revoke',
    INVITE: 'invite',
    TRANSFER: 'transfer',
} as const;

export type ActionName = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * Actions that never mutate state. Used by the catalog soundness check: an
 * ORGANIZATION-kind role may only hold an `any`-scoped permission when the
 * action is read-only (e.g. a product manager reading the public catalog),
 * because a write at `any` scope would break tenant isolation.
 */
export const READ_ONLY_ACTIONS: readonly ActionName[] = [ACTIONS.READ, ACTIONS.EXPORT];

const RESOURCE_VALUES = new Set<string>(Object.values(RESOURCES));
const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));

export function isKnownResource(value: string): value is ResourceName {
    return RESOURCE_VALUES.has(value);
}

export function isKnownAction(value: string): value is ActionName {
    return ACTION_VALUES.has(value);
}

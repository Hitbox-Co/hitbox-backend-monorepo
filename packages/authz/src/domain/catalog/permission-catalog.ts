import { PermissionScope } from '../enums/permission-scope.enum';
import { formatPermissionKey } from '../permission-key';
import { ACTIONS, RESOURCES } from './resources';
import type { ActionName, ResourceName } from './resources';

/**
 * THE PERMISSION CATALOG — the single source of truth for what capabilities
 * exist on the platform. The `permissions` table is a reconciled projection of
 * this list (see scripts/seed-authz.ts); the database is the source of truth
 * for who HOLDS a permission, this file for which permissions EXIST.
 *
 * Adding a capability: add a row here, run the seeder. Nothing else changes.
 *
 * Guidance encoded here:
 *   - one row per (resource, action, scope) — the DB unique constraint
 *   - `sensitive: true` makes the capability require a recently verified
 *     session (step-up) and forces an audit record, everywhere, automatically
 *   - never add a permission that describes a UI element; describe the
 *     business capability and let the frontend derive UI from it
 */

export interface PermissionDefinition {
    resource: ResourceName;
    action: ActionName;
    scope: PermissionScope;
    description: string;
    /** Requires step-up verification and is always audited. */
    sensitive: boolean;
}

const OWN = PermissionScope.OWN;
const ORG = PermissionScope.ORGANIZATION;
const ANY = PermissionScope.ANY;

interface Spec {
    action: ActionName;
    scopes: readonly PermissionScope[];
    description: string;
    /** Scopes (of those listed) that are sensitive. `true` = all of them. */
    sensitive?: true | readonly PermissionScope[];
}

function define(resource: ResourceName, specs: readonly Spec[]): PermissionDefinition[] {
    return specs.flatMap((spec) =>
        spec.scopes.map((scope) => ({
            resource,
            action: spec.action,
            scope,
            description: spec.description,
            sensitive:
                spec.sensitive === true
                    ? true
                    : Array.isArray(spec.sensitive)
                        ? spec.sensitive.includes(scope)
                        : false,
        })),
    );
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
    // ---------------------------------------------------------------- identity
    ...define(RESOURCES.PROFILE, [
        { action: ACTIONS.READ, scopes: [OWN, ANY], description: 'View a user profile' },
        { action: ACTIONS.UPDATE, scopes: [OWN], description: 'Edit your own profile' },
    ]),
    ...define(RESOURCES.USER, [
        {
            action: ACTIONS.READ,
            scopes: [OWN, ORG, ANY],
            description: 'Read platform user records',
        },
        {
            action: ACTIONS.UPDATE,
            scopes: [OWN, ORG, ANY],
            description: 'Modify a user record',
        },
        {
            action: ACTIONS.SUSPEND,
            scopes: [ORG, ANY],
            description: 'Suspend a user account',
            sensitive: true,
        },
        {
            action: ACTIONS.DELETE,
            scopes: [ANY],
            description: 'Delete a user account (irreversible)',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.CUSTOMER, [
        {
            action: ACTIONS.READ,
            scopes: [ORG, ANY],
            description: 'Read customer records for support work',
        },
    ]),

    // ----------------------------------------------------------------- catalog
    ...define(RESOURCES.PRODUCT, [
        { action: ACTIONS.READ, scopes: [OWN, ORG, ANY], description: 'View products' },
        { action: ACTIONS.CREATE, scopes: [OWN, ORG, ANY], description: 'Create a product' },
        { action: ACTIONS.UPDATE, scopes: [OWN, ORG, ANY], description: 'Edit a product' },
        {
            action: ACTIONS.DELETE,
            scopes: [OWN, ORG, ANY],
            description: 'Archive/delete a product',
            sensitive: [ANY],
        },
        {
            action: ACTIONS.PUBLISH,
            scopes: [ORG, ANY],
            description: 'Publish a product to the storefront',
        },
        {
            action: ACTIONS.TRANSFER,
            scopes: [OWN, ANY],
            description: 'Transfer product ownership',
        },
    ]),
    ...define(RESOURCES.CATEGORY, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View product categories' },
        { action: ACTIONS.CREATE, scopes: [ORG, ANY], description: 'Create a category' },
        { action: ACTIONS.UPDATE, scopes: [ORG, ANY], description: 'Edit a category' },
        { action: ACTIONS.DELETE, scopes: [ORG, ANY], description: 'Delete a category' },
    ]),
    ...define(RESOURCES.INVENTORY, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View stock levels' },
        { action: ACTIONS.UPDATE, scopes: [ORG, ANY], description: 'Adjust stock levels' },
    ]),
    // A collection is a personal shelf, so it is owned by a user and never by a
    // tenant — hence OWN/ANY only, no ORGANIZATION scope.
    ...define(RESOURCES.COLLECTION, [
        { action: ACTIONS.READ, scopes: [OWN, ANY], description: 'View a collection' },
        { action: ACTIONS.CREATE, scopes: [OWN, ANY], description: 'Create a collection' },
        { action: ACTIONS.UPDATE, scopes: [OWN, ANY], description: 'Edit a collection' },
        { action: ACTIONS.DELETE, scopes: [OWN, ANY], description: 'Delete a collection' },
    ]),
    ...define(RESOURCES.ARTIST_PROFILE, [
        { action: ACTIONS.READ, scopes: [OWN, ANY], description: 'View an artist profile' },
        {
            action: ACTIONS.UPDATE,
            scopes: [OWN, ORG, ANY],
            description: 'Edit an artist profile',
        },
        {
            action: ACTIONS.APPROVE,
            scopes: [ORG, ANY],
            description: 'Approve an artist onto the platform',
        },
    ]),
    ...define(RESOURCES.CLAIM, [
        {
            action: ACTIONS.READ,
            scopes: [OWN, ANY],
            description: 'View NFC authenticity claims',
        },
        { action: ACTIONS.CREATE, scopes: [OWN], description: 'Claim a tagged collectible' },
    ]),
    ...define(RESOURCES.REVIEW, [
        { action: ACTIONS.READ, scopes: [ANY], description: 'View reviews' },
        { action: ACTIONS.CREATE, scopes: [OWN], description: 'Write a review' },
        { action: ACTIONS.UPDATE, scopes: [OWN, ORG, ANY], description: 'Edit a review' },
        { action: ACTIONS.DELETE, scopes: [OWN, ORG, ANY], description: 'Remove a review' },
    ]),
    ...define(RESOURCES.CONTENT, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View editorial content' },
        { action: ACTIONS.CREATE, scopes: [ORG, ANY], description: 'Create editorial content' },
        { action: ACTIONS.UPDATE, scopes: [ORG, ANY], description: 'Edit editorial content' },
        { action: ACTIONS.DELETE, scopes: [ORG, ANY], description: 'Delete editorial content' },
        { action: ACTIONS.PUBLISH, scopes: [ORG, ANY], description: 'Publish editorial content' },
    ]),

    // ---------------------------------------------------------------- commerce
    ...define(RESOURCES.ORDER, [
        { action: ACTIONS.READ, scopes: [OWN, ORG, ANY], description: 'View orders' },
        { action: ACTIONS.CREATE, scopes: [OWN], description: 'Place an order' },
        { action: ACTIONS.UPDATE, scopes: [ORG, ANY], description: 'Modify an order' },
        { action: ACTIONS.CANCEL, scopes: [OWN, ORG, ANY], description: 'Cancel an order' },
        {
            action: ACTIONS.REFUND,
            scopes: [ORG, ANY],
            description: 'Refund an order',
            sensitive: true,
        },
        { action: ACTIONS.SHIP, scopes: [ORG, ANY], description: 'Mark an order shipped' },
    ]),
    ...define(RESOURCES.PAYMENT, [
        { action: ACTIONS.READ, scopes: [OWN, ORG, ANY], description: 'View payment records' },
    ]),
    ...define(RESOURCES.REFUND, [
        {
            action: ACTIONS.REQUEST,
            scopes: [ORG, ANY],
            description: 'Raise a refund request for approval',
        },
        {
            action: ACTIONS.PROCESS,
            scopes: [ORG, ANY],
            description: 'Approve and execute a refund (moves money)',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.TRANSACTION, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View ledger transactions' },
        {
            action: ACTIONS.EXPORT,
            scopes: [ORG, ANY],
            description: 'Bulk-export transactions',
            sensitive: true,
        },
        {
            action: ACTIONS.RECONCILE,
            scopes: [ORG, ANY],
            description: 'Reconcile the financial ledger',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.FINANCIAL_REPORT, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View financial reports' },
    ]),

    // ----------------------------------------------------------------- insight
    ...define(RESOURCES.ANALYTICS, [
        {
            action: ACTIONS.READ,
            scopes: [OWN, ORG, ANY],
            description: 'View analytics dashboards',
        },
    ]),

    // -------------------------------------------------------------- governance
    ...define(RESOURCES.ORGANIZATION, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'View organization details' },
        { action: ACTIONS.CREATE, scopes: [ANY], description: 'Create an organization' },
        {
            action: ACTIONS.UPDATE,
            scopes: [ORG, ANY],
            description: 'Edit organization settings',
        },
        {
            action: ACTIONS.SUSPEND,
            scopes: [ANY],
            description: 'Suspend an organization',
            sensitive: true,
        },
        {
            action: ACTIONS.DELETE,
            scopes: [ANY],
            description: 'Delete an organization (irreversible)',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.ORGANIZATION_MEMBER, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'List organization members' },
        { action: ACTIONS.INVITE, scopes: [ORG, ANY], description: 'Invite a member' },
        {
            action: ACTIONS.DELETE,
            scopes: [ORG, ANY],
            description: 'Remove a member from the organization',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.ROLE, [
        {
            action: ACTIONS.READ,
            scopes: [ORG, ANY],
            description: 'List roles and the permissions they carry',
        },
        {
            action: ACTIONS.ASSIGN,
            scopes: [ORG, ANY],
            description: 'Grant a role to a user',
            sensitive: true,
        },
        {
            action: ACTIONS.REVOKE,
            scopes: [ORG, ANY],
            description: 'Remove a role from a user',
            sensitive: true,
        },
        {
            action: ACTIONS.UPDATE,
            scopes: [ANY],
            description: 'Change which permissions a role carries',
            sensitive: true,
        },
    ]),
    ...define(RESOURCES.PERMISSION, [
        { action: ACTIONS.READ, scopes: [ANY], description: 'List the permission catalog' },
    ]),
    ...define(RESOURCES.AUDIT_LOG, [
        { action: ACTIONS.READ, scopes: [ORG, ANY], description: 'Read the audit trail' },
        {
            action: ACTIONS.EXPORT,
            scopes: [ORG, ANY],
            description: 'Bulk-export the audit trail',
            sensitive: true,
        },
    ]),
];

/** `"product:update:own"` -> definition. Built once at import time. */
export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDefinition> = new Map(
    PERMISSION_CATALOG.map((permission) => [formatPermissionKey(permission), permission]),
);

export const ALL_PERMISSION_KEYS: readonly string[] = [...PERMISSION_BY_KEY.keys()];

/** Keys that require step-up verification. Exposed for docs and tests. */
export const SENSITIVE_PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.filter(
    (permission) => permission.sensitive,
).map(formatPermissionKey);

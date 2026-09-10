import type {
    AuthorizationDomain,
    PermissionAction,
    PermissionScope,
    ResourceType,
    RoleScopeType,
} from '@hitbox/database';

/**
 * One capability a principal holds, flattened across
 * RoleAssignment → Role → RolePermission → Permission.
 *
 * A principal with three role assignments produces the union of all three
 * roles' permissions as grants — this is how multi-role users work (§8),
 * with no role inheriting from another.
 */
export interface PrincipalGrant {
    resource: ResourceType;
    action: PermissionAction;
    /** Scope declared on the Permission — carries breadth AND visibility. */
    scope: PermissionScope;
    domain: AuthorizationDomain;

    roleId: string;
    roleName: string;
    /** Always equals `domain`; the role service enforces the invariant. */
    roleDomain: AuthorizationDomain;

    /** Breadth of the *assignment* the grant arrived through. */
    assignmentScopeType: RoleScopeType;
    /** Organization id when assignmentScopeType is ORG, else null. */
    assignmentScopeId: string | null;

    /** Optional column-level narrowing for update actions. Empty = no limit. */
    fieldAllowlist: string[];
}

/** Everything the engine needs about who is asking. */
export interface Principal {
    userId: string;
    grants: PrincipalGrant[];
}

/**
 * Port for loading a principal's effective grants. Implemented by this
 * module's repository today; when access-control becomes its own service this
 * is re-implemented as an RPC client and the engine is untouched.
 */
export interface IPrincipalGrantsLookup {
    findGrantsByUserId(userId: string): Promise<PrincipalGrant[]>;
}

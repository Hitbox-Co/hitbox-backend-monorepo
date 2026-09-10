import type { AuthorizationDomain } from '@hitbox/database';
import {
    PERMISSION_CATALOG,
    catalogPermissionsForDomain,
    permissionGroups,
} from '../domain/permission-catalog';
import type { CatalogPermission, PermissionGroup } from '../domain/permission-catalog';
import type { ListPermissionsQuery } from '../dto/access-control.dto';

/**
 * Serves the permission catalog to the admin panel. Read-only by design —
 * permissions are system-defined (§10), so there is no create or delete.
 *
 * Note it reads the code-side catalog, not the table: the catalog is the
 * authority and the table is its mirror, so the UI can never offer a
 * permission the engine would not understand.
 */
export class PermissionService {
    list(query: ListPermissionsQuery): CatalogPermission[] | PermissionGroup[] {
        if (query.shape === 'flat') {
            return query.domain
                ? catalogPermissionsForDomain(query.domain)
                : [...PERMISSION_CATALOG];
        }
        const groups = permissionGroups();
        return query.domain ? groups.filter((g) => g.domain === query.domain) : groups;
    }

    /** Flat catalog for a single domain — used when editing a role. */
    listForDomain(domain: AuthorizationDomain): CatalogPermission[] {
        return catalogPermissionsForDomain(domain);
    }
}

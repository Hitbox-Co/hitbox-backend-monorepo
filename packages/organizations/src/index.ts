/**
 * @hitbox/organizations
 *
 * Organization records — HitBox, brands and artist-individual entities.
 *
 * An organization is the *owner* of a drop: `Product.organizationId` points
 * here, orders record it, and role assignments scope to it. This module
 * currently exposes the directory (read-only) that the drop form's brand
 * picker and the catalog's owner labels are built from; creating and editing
 * organizations is an onboarding workflow with no screen yet.
 */

export { createOrganizationsModule } from './module';
export type {
    OrganizationsModule,
    OrganizationsModuleDeps,
    OrganizationsPermissionGuard,
} from './module';

export {
    ORGANIZATION_READ_CAPABILITY,
    ORGANIZATIONS_ERROR_CODES,
    ORGANIZATIONS_MODULE,
} from './constants/organizations.constant';

export { listOrganizationsQuerySchema } from './dto/organization.dto';
export type {
    ListOrganizationsQuery,
    OrganizationResponse,
} from './dto/organization.dto';

export type { OrganizationService } from './service/organization.service';

export const MODULE_NAME = 'organizations' as const;

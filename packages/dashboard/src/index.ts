/**
 * @hitbox/dashboard
 *
 * The admin dashboard read model. One permission-driven API — the caller's
 * grants decide which sections exist in the response, never which endpoint
 * they call.
 */

export { createDashboardModule } from './module';
export type { DashboardModule, DashboardModuleDeps } from './module';

export {
    DASHBOARD_ERROR_CODES,
    DASHBOARD_MODULE,
    DASHBOARD_SECTIONS,
    DASHBOARD_DEFAULT_LIMIT,
    DASHBOARD_MAX_LIMIT,
} from './constants/dashboard.constant';
export type { DashboardSection } from './constants/dashboard.constant';

// Access resolution — exported so tests and other read models can reuse it.
export {
    DASHBOARD_RESOURCES,
    ReadScope,
    Visibility,
    accessFor,
    allows,
    buildAccess,
    can,
    requireSection,
    resolveAccess,
} from './domain/dashboard-access';
export type {
    DashboardAccess,
    DashboardPrincipal,
    ResourceAccess,
} from './domain/dashboard-access';

// Admin classification — the single source of truth for the users/admins split.
export {
    INTERNAL_ADMIN_ROLE_NAMES,
    isInternalAdminRoleName,
    isInternalAdminUser,
} from './domain/admin-classification';

// Period + money helpers.
export { growthPercentage, resolvePeriod, serialisePeriod } from './domain/period';
export type { PeriodType, ResolvedPeriod } from './domain/period';
export { addMoney, money, subtractMoney, sumByCurrency } from './domain/money';
export type { MoneyByCurrency } from './domain/money';

export type { PrincipalResolver } from './controller/dashboard.controller';

// DTOs — useful for typing a client.
export {
    activityQuerySchema,
    dashboardQuerySchema,
    ordersQuerySchema,
    paginatedQuerySchema,
    productsQuerySchema,
    provenanceQuerySchema,
    releaseApprovalsQuerySchema,
    resaleQuerySchema,
    supplyQuerySchema,
} from './dto/dashboard.dto';
export type { DashboardQuery, OrdersQuery, PaginatedQuery } from './dto/dashboard.dto';

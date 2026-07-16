/**
 * Auth-facing account status, derived by the users module from
 * `User.state` + `User.deletedAt` (see users' account-lookup adapter).
 */
export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DELETED = 'DELETED',
}

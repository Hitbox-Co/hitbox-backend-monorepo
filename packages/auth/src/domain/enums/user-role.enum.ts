/**
 * Only the Users are allowed to login for now
 */
export enum UserRole {
  USER = 'USER',
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && value in UserRole;
}

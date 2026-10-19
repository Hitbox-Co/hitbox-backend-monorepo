/**
 * Who counts as an internal HitBox staff account.
 *
 * This is the single source of truth for the `newUsers` / `adminUsers` split.
 * Do not duplicate the list — a second copy is how the two metrics start
 * disagreeing with each other six months from now.
 *
 * Two things it is deliberately NOT:
 *
 *  • It is **not** `User.role`. That enum has exactly one member (`USER`) and
 *    cannot represent privilege at all. Every classification here comes from
 *    a live `RoleAssignment` → `Role.name`.
 *  • It is **not** "has any elevated role". Brand staff hold real, elevated,
 *    org-scoped assignments and are still counted as commercial partners
 *    rather than internal staff, because the metric these feed is HitBox's
 *    own headcount growth.
 */

export const INTERNAL_ADMIN_ROLE_NAMES: readonly string[] = [
    'HITBOX_SYSTEM_ADMIN',
    'HITBOX_DROP_MANAGER',
    'HITBOX_CONTENT_MANAGER',
    'HITBOX_ORDER_MANAGER',
    'HITBOX_FINANCE_ADMIN',
    'HITBOX_SUPPORT',
    'HITBOX_PLATFORM_ENGINEER',
    'HITBOX_FULL_STACK_ENGINEER',
    // Deliberately absent:
    //   HITBOX_DB_ADMIN     — not implemented in this platform at all;
    //                         database administration is a cloud/IAM grant.
    //   BRAND_ADMIN         — commercial partner, not internal staff, even
    //   BRAND_EMPLOYEE        though both hold elevated org-scoped roles.
    //   ARTIST              — a creator, and frequently also a buyer.
];

const INTERNAL_ADMIN_ROLE_SET = new Set(INTERNAL_ADMIN_ROLE_NAMES);

export function isInternalAdminRoleName(roleName: string): boolean {
    return INTERNAL_ADMIN_ROLE_SET.has(roleName);
}

/**
 * Classifies a user from their live role assignments.
 *
 * A user holding both an internal and a commercial role (a Support agent who
 * is also an Artist) is internal, and is therefore counted **once**, under
 * `adminUsers` — never in both buckets. Double-counting here would make
 * `newUsers + newAdmins` exceed the real signup count, which is the kind of
 * error nobody notices until the two charts are put side by side.
 */
export function isInternalAdminUser(roleNames: readonly string[]): boolean {
    return roleNames.some((name) => INTERNAL_ADMIN_ROLE_SET.has(name));
}

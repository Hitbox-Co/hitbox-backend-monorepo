import { RoleScopeType } from '@hitbox/database';
import type { Logger } from 'pino';
import { ACCESS_CONTROL_ERROR_CODES } from '../constants/access-control.constant';
import type { RoleAssignmentService } from './role-assignment.service';
import type { RoleRepository } from '../repository/role.repository';

/** The baseline role every account holds: buying, own orders, own invoices. */
export const DEFAULT_ACCOUNT_ROLE = 'BUYER_COLLECTOR';

export interface DefaultRoleServiceDeps {
    roles: Pick<RoleRepository, 'findByName'>;
    assignments: Pick<RoleAssignmentService, 'assign'>;
    logger: Logger;
}

/**
 * Gives a new account the buyer role. Without it a signed-in user holds no
 * permissions at all and every `order:*` route answers 403.
 *
 * Driven by `users.account.provisioned`. Idempotent: a replayed event, or an
 * account that already holds the role, does nothing. Self-granted
 * (`grantedById` = the user), the same way the first administrator is.
 */
export class DefaultRoleService {
    constructor(private readonly deps: DefaultRoleServiceDeps) { }

    /** @returns true when the role was newly granted. */
    async grantTo(userId: string): Promise<boolean> {
        const role = await this.deps.roles.findByName(DEFAULT_ACCOUNT_ROLE);
        if (!role || !role.isActive) {
            this.deps.logger.error(
                { userId, role: DEFAULT_ACCOUNT_ROLE },
                'default account role is missing — run `pnpm db:seed:authz`',
            );
            return false;
        }
        try {
            await this.deps.assignments.assign({
                userId,
                dto: { roleId: role.id, scopeType: RoleScopeType.OWN },
                grantedById: userId,
            });
            return true;
        } catch (error) {
            if ((error as { code?: string }).code === ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS) return false;
            throw error;
        }
    }
}

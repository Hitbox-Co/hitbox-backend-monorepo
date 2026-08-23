import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import type { UserDeletedPayload, UserRegisteredPayload } from '@hitbox/auth';
import { USERS_ERROR_CODES } from '../constants/users.constant';
import { USERS_EVENTS } from '../events/users-event.payloads';
import type {
    UserDeactivatedPayload,
    UserProvisionedPayload,
} from '../events/users-event.payloads';
import { toMe, toPublicUser } from '../dto/user.dto';
import type { MeDto, PublicUserDto, UpdateProfileDto } from '../dto/user.dto';
import type { UserRepository } from '../repository/user.repository';

interface UserServiceDeps {
    users: UserRepository;
    eventBus: IEventBus;
    logger: Logger;
}

export class UserService {
    constructor(private readonly deps: UserServiceDeps) { }

    async getPublicById(id: string): Promise<PublicUserDto> {
        const user = await this.deps.users.findById(id);
        if (!user || user.deletedAt) {
            throw AppError.notFound('User not found', USERS_ERROR_CODES.USER_NOT_FOUND);
        }
        return toPublicUser(user);
    }

    async getMe(accountId: string): Promise<MeDto> {
        const user = await this.deps.users.findById(accountId);
        if (!user || user.deletedAt) {
            throw AppError.notFound('User not found', USERS_ERROR_CODES.USER_NOT_FOUND);
        }
        return toMe(user);
    }

    async updateProfile(accountId: string, dto: UpdateProfileDto): Promise<MeDto> {
        try {
            const user = await this.deps.users.updateProfile(accountId, dto);
            return toMe(user);
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                throw AppError.conflict(
                    'Username already taken',
                    USERS_ERROR_CODES.USERNAME_TAKEN,
                );
            }
            throw error;
        }
    }

    // ── Auth event handlers (idempotent — the bus is at-most-once today,
    //    at-least-once after a broker upgrade) ────────────────────────────

    async syncFromClerk(payload: UserRegisteredPayload): Promise<void> {
        const existing = await this.deps.users.findByClerkUserId(payload.clerkUserId);
        const user = await this.deps.users.upsertFromClerk(payload);
        this.deps.logger.info({ userId: user.id, clerkUserId: payload.clerkUserId }, 'user synced from clerk');

        // Announce the LOCAL row, not the Clerk identity. @hitbox/authz listens
        // for this to grant the baseline platform role — it needs the user row
        // to already exist, which is exactly what this event guarantees.
        const provisioned: UserProvisionedPayload = {
            userId: user.id,
            clerkUserId: payload.clerkUserId,
            email: user.email,
            firstTime: existing === null,
        };
        await this.deps.eventBus.publish(USERS_EVENTS.USER_PROVISIONED, provisioned);
    }

    async markDeleted(payload: UserDeletedPayload): Promise<void> {
        const user = await this.deps.users.findByClerkUserId(payload.clerkUserId);
        await this.deps.users.softDeleteByClerkUserId(payload.clerkUserId);
        this.deps.logger.info({ clerkUserId: payload.clerkUserId }, 'user soft-deleted');

        if (!user) return;
        // Cached permissions for a deleted account must stop working now, not
        // when the cache TTL happens to expire.
        const deactivated: UserDeactivatedPayload = {
            userId: user.id,
            clerkUserId: payload.clerkUserId,
            reason: 'deleted',
        };
        await this.deps.eventBus.publish(USERS_EVENTS.USER_DEACTIVATED, deactivated);
    }
}

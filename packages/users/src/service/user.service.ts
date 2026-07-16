import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import type { UserDeletedPayload, UserRegisteredPayload } from '@hitbox/auth';
import { USERS_ERROR_CODES } from '../constants/users.constant';
import { toMe, toPublicUser } from '../dto/user.dto';
import type { MeDto, PublicUserDto, UpdateProfileDto } from '../dto/user.dto';
import type { UserRepository } from '../repository/user.repository';

interface UserServiceDeps {
    users: UserRepository;
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
        const user = await this.deps.users.upsertFromClerk(payload);
        this.deps.logger.info({ userId: user.id, clerkUserId: payload.clerkUserId }, 'user synced from clerk');
    }

    async markDeleted(payload: UserDeletedPayload): Promise<void> {
        await this.deps.users.softDeleteByClerkUserId(payload.clerkUserId);
        this.deps.logger.info({ clerkUserId: payload.clerkUserId }, 'user soft-deleted');
    }
}

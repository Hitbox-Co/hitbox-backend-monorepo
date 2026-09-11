import { Prisma, Visibility } from '@hitbox/database';
import type { User } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { UserDeletedPayload, UserRegisteredPayload } from '@hitbox/auth';
import type { Logger } from 'pino';
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

    /**
     * A public profile lookup — this route is unauthenticated.
     *
     * `profileVisibility` is honoured here: a PRIVATE profile is reported as
     * not found rather than forbidden, so the endpoint cannot be used to
     * enumerate which user ids exist.
     */
    async getPublicById(id: string): Promise<PublicUserDto> {
        const user = await this.deps.users.findById(id);
        if (!this.isReadable(user) || user.profileVisibility !== Visibility.PUBLIC) {
            throw AppError.notFound('User not found', USERS_ERROR_CODES.USER_NOT_FOUND);
        }
        return toPublicUser(user);
    }

    async getMe(accountId: string): Promise<MeDto> {
        const user = await this.deps.users.findById(accountId);
        if (!this.isReadable(user)) {
            throw AppError.notFound('User not found', USERS_ERROR_CODES.USER_NOT_FOUND);
        }
        return toMe(user);
    }

    async updateProfile(accountId: string, dto: UpdateProfileDto): Promise<MeDto> {
        try {
            return toMe(await this.deps.users.updateProfile(accountId, dto));
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                // `handle` and `email` are both unique, so report whichever
                // actually collided rather than always blaming the handle.
                const target = Array.isArray(error.meta?.target)
                    ? (error.meta.target as string[])
                    : [];
                if (target.includes('email')) {
                    throw AppError.conflict(
                        'Email already in use',
                        USERS_ERROR_CODES.EMAIL_TAKEN,
                    );
                }
                throw AppError.conflict(
                    'Handle already taken',
                    USERS_ERROR_CODES.HANDLE_TAKEN,
                );
            }
            throw error;
        }
    }

    // ── Auth event handlers ─────────────────────────────────────────────────
    // Idempotent: the bus is at-most-once today and at-least-once after a
    // broker upgrade, so both handlers must tolerate being replayed.

    async syncFromClerk(payload: UserRegisteredPayload): Promise<void> {
        const user = await this.deps.users.upsertFromClerk(payload);
        this.deps.logger.info(
            { userId: user.id, clerkId: payload.clerkUserId },
            'user synced from clerk',
        );
    }

    async markDeleted(payload: UserDeletedPayload): Promise<void> {
        await this.deps.users.softDeleteByClerkId(payload.clerkUserId);
        this.deps.logger.info({ clerkId: payload.clerkUserId }, 'user soft-deleted');
    }

    /** A row exists and has not been tombstoned. */
    private isReadable(user: User | null): user is User {
        return user !== null && user.archivedAt === null;
    }
}

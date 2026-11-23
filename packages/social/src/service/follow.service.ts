import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { SOCIAL_ERROR_CODES } from '../constants/social.constant';
import type {
    FollowArtistView,
    FollowCounts,
    FollowingQueryDto,
    FollowListQueryDto,
    FollowResult,
    FollowUserView,
} from '../dto/follow.dto';
import type { FollowRepository } from '../repository/follow.repository';

interface FollowServiceDeps {
    follows: FollowRepository;
    logger: Logger;
}

type UserCard = {
    id: string;
    handle: string | null;
    fullName: string | null;
    avatarUrl: string | null;
    profileVisibility: string;
};

/**
 * Following collectors and artists (docs/mobile-app/follows-api.md).
 *
 * Privacy: a PRIVATE profile hides what its owner has claimed, not who they
 * are — so anyone may follow it, and it appears in follower lists with its
 * name and avatar. Follow and unfollow are idempotent.
 */
export class FollowService {
    constructor(private readonly deps: FollowServiceDeps) { }

    async followUser(followerId: string, userId: string): Promise<FollowResult> {
        if (followerId === userId) {
            throw AppError.badRequest('You cannot follow yourself.', SOCIAL_ERROR_CODES.CANNOT_FOLLOW_SELF);
        }
        await this.requireUser(userId);
        await this.deps.follows.follow(followerId, { followedUserId: userId });
        return { following: true, followerCount: await this.deps.follows.countUserFollowers(userId) };
    }

    async unfollowUser(followerId: string, userId: string): Promise<FollowResult> {
        await this.deps.follows.unfollow(followerId, { followedUserId: userId });
        return { following: false, followerCount: await this.deps.follows.countUserFollowers(userId) };
    }

    async followArtist(followerId: string, artistId: string): Promise<FollowResult> {
        if (!(await this.deps.follows.findFollowableArtist(artistId))) {
            throw AppError.notFound('Artist not found.', SOCIAL_ERROR_CODES.ARTIST_NOT_FOUND);
        }
        await this.deps.follows.follow(followerId, { artistId });
        return { following: true, followerCount: await this.deps.follows.countArtistFollowers(artistId) };
    }

    async unfollowArtist(followerId: string, artistId: string): Promise<FollowResult> {
        await this.deps.follows.unfollow(followerId, { artistId });
        return { following: false, followerCount: await this.deps.follows.countArtistFollowers(artistId) };
    }

    /** For profile stats. */
    counts(userId: string): Promise<FollowCounts> {
        return this.deps.follows.counts(userId);
    }

    /** Whether `viewerId` follows `userId`. */
    async isFollowingUser(viewerId: string, userId: string): Promise<boolean> {
        return (await this.deps.follows.followedUserIds(viewerId, [userId])).has(userId);
    }

    isFollowingArtist(viewerId: string, artistId: string): Promise<boolean> {
        return this.deps.follows.followsArtist(viewerId, artistId);
    }

    async listFollowers(userId: string, query: FollowListQueryDto, viewerId: string | null) {
        await this.requireUser(userId);
        const { items, total } = await this.deps.follows.listFollowers(userId, skip(query), query.limit);
        return { items: await this.toUserViews(items, viewerId), total };
    }

    async listFollowing(
        userId: string,
        query: FollowingQueryDto,
        viewerId: string | null,
    ): Promise<{ items: (FollowUserView | FollowArtistView)[]; total: number }> {
        await this.requireUser(userId);
        if (query.type === 'artists') {
            const { items, total } = await this.deps.follows.listFollowingArtists(userId, skip(query), query.limit);
            return {
                items: items.map(({ artist, followedAt }) => ({ ...artist, followedAt: followedAt.toISOString() })),
                total,
            };
        }
        const { items, total } = await this.deps.follows.listFollowingUsers(userId, skip(query), query.limit);
        return { items: await this.toUserViews(items, viewerId), total };
    }

    private async toUserViews(
        rows: { user: UserCard; followedAt: Date }[],
        viewerId: string | null,
    ): Promise<FollowUserView[]> {
        const followed = viewerId
            ? await this.deps.follows.followedUserIds(viewerId, rows.map((row) => row.user.id))
            : null;
        return rows.map(({ user, followedAt }) => ({
            id: user.id,
            handle: user.handle,
            fullName: user.fullName,
            avatarUrl: user.avatarUrl,
            isPrivate: user.profileVisibility !== 'PUBLIC',
            followedAt: followedAt.toISOString(),
            isFollowedByYou: followed && user.id !== viewerId ? followed.has(user.id) : null,
        }));
    }

    private async requireUser(userId: string): Promise<void> {
        if (!(await this.deps.follows.findFollowableUser(userId))) {
            throw AppError.notFound('User not found.', SOCIAL_ERROR_CODES.USER_NOT_FOUND);
        }
    }
}

function skip(query: { page: number; limit: number }): number {
    return (query.page - 1) * query.limit;
}

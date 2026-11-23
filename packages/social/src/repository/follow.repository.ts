import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';

/**
 * Follow rows. Reads `User` and `Artist` directly to check a target exists
 * and to render list rows — the same documented shortcut collections takes
 * for its product cards; on extraction both become port calls.
 */
export class FollowRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** A followable collector: exists, active, not deleted. */
    findFollowableUser(id: string) {
        return this.prisma.user.findFirst({
            where: { id, isActive: true, archivedAt: null },
            select: { id: true },
        });
    }

    /** A followable artist: public, active, not archived. */
    findFollowableArtist(id: string) {
        return this.prisma.artist.findFirst({
            where: { id, isPublic: true, isActive: true, archivedAt: null },
            select: { id: true },
        });
    }

    /** Insert, treating "already following" (unique violation) as success. */
    async follow(followerId: string, target: { followedUserId: string } | { artistId: string }): Promise<boolean> {
        try {
            await this.prisma.follow.create({
                data: { id: randomUUID(), followerId, ...target, createdAt: new Date() },
            });
            return true;
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
            throw error;
        }
    }

    async unfollow(followerId: string, target: { followedUserId: string } | { artistId: string }): Promise<number> {
        return (await this.prisma.follow.deleteMany({ where: { followerId, ...target } })).count;
    }

    countUserFollowers(userId: string): Promise<number> {
        return this.prisma.follow.count({ where: { followedUserId: userId, follower: activeUser } });
    }

    countArtistFollowers(artistId: string): Promise<number> {
        return this.prisma.follow.count({ where: { artistId, follower: activeUser } });
    }

    async counts(userId: string): Promise<{ followers: number; following: number; followingArtists: number }> {
        const [followers, following, followingArtists] = await this.prisma.$transaction([
            this.prisma.follow.count({ where: { followedUserId: userId, follower: activeUser } }),
            this.prisma.follow.count({ where: { followerId: userId, followedUser: activeUser } }),
            this.prisma.follow.count({ where: { followerId: userId, artist: activeArtist } }),
        ]);
        return { followers, following, followingArtists };
    }

    /** Of `userIds`, which ones `viewerId` follows. */
    async followedUserIds(viewerId: string, userIds: string[]): Promise<Set<string>> {
        if (userIds.length === 0) return new Set();
        const rows = await this.prisma.follow.findMany({
            where: { followerId: viewerId, followedUserId: { in: userIds } },
            select: { followedUserId: true },
        });
        return new Set(rows.map((row) => row.followedUserId!));
    }

    async followsArtist(viewerId: string, artistId: string): Promise<boolean> {
        return (await this.prisma.follow.count({ where: { followerId: viewerId, artistId } })) > 0;
    }

    async listFollowers(userId: string, skip: number, take: number) {
        const where: Prisma.FollowWhereInput = { followedUserId: userId, follower: activeUser };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.follow.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip,
                take,
                select: { createdAt: true, follower: { select: userCardSelect } },
            }),
            this.prisma.follow.count({ where }),
        ]);
        return { items: rows.map((row) => ({ user: row.follower, followedAt: row.createdAt })), total };
    }

    async listFollowingUsers(userId: string, skip: number, take: number) {
        const where: Prisma.FollowWhereInput = { followerId: userId, followedUser: activeUser };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.follow.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip,
                take,
                select: { createdAt: true, followedUser: { select: userCardSelect } },
            }),
            this.prisma.follow.count({ where }),
        ]);
        return { items: rows.map((row) => ({ user: row.followedUser!, followedAt: row.createdAt })), total };
    }

    async listFollowingArtists(userId: string, skip: number, take: number) {
        const where: Prisma.FollowWhereInput = { followerId: userId, artist: activeArtist };
        const [rows, total] = await this.prisma.$transaction([
            this.prisma.follow.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip,
                take,
                select: {
                    createdAt: true,
                    artist: { select: { id: true, name: true, slug: true, avatarUrl: true } },
                },
            }),
            this.prisma.follow.count({ where }),
        ]);
        return { items: rows.map((row) => ({ artist: row.artist!, followedAt: row.createdAt })), total };
    }
}

/** Deactivated or deleted accounts drop out of every count and list. */
const activeUser: Prisma.UserWhereInput = { isActive: true, archivedAt: null };
const activeArtist: Prisma.ArtistWhereInput = { isPublic: true, isActive: true, archivedAt: null };

const userCardSelect = {
    id: true,
    handle: true,
    fullName: true,
    avatarUrl: true,
    profileVisibility: true,
} satisfies Prisma.UserSelect;

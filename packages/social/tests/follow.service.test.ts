import { describe, expect, it, jest } from '@jest/globals';
import { FollowService } from '../src/service/follow.service';

/** docs/mobile-app/follows-api.md */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

function build(opts: { userExists?: boolean; artistExists?: boolean } = {}) {
    const follows = {
        findFollowableUser: jest.fn(async () => (opts.userExists === false ? null : { id: 'u2' })),
        findFollowableArtist: jest.fn(async () => (opts.artistExists === false ? null : { id: 'a1' })),
        follow: jest.fn(async () => true),
        unfollow: jest.fn(async () => 1),
        countUserFollowers: jest.fn(async () => 5),
        countArtistFollowers: jest.fn(async () => 9),
        counts: jest.fn(async () => ({ followers: 5, following: 2, followingArtists: 1 })),
        followedUserIds: jest.fn(async () => new Set(['u3'])),
        followsArtist: jest.fn(async () => true),
        listFollowers: jest.fn(async () => ({
            items: [
                { user: { id: 'u3', handle: 'cara', fullName: 'Cara', avatarUrl: null, profileVisibility: 'PRIVATE' }, followedAt: new Date('2026-11-20T10:00:00Z') },
                { user: { id: 'u1', handle: 'me', fullName: 'Me', avatarUrl: null, profileVisibility: 'PUBLIC' }, followedAt: new Date('2026-11-19T10:00:00Z') },
            ],
            total: 2,
        })),
        listFollowingUsers: jest.fn(async () => ({ items: [], total: 0 })),
        listFollowingArtists: jest.fn(async () => ({
            items: [{ artist: { id: 'a1', name: 'Studio Nova', slug: 'studio-nova', avatarUrl: null }, followedAt: new Date('2026-11-20T10:00:00Z') }],
            total: 1,
        })),
    };
    return { service: new FollowService({ follows: follows as never, logger: silentLogger }), follows };
}

describe('following collectors', () => {
    it('follows and reports the new follower count', async () => {
        const { service, follows } = build();
        await expect(service.followUser('u1', 'u2')).resolves.toEqual({ following: true, followerCount: 5 });
        expect(follows.follow).toHaveBeenCalledWith('u1', { followedUserId: 'u2' });
    });

    it('refuses to follow yourself', async () => {
        await expect(build().service.followUser('u1', 'u1')).rejects.toMatchObject({ statusCode: 400, code: 'SOCIAL_CANNOT_FOLLOW_SELF' });
    });

    it('404s an unknown, deactivated or deleted collector', async () => {
        await expect(build({ userExists: false }).service.followUser('u1', 'u2')).rejects.toMatchObject({ code: 'SOCIAL_USER_NOT_FOUND' });
    });

    it('unfollow is idempotent', async () => {
        const { service, follows } = build();
        follows.unfollow.mockResolvedValueOnce(0 as never);
        await expect(service.unfollowUser('u1', 'u2')).resolves.toEqual({ following: false, followerCount: 5 });
    });
});

describe('following artists', () => {
    it('follows a public artist', async () => {
        await expect(build().service.followArtist('u1', 'a1')).resolves.toEqual({ following: true, followerCount: 9 });
    });

    it('404s an artist with no public profile', async () => {
        await expect(build({ artistExists: false }).service.followArtist('u1', 'a1')).rejects.toMatchObject({ code: 'SOCIAL_ARTIST_NOT_FOUND' });
    });
});

describe('lists', () => {
    it('shows private followers by name, and whether the viewer follows each', async () => {
        const { items } = await build().service.listFollowers('u2', { page: 1, limit: 20 }, 'u1');
        expect(items[0]).toMatchObject({ id: 'u3', handle: 'cara', isPrivate: true, isFollowedByYou: true });
        // The viewer's own row carries no follow button.
        expect(items[1]).toMatchObject({ id: 'u1', isFollowedByYou: null });
    });

    it('isFollowedByYou is null for guests', async () => {
        const { items } = await build().service.listFollowers('u2', { page: 1, limit: 20 }, null);
        expect(items.every((item) => item.isFollowedByYou === null)).toBe(true);
    });

    it('lists followed artists with ?type=artists', async () => {
        const { items } = await build().service.listFollowing('u2', { page: 1, limit: 20, type: 'artists' }, null);
        expect(items).toEqual([{ id: 'a1', name: 'Studio Nova', slug: 'studio-nova', avatarUrl: null, followedAt: '2026-11-20T10:00:00.000Z' }]);
    });

    it('404s the lists of an unknown collector', async () => {
        await expect(build({ userExists: false }).service.listFollowers('u9', { page: 1, limit: 20 }, null)).rejects.toMatchObject({ statusCode: 404 });
    });
});

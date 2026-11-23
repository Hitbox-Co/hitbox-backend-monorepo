import { z } from 'zod';
import { FOLLOW_DEFAULT_PAGE_SIZE, FOLLOW_MAX_PAGE_SIZE } from '../constants/social.constant';

export const userIdParamSchema = z.object({ userId: z.string().uuid() });
export const artistIdParamSchema = z.object({ artistId: z.string().uuid() });

export const followListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(FOLLOW_MAX_PAGE_SIZE).default(FOLLOW_DEFAULT_PAGE_SIZE),
});

export const followingQuerySchema = followListQuerySchema.extend({
    /** Collectors (default) or artists. */
    type: z.enum(['users', 'artists']).default('users'),
});

export type FollowListQueryDto = z.infer<typeof followListQuerySchema>;
export type FollowingQueryDto = z.infer<typeof followingQuerySchema>;

/** A collector in a followers / following list. */
export interface FollowUserView {
    id: string;
    handle: string | null;
    fullName: string | null;
    avatarUrl: string | null;
    /** Their profile is PRIVATE: name and stats only, no collection. */
    isPrivate: boolean;
    followedAt: string;
    /** Whether the viewer follows this collector; null for guests or yourself. */
    isFollowedByYou: boolean | null;
}

/** An artist in a following list. */
export interface FollowArtistView {
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
    followedAt: string;
}

/** What follow / unfollow return: the new state and the target's follower count. */
export interface FollowResult {
    following: boolean;
    followerCount: number;
}

export interface FollowCounts {
    /** Collectors following this user. */
    followers: number;
    /** Collectors this user follows. */
    following: number;
    /** Artists this user follows. */
    followingArtists: number;
}

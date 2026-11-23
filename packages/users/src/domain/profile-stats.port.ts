/**
 * The numbers on a profile. Owned by other modules — claimed items and
 * collection progress by collections, follow counts by social — and composed
 * at bootstrap, so this module depends on neither.
 */
export interface ProfileStats {
    /** Items the user has claimed (their whole shelf, whatever each item's visibility). */
    claimedItems: number;
    /** Artist collections the user has at least one item from. */
    artistCollections: number;
    collectionProgress: { owned: number; total: number; percentage: number };
    /** Collectors following this user. */
    followers: number;
    /** Collectors this user follows. */
    following: number;
    /** Artists this user follows. */
    followingArtists: number;
}

export interface IProfileStats {
    getStats(userId: string): Promise<ProfileStats>;
    /** Whether `viewerId` follows `userId`. */
    isFollowing(viewerId: string, userId: string): Promise<boolean>;
}

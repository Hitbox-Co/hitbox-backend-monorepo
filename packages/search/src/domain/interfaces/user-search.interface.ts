/** One collector in the search results. Same identity fields as a follow-list row. */
export interface SearchUserItem {
    id: string;
    handle: string | null;
    fullName: string | null;
    avatarUrl: string | null;
    /** Private profiles are findable (name + stats only), never their items. */
    isPrivate: boolean;
}

export interface UserSearchQuery {
    /** Already trimmed, leading "@" removed. */
    text: string;
    skip: number;
    take: number;
    /** The signed-in account, left out of the results. Absent for guests. */
    excludeUserId?: string | undefined;
}

export interface UserSearchResult {
    items: SearchUserItem[];
    total: number;
}

/**
 * Port implemented by the users module and injected at bootstrap (same
 * pattern as discover's IProductDiscovery ← products).
 */
export interface IUserSearch {
    /** Active collectors whose handle or full name contains the text. */
    findUsers(query: UserSearchQuery): Promise<UserSearchResult>;
}

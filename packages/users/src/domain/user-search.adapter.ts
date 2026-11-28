import { Visibility } from '@hitbox/database';
import type { IUserSearch, UserSearchQuery, UserSearchResult } from '@hitbox/search';
import type { UserRepository } from '../repository/user.repository';

/**
 * Users-side implementation of search's IUserSearch port — same pattern as
 * the account-lookup adapter that implements auth's port.
 */
export class UserSearchAdapter implements IUserSearch {
    constructor(private readonly users: UserRepository) { }

    async findUsers(query: UserSearchQuery): Promise<UserSearchResult> {
        const { items, total } = await this.users.searchByText({
            text: query.text,
            skip: query.skip,
            take: query.take,
            excludeUserId: query.excludeUserId,
        });
        return {
            items: items.map((row) => ({
                id: row.id,
                handle: row.handle,
                fullName: row.fullName,
                avatarUrl: row.avatarUrl,
                isPrivate: row.profileVisibility === Visibility.PRIVATE,
            })),
            total,
        };
    }
}

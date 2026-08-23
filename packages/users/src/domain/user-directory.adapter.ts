import type { UserRepository } from '../repository/user.repository';

export interface DirectoryUser {
    id: string;
    email: string;
    deleted: boolean;
}

/**
 * Users-side implementation of the authorization module's `IUserDirectory`
 * port (packages/authz/src/domain/interfaces/user-directory.interface.ts).
 *
 * The port type is intentionally NOT imported here: authz already depends on
 * this package for its event contract, so importing back would create a package
 * cycle. TypeScript is structural, so compatibility is still checked — at the
 * composition root, where this instance is handed to createAuthzModule.
 */
export class UserDirectory {
    constructor(private readonly users: UserRepository) { }

    async findById(userId: string): Promise<DirectoryUser | null> {
        const user = await this.users.findById(userId);
        if (!user) return null;
        return { id: user.id, email: user.email, deleted: user.deletedAt !== null };
    }

    async findByEmail(email: string): Promise<DirectoryUser | null> {
        const user = await this.users.findByEmail(email);
        if (!user) return null;
        return { id: user.id, email: user.email, deleted: user.deletedAt !== null };
    }
}

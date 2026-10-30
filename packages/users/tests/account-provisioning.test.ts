import { UserAccountLookup } from '../src/domain/account-lookup.adapter';

/** The users-side half of "create the account at sign-in". */

const PAYLOAD = {
    clerkUserId: 'user_9',
    email: 'new@example.com',
    emailVerified: true,
    username: null,
    firstName: null,
    lastName: null,
    avatarUrl: null,
};

function repo(rows: Record<string, unknown>) {
    return {
        findByClerkId: jest.fn(async (id: string) => rows[id] ?? null),
        existsByEmail: jest.fn(),
    } as never;
}

describe('UserAccountLookup.provisionFromClerk', () => {
    it('runs the webhook projection, then returns the row it created', async () => {
        const rows: Record<string, unknown> = {};
        const sync = {
            syncFromClerk: jest.fn(async () => {
                rows.user_9 = { id: 'u-9', email: 'new@example.com', role: 'USER', isActive: true, archivedAt: null };
            }),
        };

        const snapshot = await new UserAccountLookup(repo(rows), sync).provisionFromClerk(PAYLOAD);

        expect(sync.syncFromClerk).toHaveBeenCalledWith(PAYLOAD);
        expect(snapshot).toMatchObject({ id: 'u-9', email: 'new@example.com', status: 'ACTIVE' });
    });

    it('creates nothing when it was built without a projection', async () => {
        expect(await new UserAccountLookup(repo({})).provisionFromClerk(PAYLOAD)).toBeNull();
    });

    it('still just looks accounts up', async () => {
        const lookup = new UserAccountLookup(
            repo({ user_1: { id: 'u-1', email: 'a@example.com', role: 'USER', isActive: false, archivedAt: null } }),
        );
        expect(await lookup.findByClerkUserId('user_1')).toMatchObject({ status: 'SUSPENDED' });
        expect(await lookup.findByClerkUserId('nobody')).toBeNull();
    });
});

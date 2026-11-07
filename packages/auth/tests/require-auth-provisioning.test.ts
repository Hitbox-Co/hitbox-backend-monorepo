import type { Request } from 'express';

// Clerk is mocked: JWT verification, and the lookup of the Clerk user itself.
const mockVerifyToken = jest.fn();
const mockGetUser = jest.fn();
jest.mock('@clerk/backend', () => ({
    verifyToken: mockVerifyToken,
    createClerkClient: jest.fn(() => ({ users: { getUser: mockGetUser } })),
}));

import { createRequireAuth } from '../src/middleware/require-auth.middleware';
import { AccountStatus } from '../src/domain/enums/account-status.enum';
import { UserRole } from '../src/domain/enums/user-role.enum';
import type { AccountSnapshot, IAccountLookup } from '../src/domain/interfaces/account-lookup.interface';

/**
 * A new user whose sign-up webhook never reached this server: Clerk knows them,
 * the local users table does not. Without help they are refused on every
 * request with AUTH_ACCOUNT_NOT_FOUND, forever. With it, their first request
 * creates the account (the webhook's own path) and goes through.
 */

const EXISTING: AccountSnapshot = {
    id: 'acc_1',
    email: 'buyer@example.com',
    role: UserRole.USER,
    status: AccountStatus.ACTIVE,
    emailVerified: true,
};

const CLERK_USER = {
    id: 'user_1',
    primaryEmailAddressId: 'idn_1',
    emailAddresses: [{ id: 'idn_1', emailAddress: 'second@example.com', verification: { status: 'verified' } }],
    username: 'second',
    firstName: 'Sec',
    lastName: 'Ond',
    imageUrl: 'https://img.example/a.png',
};

type Middleware = (req: Request, res: unknown, next: jest.Mock) => Promise<void>;
const withToken = { headers: { authorization: 'Bearer good.token' } };

/** An account lookup with no row until `provisionFromClerk` creates one. */
function lookupThatProvisions() {
    let row: AccountSnapshot | null = null;
    const accounts: IAccountLookup = {
        findByClerkUserId: jest.fn(async () => row),
        emailExists: jest.fn(),
        provisionFromClerk: jest.fn(async () => {
            row = { ...EXISTING, id: 'acc_new', email: 'second@example.com' };
            return row;
        }),
    };
    return accounts;
}

function build(accounts: IAccountLookup) {
    const mw = createRequireAuth({ accounts, clerkSecretKey: 'sk_test_dummy' }) as unknown as Middleware;
    return async () => {
        const next = jest.fn();
        const req = { headers: withToken.headers, header: () => undefined } as unknown as Request;
        await mw(req, {}, next);
        return { next, req };
    };
}

beforeEach(() => {
    mockGetUser.mockReset();
    mockVerifyToken.mockReset();
    mockVerifyToken.mockResolvedValue({ sub: 'user_1', sid: 'sess_1' });
});

describe('requireAuth provisions a missing account', () => {
    it('creates it from Clerk and lets the request through', async () => {
        mockGetUser.mockResolvedValue(CLERK_USER);
        const accounts = lookupThatProvisions();

        const { next, req } = await build(accounts)();

        expect(next).toHaveBeenCalledWith();
        expect(req.auth).toMatchObject({ accountId: 'acc_new', clerkUserId: 'user_1' });
        expect(accounts.provisionFromClerk).toHaveBeenCalledWith({
            clerkUserId: 'user_1',
            email: 'second@example.com',
            emailVerified: true,
            username: 'second',
            firstName: 'Sec',
            lastName: 'Ond',
            avatarUrl: 'https://img.example/a.png',
        });
    });

    it('does nothing when the account already exists', async () => {
        const accounts = lookupThatProvisions();
        (accounts.findByClerkUserId as jest.Mock).mockResolvedValue(EXISTING);

        await build(accounts)();

        expect(mockGetUser).not.toHaveBeenCalled();
        expect(accounts.provisionFromClerk).not.toHaveBeenCalled();
    });

    it('never revives a soft-deleted account', async () => {
        const accounts = lookupThatProvisions();
        (accounts.findByClerkUserId as jest.Mock).mockResolvedValue({ ...EXISTING, status: AccountStatus.DELETED });

        const { next } = await build(accounts)();

        expect(accounts.provisionFromClerk).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });
});

describe('requireAuth does NOT provision when it must not', () => {
    it('for a token that did not verify', async () => {
        mockVerifyToken.mockRejectedValue(new Error('expired'));
        const accounts = lookupThatProvisions();

        const { next } = await build(accounts)();

        expect(mockGetUser).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0]).toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
    });

    it('for a user whose primary email is not verified — the webhook skips those too', async () => {
        mockGetUser.mockResolvedValue({
            ...CLERK_USER,
            emailAddresses: [{ id: 'idn_1', emailAddress: 'x@example.com', verification: { status: 'unverified' } }],
        });
        const accounts = lookupThatProvisions();

        const { next } = await build(accounts)();

        expect(accounts.provisionFromClerk).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });

    it('for a phone-only user with no email', async () => {
        mockGetUser.mockResolvedValue({ id: 'user_1', emailAddresses: [] });

        const { next } = await build(lookupThatProvisions())();

        expect(next.mock.calls[0][0]).toMatchObject({ code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });

    it('when the lookup has no way to provision', async () => {
        const accounts: IAccountLookup = { findByClerkUserId: jest.fn(async () => null), emailExists: jest.fn() };

        const { next } = await build(accounts)();

        expect(mockGetUser).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0]).toMatchObject({ code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });
});

describe('requireAuth stays calm when provisioning fails', () => {
    it('is still a 401, not a 500, when Clerk cannot be reached', async () => {
        mockGetUser.mockRejectedValue(new Error('clerk down'));

        const { next } = await build(lookupThatProvisions())();

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });

    it('does not call Clerk again for the same user straight after a failure', async () => {
        mockGetUser.mockRejectedValue(new Error('clerk down'));
        const call = build(lookupThatProvisions());

        await call();
        await call();

        expect(mockGetUser).toHaveBeenCalledTimes(1);
    });

    it('shares one attempt between simultaneous requests for the same new user', async () => {
        mockGetUser.mockResolvedValue(CLERK_USER);
        const accounts = lookupThatProvisions();
        const call = build(accounts);

        await Promise.all([call(), call(), call()]);

        expect(mockGetUser).toHaveBeenCalledTimes(1);
        expect(accounts.provisionFromClerk).toHaveBeenCalledTimes(1);
    });
});

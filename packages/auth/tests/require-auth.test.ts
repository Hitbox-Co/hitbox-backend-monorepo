import type { Request } from 'express';

// Clerk JWT verification is mocked — we test the middleware's decisions.
const mockVerifyToken = jest.fn();
jest.mock('@clerk/backend', () => ({ verifyToken: mockVerifyToken }));

import { createRequireAuth } from '../src/middleware/require-auth.middleware';
import { AccountStatus } from '../src/domain/enums/account-status.enum';
import { UserRole } from '../src/domain/enums/user-role.enum';
import type { AccountSnapshot, IAccountLookup } from '../src/domain/interfaces/account-lookup.interface';

const ACTIVE: AccountSnapshot = {
    id: 'acc_1',
    email: 'buyer@example.com',
    role: UserRole.USER,
    status: AccountStatus.ACTIVE,
    emailVerified: true,
};

function makeAccounts(snapshot: AccountSnapshot | null): IAccountLookup {
    return {
        findByClerkUserId: jest.fn().mockResolvedValue(snapshot),
        emailExists: jest.fn(),
    };
}

type Middleware = (req: Request, res: unknown, next: jest.Mock) => Promise<void>;

async function run(accounts: IAccountLookup, req: Partial<Request>) {
    const mw = createRequireAuth({ accounts }) as unknown as Middleware;
    const next = jest.fn();
    const req2 = { headers: {}, header: () => undefined, ...req } as unknown as Request;
    await mw(req2, {}, next);
    return { next, req: req2 };
}

const withToken = { headers: { authorization: 'Bearer good.token' } };

beforeEach(() => {
    mockVerifyToken.mockReset();
    mockVerifyToken.mockResolvedValue({ sub: 'user_1', sid: 'sess_1' });
});

describe('requireAuth', () => {
    it('401 AUTH_UNAUTHENTICATED when no token is present', async () => {
        const { next } = await run(makeAccounts(ACTIVE), { headers: {} });
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_UNAUTHENTICATED' });
    });

    it('401 AUTH_INVALID_TOKEN when Clerk rejects the token', async () => {
        mockVerifyToken.mockRejectedValue(new Error('expired'));
        const { next } = await run(makeAccounts(ACTIVE), withToken);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_TOKEN' });
    });

    it('401 AUTH_ACCOUNT_NOT_FOUND when there is no local account', async () => {
        const { next } = await run(makeAccounts(null), withToken);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });

    it('401 AUTH_ACCOUNT_NOT_FOUND for a soft-deleted account', async () => {
        const { next } = await run(makeAccounts({ ...ACTIVE, status: AccountStatus.DELETED }), withToken);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'AUTH_ACCOUNT_NOT_FOUND' });
    });

    it('403 AUTH_ACCOUNT_SUSPENDED for a suspended account', async () => {
        const { next } = await run(makeAccounts({ ...ACTIVE, status: AccountStatus.SUSPENDED }), withToken);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 'AUTH_ACCOUNT_SUSPENDED' });
    });

    it('403 AUTH_EMAIL_UNVERIFIED when the synced email is not verified', async () => {
        const { next } = await run(makeAccounts({ ...ACTIVE, emailVerified: false }), withToken);
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 'AUTH_EMAIL_UNVERIFIED' });
    });

    it('passes for an active, verified account and attaches req.auth', async () => {
        const { next, req } = await run(makeAccounts(ACTIVE), withToken);
        expect(next).toHaveBeenCalledWith(); // called with no error
        expect(req.auth).toMatchObject({ accountId: 'acc_1', clerkUserId: 'user_1', role: UserRole.USER });
    });
});

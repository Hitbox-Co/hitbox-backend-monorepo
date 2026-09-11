import { AccountStatus } from '@hitbox/auth';
import { Prisma, Visibility } from '@hitbox/database';
import type { User } from '@hitbox/database';
import { UserAccountLookup } from '../src/domain/account-lookup.adapter';
import { toMe, toPublicUser, updateProfileSchema } from '../src/dto/user.dto';
import { UserService } from '../src/service/user.service';
import { USERS_ERROR_CODES } from '../src/constants/users.constant';

/**
 * The users module's job is translation: Clerk's vocabulary on one side, this
 * schema's columns on the other. These tests pin the mapping decisions the
 * schema decomposition forced — the renames, the lost column, and the two
 * lifecycle flags that replaced a three-state enum.
 */

const logger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} as unknown as Parameters<typeof UserService.prototype.constructor>[0]['logger'];

function row(overrides: Partial<User> = {}): User {
    return {
        id: '05acd508-fe94-4bc1-83f7-6a544583047b',
        clerkId: 'user_demo_system_admin',
        email: 'admin@hitbox.demo',
        phone: '+15550000000',
        handle: 'admin',
        fullName: 'Ayan Saha',
        bio: null,
        avatarUrl: null,
        role: 'USER',
        profileVisibility: Visibility.PRIVATE,
        generalLocation: 'Remote',
        preferredMarketId: null,
        isActive: true,
        deactivatedAt: null,
        archivedAt: null,
        createdAt: new Date('2026-06-03T12:00:00Z'),
        updatedAt: new Date('2026-09-01T12:00:00Z'),
        ...overrides,
    } as User;
}

function makeRepo(user: User | null) {
    return {
        findById: jest.fn().mockResolvedValue(user),
        findByClerkId: jest.fn().mockResolvedValue(user),
        existsByEmail: jest.fn().mockResolvedValue(user !== null),
        upsertFromClerk: jest.fn().mockResolvedValue(user ?? row()),
        softDeleteByClerkId: jest.fn().mockResolvedValue(undefined),
        updateProfile: jest.fn().mockResolvedValue(user ?? row()),
    };
}

beforeEach(() => jest.clearAllMocks());

// ────────────────────────────────────────────────────────────────────────────

describe('account status derivation', () => {
    it('reports an ordinary row as ACTIVE', async () => {
        const lookup = new UserAccountLookup(makeRepo(row()) as never);
        expect((await lookup.findByClerkUserId('x'))?.status).toBe(AccountStatus.ACTIVE);
    });

    it('reports a deactivated row as SUSPENDED', async () => {
        // The schema no longer separates "suspended by staff" from
        // "deactivated by the user" — both are isActive=false, and both fail
        // closed rather than being admitted.
        const lookup = new UserAccountLookup(
            makeRepo(row({ isActive: false, deactivatedAt: new Date() })) as never,
        );
        expect((await lookup.findByClerkUserId('x'))?.status).toBe(AccountStatus.SUSPENDED);
    });

    it('reports an archived row as DELETED', async () => {
        const lookup = new UserAccountLookup(
            makeRepo(row({ archivedAt: new Date(), isActive: false })) as never,
        );
        expect((await lookup.findByClerkUserId('x'))?.status).toBe(AccountStatus.DELETED);
    });

    it('lets archived win over merely inactive', async () => {
        const lookup = new UserAccountLookup(
            makeRepo(row({ archivedAt: new Date(), isActive: true })) as never,
        );
        expect((await lookup.findByClerkUserId('x'))?.status).toBe(AccountStatus.DELETED);
    });

    it('returns null for an unknown Clerk subject', async () => {
        const lookup = new UserAccountLookup(makeRepo(null) as never);
        expect(await lookup.findByClerkUserId('nope')).toBeNull();
    });

    it('reports emailVerified as true — the column no longer exists', async () => {
        // Documenting a known gap rather than asserting correct behaviour:
        // `User.emailVerified` was dropped in the schema decomposition, so
        // requireAuth's defence-in-depth check can no longer fail. Clerk does
        // not mint a session before verification, which was always the real
        // gate. Restoring the column would make this test meaningful again.
        const lookup = new UserAccountLookup(makeRepo(row()) as never);
        expect((await lookup.findByClerkUserId('x'))?.emailVerified).toBe(true);
    });
});

describe('profile DTOs', () => {
    it('exposes only display fields publicly', () => {
        const publicDto = toPublicUser(row({ bio: 'hi' }));
        expect(Object.keys(publicDto).sort()).toEqual([
            'avatarUrl', 'bio', 'createdAt', 'fullName', 'handle', 'id',
        ]);
        // Coarse location is staff-only, and masked even then.
        expect(publicDto).not.toHaveProperty('generalLocation');
        expect(publicDto).not.toHaveProperty('email');
        expect(publicDto).not.toHaveProperty('phone');
    });

    it('gives the user their own contact and preference fields', () => {
        const me = toMe(row());
        expect(me.email).toBe('admin@hitbox.demo');
        expect(me.phone).toBe('+15550000000');
        expect(me.generalLocation).toBe('Remote');
        expect(me.profileVisibility).toBe(Visibility.PRIVATE);
    });

    it('no longer carries the columns the schema dropped', () => {
        const me = toMe(row()) as Record<string, unknown>;
        for (const gone of ['username', 'firstName', 'lastName', 'rewardPoints', 'state']) {
            expect(me).not.toHaveProperty(gone);
        }
    });
});

describe('updateProfileSchema', () => {
    it('accepts the editable columns', () => {
        const result = updateProfileSchema.safeParse({
            handle: 'ayan_s', fullName: 'Ayan Saha', bio: 'Collector.',
            phone: '+15550001111', generalLocation: 'Kolkata',
            profileVisibility: Visibility.PUBLIC,
        });
        expect(result.success).toBe(true);
    });

    it('rejects a foreign key the client should not be able to set', () => {
        // preferredMarketId would only fail at the database; keeping it out
        // means an invalid market never reaches Prisma in the first place.
        expect(
            updateProfileSchema.safeParse({ preferredMarketId: crypto.randomUUID() }).success,
        ).toBe(false);
    });

    it('rejects the removed field names', () => {
        for (const gone of [{ username: 'x' }, { firstName: 'x' }, { lastName: 'x' }]) {
            expect(updateProfileSchema.safeParse(gone).success).toBe(false);
        }
    });

    it('rejects a malformed handle', () => {
        expect(updateProfileSchema.safeParse({ handle: 'has spaces' }).success).toBe(false);
        expect(updateProfileSchema.safeParse({ handle: 'ab' }).success).toBe(false);
    });
});

describe('visibility on the public endpoint', () => {
    it('returns a PUBLIC profile', async () => {
        const service = new UserService({
            users: makeRepo(row({ profileVisibility: Visibility.PUBLIC })) as never,
            logger,
        });
        expect((await service.getPublicById('id')).handle).toBe('admin');
    });

    it('404s a PRIVATE profile rather than 403', async () => {
        // 403 would confirm the id exists, which is enough to enumerate users
        // on an unauthenticated route.
        const service = new UserService({
            users: makeRepo(row({ profileVisibility: Visibility.PRIVATE })) as never,
            logger,
        });
        await expect(service.getPublicById('id')).rejects.toMatchObject({
            statusCode: 404,
            code: USERS_ERROR_CODES.USER_NOT_FOUND,
        });
    });

    it('404s an archived profile', async () => {
        const service = new UserService({
            users: makeRepo(
                row({ profileVisibility: Visibility.PUBLIC, archivedAt: new Date() }),
            ) as never,
            logger,
        });
        await expect(service.getPublicById('id')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('404s an archived row on getMe too', async () => {
        const service = new UserService({
            users: makeRepo(row({ archivedAt: new Date() })) as never,
            logger,
        });
        await expect(service.getMe('id')).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('unique-constraint reporting', () => {
    function serviceRejecting(target: string[]) {
        const repo = makeRepo(row());
        repo.updateProfile.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('unique', {
                code: 'P2002', clientVersion: 'test', meta: { target },
            }),
        );
        return new UserService({ users: repo as never, logger });
    }

    it('names the handle when the handle collided', async () => {
        await expect(
            serviceRejecting(['handle']).updateProfile('id', { handle: 'taken' }),
        ).rejects.toMatchObject({ statusCode: 409, code: USERS_ERROR_CODES.HANDLE_TAKEN });
    });

    it('names the email when the email collided', async () => {
        // The old code blamed the username for every P2002, which sent a user
        // hunting for a name clash that was not there.
        await expect(
            serviceRejecting(['email']).updateProfile('id', { handle: 'fine' }),
        ).rejects.toMatchObject({ statusCode: 409, code: USERS_ERROR_CODES.EMAIL_TAKEN });
    });
});

describe('Clerk event handling', () => {
    it('soft-deletes by Clerk id on user.deleted', async () => {
        const repo = makeRepo(row());
        const service = new UserService({ users: repo as never, logger });
        await service.markDeleted({ clerkUserId: 'user_x' });
        expect(repo.softDeleteByClerkId).toHaveBeenCalledWith('user_x');
    });

    it('passes the Clerk payload straight to the repository to translate', async () => {
        const repo = makeRepo(row());
        const service = new UserService({ users: repo as never, logger });
        const payload = {
            clerkUserId: 'user_x', email: 'a@b.demo', emailVerified: true,
            username: 'handle_x', firstName: 'A', lastName: 'B', avatarUrl: null,
        };
        await service.syncFromClerk(payload);
        // The service does not reshape it — the repository owns the mapping.
        expect(repo.upsertFromClerk).toHaveBeenCalledWith(payload);
    });
});

import { findRoleDefinition } from '@hitbox/access-control';
import {
    nameFromEmail,
    roleImpliesArtistProfile,
    slugify,
} from '../src/profile/domain/artist-role';
import { ArtistProvisioningService } from '../src/profile/service/artist-provisioning.service';
import type { StaffInvitedEvent } from '../src/profile/service/artist-provisioning.service';
import type { ArtistRepository, ArtistRow } from '../src/profile/repository/artist.repository';

/** Permission keys the seeded role actually carries. */
function permissionsOf(roleName: string): string[] {
    const role = findRoleDefinition(roleName);
    if (!role) throw new Error(`Unknown role ${roleName}`);
    return [...role.permissions];
}

describe('roleImpliesArtistProfile — read from the seeded catalog', () => {
    it('is true for ARTIST', () => {
        expect(roleImpliesArtistProfile(permissionsOf('ARTIST'))).toBe(true);
    });

    it.each([
        'BRAND_ADMIN',
        'BRAND_EMPLOYEE',
        'HITBOX_SYSTEM_ADMIN',
        'HITBOX_DROP_MANAGER',
        'HITBOX_SUPPORT',
        'BUYER_COLLECTOR',
        'HITBOX_PLATFORM_ENGINEER',
    ])('is false for %s', (roleName) => {
        expect(roleImpliesArtistProfile(permissionsOf(roleName))).toBe(false);
    });

    it('separates managing artist records from being one', () => {
        // The distinction the whole rule rests on: a Brand Admin administers
        // artist records at :organization; an artist owns theirs at :own.
        expect(permissionsOf('BRAND_ADMIN')).toContain('brand-artist-record:read:organization');
        expect(permissionsOf('ARTIST')).toContain('brand-artist-record:read:own');
        expect(roleImpliesArtistProfile(['brand-artist-record:read:organization'])).toBe(false);
        expect(roleImpliesArtistProfile(['brand-artist-record:read:own'])).toBe(true);
    });

    it('would accept a future role nobody has named yet', () => {
        // The reason this reads capabilities rather than `roleName === 'ARTIST'`.
        expect(roleImpliesArtistProfile(['brand-artist-record:update:own'])).toBe(true);
    });
});

describe('nameFromEmail', () => {
    it.each([
        ['jane.doe@label.com', 'Jane Doe'],
        ['kaze@studio.io', 'Kaze'],
        ['mary-jane_smith@x.com', 'Mary Jane Smith'],
        ['artist99@x.com', 'Artist'],
    ])('%s -> %s', (email, expected) => {
        expect(nameFromEmail(email)).toBe(expected);
    });

    it('falls back to the address when there is nothing to humanise', () => {
        expect(nameFromEmail('123@x.com')).toBe('123@x.com');
    });
});

describe('slugify', () => {
    it.each([
        ['Kaze', 'kaze'],
        ['Lumen Studios', 'lumen-studios'],
        ['  Béla Kiss  ', 'bela-kiss'],
        ['!!!', 'artist'],
    ])('%s -> %s', (name, expected) => {
        expect(slugify(name)).toBe(expected);
    });
});

// ── Provisioning ────────────────────────────────────────────────────────────

const ARTIST_PERMISSIONS = permissionsOf('ARTIST');

function row(overrides: Partial<ArtistRow> = {}): ArtistRow {
    return {
        id: 'artist-1',
        name: 'Kaze',
        slug: 'kaze',
        genre: null,
        avatarUrl: null,
        isPublic: false,
        isActive: true,
        archivedAt: null,
        invitationId: 'inv-1',
        organizationId: null,
        organization: null,
        _count: { products: 0, artistCollections: 0 },
        ...overrides,
    } as ArtistRow;
}

function fakeRepo(overrides: Partial<ArtistRepository> = {}) {
    return {
        findByInvitationId: jest.fn().mockResolvedValue(null),
        findByUserId: jest.fn().mockResolvedValue(null),
        createFromInvitation: jest.fn().mockImplementation(async (input) =>
            row({ name: input.name, genre: input.genre, invitationId: input.invitationId }),
        ),
        linkUser: jest.fn().mockImplementation(async (id, userId) => row({ id, ...{ userId } })),
        ...overrides,
    } as unknown as ArtistRepository & Record<string, jest.Mock>;
}

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
} as never;

const invited = (extra: Partial<StaffInvitedEvent> = {}): StaffInvitedEvent => ({
    invitationId: 'inv-1',
    email: 'jane.doe@label.com',
    roleId: 'role-1',
    roleName: 'ARTIST',
    rolePermissions: ARTIST_PERMISSIONS,
    organizationId: 'org-9',
    ...extra,
});

describe('ArtistProvisioningService.onStaffInvited', () => {
    it('creates the profile when an artist is invited', async () => {
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onStaffInvited(invited({ artistName: 'Kaze', artistGenre: 'street' }));

        expect(artists.createFromInvitation).toHaveBeenCalledWith({
            invitationId: 'inv-1',
            name: 'Kaze',
            genre: 'street',
            organizationId: 'org-9',
            userId: null,
        });
    });

    it('creates nothing for a role that is not an artist role', async () => {
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        const result = await service.onStaffInvited(
            invited({ roleName: 'BRAND_ADMIN', rolePermissions: permissionsOf('BRAND_ADMIN') }),
        );

        expect(result).toBeNull();
        expect(artists.createFromInvitation).not.toHaveBeenCalled();
    });

    it('derives a name from the email when the inviter did not supply one', async () => {
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onStaffInvited(invited());

        expect(artists.createFromInvitation).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Jane Doe' }),
        );
    });

    it('is idempotent — a redelivered event creates nothing', async () => {
        // The in-process bus has no delivery guarantees and ROLE_ASSIGNED is
        // already published twice on one path, so this is not hypothetical.
        const existing = row();
        const artists = fakeRepo({
            findByInvitationId: jest.fn().mockResolvedValue(existing),
        } as never);
        const service = new ArtistProvisioningService({ artists, logger });

        const result = await service.onStaffInvited(invited());

        expect(result).toBe(existing);
        expect(artists.createFromInvitation).not.toHaveBeenCalled();
    });

    it('adopts an existing profile rather than splitting one person in two', async () => {
        // Re-invited after an expiry, or granted a second artist role. One
        // person is one artist; a duplicate would split their drops.
        const existing = row({ id: 'artist-existing' });
        const artists = fakeRepo({
            findByUserId: jest.fn().mockResolvedValue(existing),
        } as never);
        const service = new ArtistProvisioningService({ artists, logger });

        const result = await service.onStaffInvited(invited({ userId: 'user-7' }));

        expect(result).toBe(existing);
        expect(artists.createFromInvitation).not.toHaveBeenCalled();
    });

    it('links immediately when the invited address already had an account', async () => {
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onStaffInvited(invited({ userId: 'user-7' }));

        expect(artists.createFromInvitation).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-7' }),
        );
    });
});

describe('ArtistProvisioningService.onInvitationAccepted', () => {
    it('links the profile to the account that accepted', async () => {
        const artists = fakeRepo({
            findByInvitationId: jest.fn().mockResolvedValue(row({ id: 'artist-1' })),
        } as never);
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onInvitationAccepted({
            invitationId: 'inv-1',
            email: 'jane.doe@label.com',
            userId: 'user-7',
            rolePermissions: ARTIST_PERMISSIONS,
        });

        expect(artists.linkUser).toHaveBeenCalledWith('artist-1', 'user-7');
    });

    it('creates the profile late rather than leaving the artist without one', async () => {
        // Invitations that predate this feature, or an invite-time handler
        // that failed. Late is recoverable; absent is not.
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onInvitationAccepted({
            invitationId: 'inv-old',
            email: 'kaze@studio.io',
            userId: 'user-9',
            rolePermissions: ARTIST_PERMISSIONS,
        });

        expect(artists.createFromInvitation).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Kaze', userId: 'user-9' }),
        );
    });

    it('ignores acceptance of a non-artist invitation', async () => {
        const artists = fakeRepo();
        const service = new ArtistProvisioningService({ artists, logger });

        await service.onInvitationAccepted({
            invitationId: 'inv-2',
            email: 'ops@hitbox.com',
            userId: 'user-3',
            rolePermissions: permissionsOf('HITBOX_ORDER_MANAGER'),
        });

        expect(artists.linkUser).not.toHaveBeenCalled();
        expect(artists.createFromInvitation).not.toHaveBeenCalled();
    });
});

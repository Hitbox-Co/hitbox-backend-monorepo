import pino from 'pino';
import { resolveGenre } from '../src/self/constants/artist-self.constant';
import { updateMyProfileSchema } from '../src/self/dto/artist-self.dto';
import type { ArtistImageAssetRef, IArtistImageStorage } from '../src/self/domain/artist-image-storage.interface';
import type { ArtistSelfRepository, ArtistSelfRow } from '../src/self/repository/artist-self.repository';
import { ArtistSelfService } from '../src/self/service/artist-self.service';

/**
 * Artist self-service — docs/artist/artist-profile-api.md.
 * No database: the repository and image storage are in-memory fakes.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const ARTIST = '22222222-2222-2222-2222-222222222222';
const ASSET = '33333333-3333-3333-3333-333333333333';

function row(overrides: Partial<ArtistSelfRow> = {}): ArtistSelfRow {
    const now = new Date('2026-10-01T00:00:00Z');
    return {
        id: ARTIST,
        publicCode: 'art0abc',
        name: 'Kaze',
        slug: 'kaze',
        bio: null,
        genre: null,
        avatarUrl: null,
        coverUrl: null,
        isPublic: false,
        isActive: true,
        archivedAt: null,
        complianceAttestedAt: null,
        organizationId: null,
        organization: null,
        createdAt: now,
        updatedAt: now,
        _count: { drops: 0, artistCollections: 0, follows: 0 },
        ...overrides,
    } as ArtistSelfRow;
}

function setup(opts: {
    current?: ArtistSelfRow | null;
    takenSlugs?: string[];
    asset?: Partial<ArtistImageAssetRef> | null;
    images?: boolean;
} = {}) {
    let current = opts.current === undefined ? row() : opts.current;
    const updates: Record<string, unknown>[] = [];
    const artists = {
        findByUserId: async (userId: string) => (userId === USER ? current : null),
        slugTaken: async (slug: string) => (opts.takenSlugs ?? []).includes(slug),
        update: async (_id: string, data: Record<string, unknown>) => {
            updates.push(data);
            current = { ...current!, ...data } as ArtistSelfRow;
            return current;
        },
    } as unknown as ArtistSelfRepository;

    const asset: ArtistImageAssetRef | null =
        opts.asset === null
            ? null
            : {
                id: ASSET,
                assetType: 'PROFILE_IMAGE',
                mimeType: 'image/png',
                artistId: ARTIST,
                archived: false,
                virusScanStatus: 'SKIPPED',
                publicUrl: 'https://cdn.example/profile-images/artists/a/b.png',
                ...opts.asset,
            };
    const images: IArtistImageStorage = {
        createUpload: async (input) => ({
            assetId: ASSET,
            uploadUrl: `https://s3.example/put?artist=${input.artistId}`,
            expiresIn: 300,
            publicUrl: 'https://cdn.example/profile-images/x.png',
        }),
        findAsset: async () => asset,
    };

    const service = new ArtistSelfService({
        artists,
        images: opts.images === false ? undefined : images,
        logger: pino({ level: 'silent' }),
    });
    return { service, updates };
}

describe('resolveGenre', () => {
    it.each([
        ['hip-hop', 'Hip-Hop'],
        ['HIP_HOP', 'Hip-Hop'],
        ['Hip-Hop', 'Hip-Hop'],
        ['  r&b ', 'R&B'],
        ['k-pop', 'K-Pop'],
    ])('%s → %s', (input, expected) => {
        expect(resolveGenre(input)).toBe(expected);
    });

    it('rejects a genre not on the list', () => {
        expect(resolveGenre('Vaporwave')).toBeNull();
    });
});

describe('updateMyProfileSchema', () => {
    it('refuses fields an artist may not change, naming them', () => {
        const result = updateMyProfileSchema.safeParse({ name: 'K', organizationId: ARTIST });
        expect(result.success).toBe(false);
    });

    it.each(['isActive', 'userId', 'complianceAttestedAt', 'avatarUrl'])('refuses %s', (field) => {
        expect(updateMyProfileSchema.safeParse({ [field]: 'x' }).success).toBe(false);
    });

    it('lower-cases the slug and rejects bad formats', () => {
        expect(updateMyProfileSchema.parse({ slug: 'The-Club' }).slug).toBe('the-club');
        expect(updateMyProfileSchema.safeParse({ slug: 'the club' }).success).toBe(false);
        expect(updateMyProfileSchema.safeParse({ slug: '-x-' }).success).toBe(false);
    });

    it('"" clears the bio', () => {
        expect(updateMyProfileSchema.parse({ bio: '' }).bio).toBeNull();
    });

    it('refuses an empty body', () => {
        expect(updateMyProfileSchema.safeParse({}).success).toBe(false);
    });
});

describe('ArtistSelfService', () => {
    it('404s when the account has no artist profile', async () => {
        const { service } = setup({ current: null });
        await expect(service.get(USER)).rejects.toMatchObject({ code: 'ARTIST_PROFILE_NOT_FOUND' });
    });

    it('updates name, bio, genre (stored as the label) and visibility', async () => {
        const { service } = setup();
        const profile = await service.update(USER, {
            name: 'Kaze Official',
            bio: 'Tokyo-born producer.',
            genre: 'electronic',
            isPublic: true,
        });
        expect(profile).toMatchObject({
            name: 'Kaze Official',
            bio: 'Tokyo-born producer.',
            genre: 'Electronic',
            isPublic: true,
            editable: true,
        });
    });

    it('refuses an unknown genre', async () => {
        const { service } = setup();
        await expect(service.update(USER, { genre: 'Vaporwave' })).rejects.toMatchObject({
            code: 'ARTIST_GENRE_INVALID',
        });
    });

    it('null clears the genre', async () => {
        const { service } = setup({ current: row({ genre: 'Pop' }) });
        expect((await service.update(USER, { genre: null })).genre).toBeNull();
    });

    it('refuses a slug another artist has', async () => {
        const { service } = setup({ takenSlugs: ['taken'] });
        await expect(service.update(USER, { slug: 'taken' })).rejects.toMatchObject({ code: 'ARTIST_SLUG_TAKEN' });
    });

    it('refuses edits to an archived or deactivated profile', async () => {
        const archived = setup({ current: row({ archivedAt: new Date() }) });
        await expect(archived.service.update(USER, { name: 'X' })).rejects.toMatchObject({ code: 'ARTIST_PROFILE_LOCKED' });
        const inactive = setup({ current: row({ isActive: false }) });
        await expect(inactive.service.update(USER, { name: 'X' })).rejects.toMatchObject({ code: 'ARTIST_PROFILE_LOCKED' });
    });

    it('reading an archived profile still works', async () => {
        const { service } = setup({ current: row({ archivedAt: new Date() }) });
        expect((await service.get(USER)).editable).toBe(false);
    });

    describe('avatar & cover', () => {
        it('issues an upload ticket for the caller\'s own artist', async () => {
            const { service } = setup();
            const ticket = await service.createImageUpload(USER, 'avatar', {
                fileName: 'me.png',
                mimeType: 'image/png',
                sizeBytes: 1000,
            });
            expect(ticket).toMatchObject({ kind: 'avatar', assetId: ASSET });
            expect(ticket.uploadUrl).toContain(ARTIST);
        });

        it('sets the avatar URL from a valid uploaded asset', async () => {
            const { service } = setup();
            const profile = await service.setImage(USER, 'avatar', { assetId: ASSET });
            expect(profile.avatarUrl).toBe('https://cdn.example/profile-images/artists/a/b.png');
            expect(profile.coverUrl).toBeNull();
        });

        it('sets the cover independently', async () => {
            const { service } = setup();
            const profile = await service.setImage(USER, 'cover', { assetId: ASSET });
            expect(profile.coverUrl).toBe('https://cdn.example/profile-images/artists/a/b.png');
            expect(profile.avatarUrl).toBeNull();
        });

        it.each([
            ['missing', null],
            ['another artist\'s', { artistId: '99999999-9999-9999-9999-999999999999' }],
            ['not a profile image', { assetType: 'DROP_IMAGE' }],
            ['archived', { archived: true }],
            ['infected', { virusScanStatus: 'INFECTED' }],
            ['still scanning', { virusScanStatus: 'PENDING' }],
            ['not public', { publicUrl: null }],
        ])('refuses an asset that is %s', async (_label, asset) => {
            const { service, updates } = setup({ asset: asset as Partial<ArtistImageAssetRef> | null });
            await expect(service.setImage(USER, 'avatar', { assetId: ASSET })).rejects.toMatchObject({
                code: 'ARTIST_IMAGE_INVALID',
            });
            expect(updates).toHaveLength(0);
        });

        it('removes an image', async () => {
            const { service } = setup({ current: row({ coverUrl: 'https://cdn.example/c.png' }) });
            expect((await service.removeImage(USER, 'cover')).coverUrl).toBeNull();
        });

        it('answers clearly when no bucket is configured', async () => {
            const { service } = setup({ images: false });
            await expect(
                service.createImageUpload(USER, 'avatar', { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1 }),
            ).rejects.toMatchObject({ code: 'ARTIST_IMAGES_UNAVAILABLE', statusCode: 400 });
        });
    });
});

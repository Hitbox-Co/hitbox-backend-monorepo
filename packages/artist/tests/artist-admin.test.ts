import pino from 'pino';
import { AppError } from '@hitbox/shared';
import {
    ARTIST_ADMIN_AUDIT_EVENTS,
    ARTIST_ADMIN_ERROR_CODES,
    ARTIST_ADMIN_EVENTS,
} from '../src/admin/constants/artist-admin.constant';
import type { ArtistAccountStatus, IArtistInsights } from '../src/admin/domain/artist-insights.port';
import {
    artistStateActionSchema,
    artistStatsQuerySchema,
    staffUpdateArtistSchema,
} from '../src/admin/dto/artist-admin.dto';
import type {
    ArtistAdminRepository,
    ArtistStaffChanges,
    ArtistStateGuard,
    StaffArtistRow,
} from '../src/admin/repository/artist-admin.repository';
import { ArtistAdminService } from '../src/admin/service/artist-admin.service';
import { listArtistsQuerySchema } from '../src/profile/dto/artist.dto';

/**
 * HitBox staff administering artists — docs/artist/artist-admin-api.md.
 * The repository is an in-memory fake; the reporting adapter is a stub that
 * records whether money was asked for.
 */

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'a2222222-2222-4222-8222-222222222222';
const STAFF = '55555555-5555-4555-8555-555555555555';
const ORG = '33333333-3333-4333-8333-333333333333';
const ACTOR = { userId: STAFF, roleName: 'HITBOX_SYSTEM_ADMIN' };
const MONEY = { canSeeMoney: true };
const NO_MONEY = { canSeeMoney: false };

function row(over: Partial<StaffArtistRow> = {}): StaffArtistRow {
    const at = new Date('2026-01-01T00:00:00Z');
    return {
        id: ARTIST, publicCode: 'art0001', name: 'Kaze', slug: 'kaze', bio: null, genre: 'Pop',
        avatarUrl: 'https://cdn/a.png', coverUrl: null, isPublic: true, isActive: true, archivedAt: null,
        invitationId: null, complianceAttestedAt: null, complianceAttestedBy: null,
        organizationId: ORG, organization: { name: 'Lumen', type: 'BRAND' },
        userId: '66666666-6666-4666-8666-666666666666',
        user: {
            id: '66666666-6666-4666-8666-666666666666', email: 'kaze@example.com', fullName: 'Kaze',
            isActive: true, createdAt: new Date('2025-12-01T00:00:00Z'),
        },
        artistBrandLinks: [],
        createdAt: at, updatedAt: at,
        _count: { drops: 3, artistCollections: 1, follows: 7, skuClaims: 2 },
        ...over,
    } as StaffArtistRow;
}

const STATUS: ArtistAccountStatus = {
    payouts: { lastPayout: null, openBatches: 0, failedBatches: 0 },
    tax: { documents: [], hasApprovedDocument: false, backupWithholding: false },
};

function setup(initial: StaffArtistRow[] = [row()], opts: { insights?: boolean; raceOnWrite?: boolean } = {}) {
    const rows = new Map(initial.map((r) => [r.id, { ...r }]));
    const audits: { eventType: string; metadata?: unknown; actor: unknown; beforeState?: unknown; afterState?: unknown }[] = [];
    const events: { name: string; payload: unknown }[] = [];
    const writes: { guard: ArtistStateGuard; data: ArtistStaffChanges }[] = [];
    const insightCalls: { method: string; includeMoney: boolean }[] = [];

    const artists = {
        findById: async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null),
        slugTaken: async (slug: string, except: string) =>
            [...rows.values()].some((r) => r.slug === slug && r.id !== except),
        updateGuarded: async (id: string, guard: ArtistStateGuard, data: ArtistStaffChanges) => {
            writes.push({ guard, data });
            const current = rows.get(id);
            if (!current || opts.raceOnWrite) return null;
            if (guard.isActive !== undefined && current.isActive !== guard.isActive) return null;
            if (guard.isPublic !== undefined && current.isPublic !== guard.isPublic) return null;
            if (guard.archived !== undefined && (current.archivedAt !== null) !== guard.archived) return null;
            const next = { ...current, ...data } as StaffArtistRow;
            rows.set(id, next);
            return { ...next };
        },
        counts: async () => ({
            total: 4, active: 3, inactive: 1, public: 2, unlisted: 2, archived: 1, newThisMonth: 1,
            withoutAvatar: 2, withoutBio: 3, withoutAccount: 1, withoutCompliance: 4,
        }),
        findCards: async (ids: string[]) =>
            ids.filter((id) => rows.has(id)).map((id) => ({
                id, name: rows.get(id)!.name, slug: rows.get(id)!.slug, avatarUrl: null,
            })),
    } as unknown as ArtistAdminRepository;

    const insights: IArtistInsights = {
        stats: async ({ includeMoney }) => {
            insightCalls.push({ method: 'stats', includeMoney });
            return {
                period: { type: 'year', from: '2025-10-25T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' },
                sales: {
                    lifetime: { orders: 2, unitsSold: 3, ...(includeMoney && { revenue: { USD: '30.00' } }) },
                    period: { orders: 1, unitsSold: 1 },
                    trend: [],
                },
                claims: { lifetime: 1, period: 1, revoked: 0 },
                followers: { total: 7, period: 2, trend: [] },
                topDrops: [],
            };
        },
        accountStatus: async ({ includeMoney }) => {
            insightCalls.push({ method: 'accountStatus', includeMoney });
            return STATUS;
        },
        topArtistsBySales: async ({ includeMoney }) => {
            insightCalls.push({ method: 'topArtistsBySales', includeMoney });
            // OTHER is ranked but missing from the directory (deleted) — dropped from the tiles.
            return [{ artistId: ARTIST, orders: 2, unitsSold: 3 }, { artistId: OTHER, orders: 1, unitsSold: 1 }];
        },
    };

    const service = new ArtistAdminService({
        artists,
        audit: { record: async (input) => { audits.push(input as (typeof audits)[number]); } },
        insights: opts.insights === false ? undefined : insights,
        eventBus: {
            publish: async (name: string, payload: unknown) => { events.push({ name, payload }); },
            subscribe: () => undefined,
        } as never,
        logger: pino({ level: 'silent' }),
        now: () => new Date('2026-10-24T12:00:00Z'),
    });
    return { service, rows, audits, events, writes, insightCalls };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await promise.catch((error: AppError) => {
        expect(error.statusCode ?? (error as unknown as { status: number }).status).toBe(status);
        expect(error.code).toBe(code);
    });
}

describe('GET /admin/artists/:artistId/profile', () => {
    it('returns the full record: account, compliance, counts, payout and tax status', async () => {
        const { service } = setup();
        const profile = await service.profile(ARTIST, NO_MONEY);
        expect(profile.account).toEqual({
            userId: '66666666-6666-4666-8666-666666666666',
            email: 'kaze@example.com',
            fullName: 'Kaze',
            isActive: true,
            joinedAt: '2025-12-01T00:00:00.000Z',
        });
        expect(profile.counts).toEqual({ drops: 3, collections: 1, followers: 7, claims: 2 });
        expect(profile.compliance).toEqual({ attested: false, attestedAt: null, attestedById: null });
        expect(profile.payouts).toEqual(STATUS.payouts);
        expect(profile.tax).toEqual(STATUS.tax);
    });

    it('asks for money only when the caller may see it', async () => {
        const { service, insightCalls } = setup();
        await service.profile(ARTIST, NO_MONEY);
        await service.profile(ARTIST, MONEY);
        expect(insightCalls.map((c) => c.includeMoney)).toEqual([false, true]);
    });

    it('has null payout/tax blocks when no reporting adapter is wired', async () => {
        const { service } = setup([row()], { insights: false });
        const profile = await service.profile(ARTIST, MONEY);
        expect(profile.payouts).toBeNull();
        expect(profile.tax).toBeNull();
    });

    it('404s an unknown artist', async () => {
        const { service } = setup();
        await expectAppError(service.profile(OTHER, NO_MONEY), 404, ARTIST_ADMIN_ERROR_CODES.NOT_FOUND);
    });

    it('has a null account while the invitation is unaccepted', async () => {
        const { service } = setup([row({ userId: null, user: null })]);
        expect((await service.profile(ARTIST, NO_MONEY)).account).toBeNull();
    });
});

describe('GET /admin/artists/:artistId/stats', () => {
    it('passes the window and money flag through, and says whether money is in it', async () => {
        const { service, insightCalls } = setup();
        const stats = await service.stats(ARTIST, artistStatsQuerySchema.parse({}), NO_MONEY);
        expect(stats.artistId).toBe(ARTIST);
        expect(stats.moneyVisible).toBe(false);
        expect(stats.sales.lifetime).not.toHaveProperty('revenue');
        expect(insightCalls).toEqual([{ method: 'stats', includeMoney: false }]);

        const withMoney = await service.stats(ARTIST, artistStatsQuerySchema.parse({}), MONEY);
        expect(withMoney.sales.lifetime.revenue).toEqual({ USD: '30.00' });
    });

    it('400s without a reporting adapter, 404s an unknown artist', async () => {
        await expectAppError(
            setup([row()], { insights: false }).service.stats(ARTIST, artistStatsQuerySchema.parse({}), MONEY),
            400, ARTIST_ADMIN_ERROR_CODES.STATS_UNAVAILABLE,
        );
        await expectAppError(
            setup().service.stats(OTHER, artistStatsQuerySchema.parse({}), MONEY),
            404, ARTIST_ADMIN_ERROR_CODES.NOT_FOUND,
        );
    });

    it('needs from and to for a custom period', () => {
        expect(artistStatsQuerySchema.safeParse({ period: 'custom' }).success).toBe(false);
        expect(artistStatsQuerySchema.parse({ period: 'custom', from: '2026-01-01', to: '2026-02-01' }).period).toBe('custom');
    });
});

describe('GET /admin/artists/summary', () => {
    it('returns the counts plus top sellers named from the directory', async () => {
        const { service } = setup();
        const summary = await service.summary({ top: 5 }, NO_MONEY);
        expect(summary.total).toBe(4);
        expect(summary.withoutBio).toBe(3);
        expect(summary.moneyVisible).toBe(false);
        expect(summary.topBySales).toEqual([
            { artistId: ARTIST, orders: 2, unitsSold: 3, name: 'Kaze', slug: 'kaze', avatarUrl: null },
        ]);
    });

    it('has a null top list without a reporting adapter', async () => {
        const summary = await setup([row()], { insights: false }).service.summary({ top: 5 }, MONEY);
        expect(summary.topBySales).toBeNull();
    });
});

describe('PATCH /admin/artists/:artistId', () => {
    it('writes only what changed, audits it with the reason, and publishes', async () => {
        const { service, audits, events, writes } = setup();
        const dto = staffUpdateArtistSchema.parse({ name: 'Kaze', bio: 'New bio', reason: 'Label request' });
        const profile = await service.update(ARTIST, dto, ACTOR, NO_MONEY);

        expect(profile.bio).toBe('New bio');
        expect(writes[0]!.data).toEqual({ bio: 'New bio' });
        expect(writes[0]!.guard).toEqual({ archived: false });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
            eventType: ARTIST_ADMIN_AUDIT_EVENTS.UPDATE,
            actor: { type: 'HITBOX_ADMIN', id: STAFF, roleSnapshot: 'HITBOX_SYSTEM_ADMIN' },
            metadata: { fields: ['bio'], reason: 'Label request' },
            beforeState: { bio: null },
            afterState: { bio: 'New bio' },
        });
        expect(events).toEqual([
            { name: ARTIST_ADMIN_EVENTS.PROFILE_UPDATED, payload: { artistId: ARTIST, fields: ['bio'], by: 'staff' } },
        ]);
    });

    it('writes, audits and publishes nothing when nothing differs', async () => {
        const { service, audits, events, writes } = setup();
        await service.update(ARTIST, staffUpdateArtistSchema.parse({ name: 'Kaze' }), ACTOR, NO_MONEY);
        expect(writes).toHaveLength(0);
        expect(audits).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it('takes an image down', async () => {
        const { service } = setup();
        const profile = await service.update(ARTIST, staffUpdateArtistSchema.parse({ avatarUrl: null }), ACTOR, NO_MONEY);
        expect(profile.avatarUrl).toBeNull();
    });

    it('attests compliance as the caller, once, as its own audit event', async () => {
        const { service, audits, rows } = setup();
        const profile = await service.update(ARTIST, staffUpdateArtistSchema.parse({ complianceAttested: true }), ACTOR, NO_MONEY);
        expect(profile.compliance).toEqual({
            attested: true, attestedAt: '2026-10-24T12:00:00.000Z', attestedById: STAFF,
        });
        expect(audits.map((a) => a.eventType)).toEqual([ARTIST_ADMIN_AUDIT_EVENTS.COMPLIANCE_ATTEST]);

        // A second attestation keeps the first — who and when is the evidence.
        await service.update(ARTIST, staffUpdateArtistSchema.parse({ complianceAttested: 'true' }), { userId: OTHER }, NO_MONEY);
        expect(rows.get(ARTIST)!.complianceAttestedBy).toBe(STAFF);
        expect(audits).toHaveLength(1);

        await service.update(ARTIST, staffUpdateArtistSchema.parse({ complianceAttested: false }), ACTOR, NO_MONEY);
        expect(rows.get(ARTIST)!.complianceAttestedAt).toBeNull();
        expect(audits.map((a) => a.eventType)).toEqual([
            ARTIST_ADMIN_AUDIT_EVENTS.COMPLIANCE_ATTEST,
            ARTIST_ADMIN_AUDIT_EVENTS.COMPLIANCE_REVOKE,
        ]);
    });

    it('refuses a taken handle, an unknown genre, and an archived artist', async () => {
        const taken = setup([row(), row({ id: OTHER, slug: 'nova' })]);
        await expectAppError(
            taken.service.update(ARTIST, staffUpdateArtistSchema.parse({ slug: 'nova' }), ACTOR, NO_MONEY),
            409, ARTIST_ADMIN_ERROR_CODES.SLUG_TAKEN,
        );
        await expectAppError(
            setup().service.update(ARTIST, staffUpdateArtistSchema.parse({ genre: 'Polka' }), ACTOR, NO_MONEY),
            400, ARTIST_ADMIN_ERROR_CODES.GENRE_INVALID,
        );
        await expectAppError(
            setup([row({ archivedAt: new Date() })]).service.update(
                ARTIST, staffUpdateArtistSchema.parse({ name: 'New' }), ACTOR, NO_MONEY,
            ),
            409, ARTIST_ADMIN_ERROR_CODES.ARCHIVED,
        );
    });

    it('409s when the artist changed between read and write', async () => {
        const { service, audits } = setup([row()], { raceOnWrite: true });
        await expectAppError(
            service.update(ARTIST, staffUpdateArtistSchema.parse({ name: 'New' }), ACTOR, NO_MONEY),
            409, ARTIST_ADMIN_ERROR_CODES.CHANGED,
        );
        expect(audits).toHaveLength(0);
    });

    it('validates the body: state fields are refused, a reason alone is not a change', () => {
        expect(staffUpdateArtistSchema.safeParse({ isActive: false }).success).toBe(false);
        expect(staffUpdateArtistSchema.safeParse({ organizationId: ORG }).success).toBe(false);
        expect(staffUpdateArtistSchema.safeParse({ avatarUrl: 'https://x/y.png' }).success).toBe(false);
        expect(staffUpdateArtistSchema.safeParse({ reason: 'why' }).success).toBe(false);
        expect(staffUpdateArtistSchema.safeParse({}).success).toBe(false);
    });
});

describe('POST /admin/artists/:artistId/{action}', () => {
    it('deactivates and activates, guarded on the state it expects, audited with the reason', async () => {
        const { service, audits, events, writes } = setup();
        const off = await service.changeState(ARTIST, 'deactivate', { reason: 'Contract paused' }, ACTOR, NO_MONEY);
        expect(off.isActive).toBe(false);
        expect(off.editable).toBe(false);
        expect(writes[0]!.guard).toEqual({ archived: false, isActive: true });
        expect(audits[0]).toMatchObject({
            eventType: ARTIST_ADMIN_AUDIT_EVENTS.DEACTIVATE,
            metadata: { action: 'deactivate', reason: 'Contract paused' },
            beforeState: { isActive: true },
            afterState: { isActive: false },
        });
        expect(events[0]).toEqual({
            name: ARTIST_ADMIN_EVENTS.STATUS_CHANGED,
            payload: { artistId: ARTIST, action: 'deactivate', isActive: false, isPublic: true, archivedAt: null },
        });

        const on = await service.changeState(ARTIST, 'activate', {}, ACTOR, NO_MONEY);
        expect(on.isActive).toBe(true);
        expect(audits[1]!.eventType).toBe(ARTIST_ADMIN_AUDIT_EVENTS.ACTIVATE);
    });

    it('archives and restores', async () => {
        const { service } = setup();
        const archived = await service.changeState(ARTIST, 'archive', {}, ACTOR, NO_MONEY);
        expect(archived.archivedAt).toBe('2026-10-24T12:00:00.000Z');
        const restored = await service.changeState(ARTIST, 'restore', {}, ACTOR, NO_MONEY);
        expect(restored.archivedAt).toBeNull();
    });

    it('publishes and unlists', async () => {
        const { service } = setup([row({ isPublic: false })]);
        expect((await service.changeState(ARTIST, 'publish', {}, ACTOR, NO_MONEY)).isPublic).toBe(true);
        expect((await service.changeState(ARTIST, 'unlist', {}, ACTOR, NO_MONEY)).isPublic).toBe(false);
    });

    it('refuses an action that changes nothing', async () => {
        const { service, audits } = setup();
        await expectAppError(service.changeState(ARTIST, 'activate', {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.STATE_UNCHANGED);
        await expectAppError(service.changeState(ARTIST, 'publish', {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.STATE_UNCHANGED);
        await expectAppError(service.changeState(ARTIST, 'restore', {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.NOT_ARCHIVED);
        expect(audits).toHaveLength(0);
    });

    it('refuses everything but restore on an archived artist', async () => {
        const { service } = setup([row({ archivedAt: new Date() })]);
        for (const action of ['activate', 'deactivate', 'archive', 'publish', 'unlist'] as const) {
            await expectAppError(service.changeState(ARTIST, action, {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.ARCHIVED);
        }
    });

    it('will not make an inactive artist public', async () => {
        const { service } = setup([row({ isActive: false, isPublic: false })]);
        await expectAppError(service.changeState(ARTIST, 'publish', {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.INACTIVE);
    });

    it('409s on a race and audits nothing', async () => {
        const { service, audits, events } = setup([row()], { raceOnWrite: true });
        await expectAppError(service.changeState(ARTIST, 'deactivate', {}, ACTOR, NO_MONEY), 409, ARTIST_ADMIN_ERROR_CODES.CHANGED);
        expect(audits).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it('accepts an empty body or a reason, nothing else', () => {
        expect(artistStateActionSchema.parse({})).toEqual({});
        expect(artistStateActionSchema.parse({ reason: ' Fraud review ' })).toEqual({ reason: 'Fraud review' });
        expect(artistStateActionSchema.safeParse({ isActive: true }).success).toBe(false);
    });
});

describe('GET /admin/artists — query parsing', () => {
    it('reads "false" as false (it used to read as true)', () => {
        const q = listArtistsQuerySchema.parse({ isActive: 'false', isPublic: 'false', includeArchived: 'false' });
        expect(q.isActive).toBe(false);
        expect(q.isPublic).toBe(false);
        expect(q.includeArchived).toBe(false);
        expect(listArtistsQuerySchema.parse({ isActive: 'true', includeArchived: '1' })).toMatchObject({
            isActive: true, includeArchived: true,
        });
    });

    it('leaves an omitted flag unset and refuses anything that is not a boolean word', () => {
        expect(listArtistsQuerySchema.parse({}).isActive).toBeUndefined();
        expect(listArtistsQuerySchema.safeParse({ isActive: 'yes' }).success).toBe(false);
        expect(listArtistsQuerySchema.safeParse({ isPublic: '' }).success).toBe(false);
    });

    it('sorts A–Z by default and accepts the other orderings', () => {
        expect(listArtistsQuerySchema.parse({}).sort).toBe('name');
        for (const sort of ['newest', 'oldest', 'drops', 'collections', 'followers']) {
            expect(listArtistsQuerySchema.parse({ sort }).sort).toBe(sort);
        }
        expect(listArtistsQuerySchema.safeParse({ sort: 'revenue' }).success).toBe(false);
    });
});

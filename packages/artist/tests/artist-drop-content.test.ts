import { AppError } from '@hitbox/shared';
import type { IDropCollectionMembership, MembershipDrop } from '../src/collection/domain/drop-membership.port';
import { ARTIST_DROP_AUDIT_EVENTS, ARTIST_DROP_ERROR_CODES, ARTIST_DROP_EVENTS } from '../src/drop/constants/artist-drop.constant';
import type { DropContentView, IDropContent } from '../src/drop/domain/drop-content.port';
import { createDropContentSchema, updateDropContentSchema } from '../src/drop/dto/drop-content.dto';
import { ArtistDropContentService } from '../src/drop/service/artist-drop-content.service';
import { ARTIST_SELF_ERROR_CODES } from '../src/self/constants/artist-self.constant';
import type { ArtistSelfRepository, ArtistSelfRow } from '../src/self/repository/artist-self.repository';

/**
 * The artist panel's side of drop content — docs/content/drop-content.md §3.
 * The content rules live in the content module (faked here); this file pins
 * ownership, locks and the audit trail.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const MINE = 'd1111111-1111-4111-8111-111111111111';
const THEIRS = 'd2222222-2222-4222-8222-222222222222';
const BUNDLE = 'e1111111-1111-4111-8111-111111111111';

function drop(id: string, artistId: string | null): MembershipDrop {
    return {
        id, publicCode: null, name: 'Tee', groupCode: 'G', status: 'ACTIVE', active: true, artistId,
        totalSupply: 100, rewardPoints: 0, publishedAt: null, collection: null,
    };
}

function view(over: Partial<DropContentView> = {}): DropContentView {
    return {
        id: BUNDLE, dropId: MINE, tier: 'EXCLUSIVE', name: 'Signed poster', description: null, status: 'ON',
        isActive: true, archivedAt: null, serialNumbers: [1], items: [], ...over,
    };
}

function setup(opts: { artist?: Partial<ArtistSelfRow> | null; noContent?: boolean } = {}) {
    const audits: { eventType: string; metadata?: Record<string, unknown>; resource?: unknown }[] = [];
    const events: { name: string; payload: unknown }[] = [];
    const calls: string[] = [];
    let current = view();

    const content = {
        overview: async (dropId: string) => ({ drop: { id: dropId, name: 'Tee', totalSupply: 100 }, regular: null, exclusive: [current] }),
        get: async () => current,
        create: async (input: { tier: 'REGULAR' | 'EXCLUSIVE'; name: string; serialNumbers?: number[] }) => {
            calls.push('create');
            current = view({ tier: input.tier, name: input.name, serialNumbers: input.serialNumbers ?? [] });
            return current;
        },
        update: async (input: { serialNumbers?: number[] }) => {
            current = view({ ...current, serialNumbers: input.serialNumbers ?? current.serialNumbers });
            return current;
        },
        remove: async () => {
            const changed = current.status !== 'REMOVED';
            current = view({ ...current, status: 'REMOVED', archivedAt: 'x' });
            return { view: current, changed };
        },
        restore: async () => { current = view({ ...current, status: 'ON', archivedAt: null }); return current; },
        createItemUpload: async (input: { uploadedById: string; mimeType: string }) => {
            calls.push(`upload:${input.uploadedById}`);
            return { assetId: 'a1', uploadUrl: 'u', expiresIn: 300, requiredHeaders: { 'Content-Type': input.mimeType }, kind: 'VIDEO' };
        },
        addItem: async (input: { assetId: string }) => {
            current = view({ ...current, items: [{ id: 'i1', assetId: input.assetId, kind: 'VIDEO', title: 'Film', position: 0 }] });
            return current;
        },
        updateItem: async () => current,
        reorderItems: async () => current,
        removeItem: async () => { current = view({ ...current, items: [] }); return current; },
    } as unknown as IDropContent;

    const drops = {
        findDrops: async (ids: string[]) => ids.flatMap((id) => (id === MINE ? [drop(MINE, ME)] : id === THEIRS ? [drop(THEIRS, 'someone-else')] : [])),
    } as unknown as IDropCollectionMembership;
    const artists = {
        findByUserId: async () =>
            opts.artist === null ? null : ({ id: ME, isActive: true, archivedAt: null, ...opts.artist } as ArtistSelfRow),
    } as unknown as ArtistSelfRepository;

    const service = new ArtistDropContentService({
        artists,
        drops,
        content: opts.noContent ? undefined : content,
        audit: { record: async (input) => { audits.push(input as (typeof audits)[number]); } },
        eventBus: { publish: async (name: string, payload: unknown) => { events.push({ name, payload }); }, subscribe: () => undefined } as never,
    });
    return { service, audits, events, calls };
}

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        return (error as AppError).code ?? '';
    }
    throw new Error('expected a rejection');
}

describe('artist drop content', () => {
    it("another artist's drop, or one that doesn't exist, is a 404", async () => {
        const { service, calls } = setup();
        expect(await code(service.overview(USER, THEIRS))).toBe(ARTIST_DROP_ERROR_CODES.DROP_NOT_FOUND);
        expect(await code(service.create(USER, 'd9999999-9999-4999-8999-999999999999', { tier: 'REGULAR', name: 'x' })))
            .toBe(ARTIST_DROP_ERROR_CODES.DROP_NOT_FOUND);
        expect(calls).toEqual([]);
    });

    it('a locked profile cannot change drop content, but can still read it', async () => {
        const { service } = setup({ artist: { isActive: false } });
        expect(await code(service.create(USER, MINE, { tier: 'REGULAR', name: 'x' }))).toBe(ARTIST_SELF_ERROR_CODES.PROFILE_LOCKED);
        expect((await service.overview(USER, MINE)).exclusive).toHaveLength(1);
    });

    it('without a content module the routes answer clearly', async () => {
        const { service } = setup({ noContent: true });
        expect(await code(service.overview(USER, MINE))).toBe(ARTIST_DROP_ERROR_CODES.CONTENT_UNAVAILABLE);
    });

    it('audits a create with the tier and how many units it names', async () => {
        const { service, audits, events } = setup();
        await service.create(USER, MINE, { tier: 'EXCLUSIVE', name: 'VIP', serialNumbers: [1, 2] });
        expect(audits[0]).toMatchObject({
            eventType: ARTIST_DROP_AUDIT_EVENTS.CONTENT_SAVE,
            resource: { type: 'ContentBundle', id: BUNDLE },
            metadata: { action: 'create', tier: 'EXCLUSIVE', serialCount: 2, dropId: MINE, artistId: ME },
        });
        expect(events[0]).toMatchObject({ name: ARTIST_DROP_EVENTS.CONTENT_CHANGED });
    });

    it('audits which units gained and lost access when the serial list changes', async () => {
        const { service, audits } = setup();
        await service.update(USER, MINE, BUNDLE, { serialNumbers: [2, 3] });
        expect(audits[0]!.metadata).toMatchObject({ action: 'update', serialsAdded: [2, 3], serialsRemoved: [1] });
    });

    it('a second remove changes nothing and is not audited again', async () => {
        const { service, audits } = setup();
        await service.remove(USER, MINE, BUNDLE);
        await service.remove(USER, MINE, BUNDLE);
        expect(audits.map((a) => a.eventType)).toEqual([ARTIST_DROP_AUDIT_EVENTS.CONTENT_REMOVE]);
    });

    it('uploads are made as the caller and are not audited; adding the file is', async () => {
        const { service, audits, calls } = setup();
        await service.createItemUpload(USER, MINE, BUNDLE, { fileName: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 10 });
        expect(calls).toEqual([`upload:${USER}`]);
        expect(audits).toEqual([]);
        await service.addItem(USER, MINE, BUNDLE, { assetId: 'a1' });
        expect(audits[0]).toMatchObject({ eventType: ARTIST_DROP_AUDIT_EVENTS.CONTENT_ITEM_ADD, metadata: { itemId: 'i1', kind: 'VIDEO' } });
    });
});

describe('drop content request schemas', () => {
    it('accepts a tier with serial numbers and refuses unknown fields', () => {
        expect(createDropContentSchema.safeParse({ tier: 'EXCLUSIVE', name: 'VIP', serialNumbers: [1] }).success).toBe(true);
        expect(createDropContentSchema.safeParse({ tier: 'GOLD', name: 'VIP' }).success).toBe(false);
        expect(createDropContentSchema.safeParse({ tier: 'REGULAR', name: 'x', accessType: 'OWNER_ONLY' }).success).toBe(false);
        expect(createDropContentSchema.safeParse({ tier: 'EXCLUSIVE', name: 'x', serialNumbers: [0] }).success).toBe(false);
    });

    it('an update must change something, and cannot empty the serial list', () => {
        expect(updateDropContentSchema.safeParse({}).success).toBe(false);
        expect(updateDropContentSchema.safeParse({ serialNumbers: [] }).success).toBe(false);
        expect(updateDropContentSchema.safeParse({ isActive: 'false' }).success).toBe(true);
    });
});

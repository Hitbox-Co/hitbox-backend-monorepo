import { describe, expect, it } from '@jest/globals';
import type {
    INfcTapVerifier,
    NfcTapInput,
} from '../src/domain/interfaces/nfc-tap-verifier.interface';
import { ALICE, BOB, SKU_A, harness } from './helpers';
import type { Harness } from './helpers';

/**
 * The tap-URL claim and verify flow, through the claims service.
 *
 * The verifier is a stand-in with the one property that matters here: a given
 * URL authenticates exactly once (a second use is a replay) and an unknown
 * URL never does. Its real behaviour — keys, MAC, counter, every reason code —
 * is covered in packages/skus/tests/nfc-verify.test.ts.
 */

const B = 'nks0h2k9m4p7x3f8q2n6';
const TAG = 'tag-1';

function makeTaps() {
    const known = new Map<string, { nfcTagId: string; skuId: string }>();
    const used = new Set<string>();
    const seen: NfcTapInput[] = [];

    const verifier: INfcTapVerifier = {
        async verifyTap(input) {
            seen.push(input);
            const key = `${input.b}|${input.e}|${input.c}`;
            const hit = known.get(key);
            if (!hit) return { ok: false, reason: 'BAD_CMAC' };
            if (used.has(key)) return { ok: false, reason: 'REPLAY' };
            used.add(key);
            return { ok: true, ...hit, keySetId: 'ks-1', counter: used.size };
        },
    };

    /** A fresh, never-used URL for the chip in SKU_A. */
    const url = (n: number) => {
        const tap = {
            b: B,
            e: n.toString(16).padStart(32, '0').toUpperCase(),
            c: n.toString(16).padStart(16, '0').toUpperCase(),
        };
        known.set(`${tap.b}|${tap.e}|${tap.c}`, { nfcTagId: TAG, skuId: SKU_A });
        return tap;
    };
    return { verifier, url, seen };
}

function setup(options: { withVerifier?: boolean } = {}) {
    const taps = makeTaps();
    const h = harness({
        ...(options.withVerifier === false ? {} : { tapVerifier: taps.verifier }),
    });
    h.prisma.store.nfcTag.push({ id: TAG, lifecycleState: 'BOUND', activatedAt: null });
    h.prisma.store.sku.find((s) => s.id === SKU_A)!.currentNfcTagId = TAG;
    return { h, taps };
}

/** SKU_A already belongs to `ownerId`, who keeps it `visibility`. */
function ownedBy(h: Harness, ownerId: string, visibility: 'PUBLIC' | 'PRIVATE') {
    const sku = h.prisma.store.sku.find((s) => s.id === SKU_A)!;
    sku.claimedStatus = 'CLAIMED';
    sku.ownerId = ownerId;
    h.prisma.store.buyerCollection.push({
        id: `bc-${ownerId}`,
        userId: ownerId,
        skuId: SKU_A,
        visibility,
        archivedAt: null,
    });
}

const claimBody = (tap: { b: string; e: string; c: string }, visibility: 'PUBLIC' | 'PRIVATE' = 'PRIVATE') => ({
    ...tap,
    visibility,
});

describe('claiming with a tap URL', () => {
    it('claims an unclaimed item for the signed-in user, with no claim token', async () => {
        const { h, taps } = setup();
        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(result).toMatchObject({
            verified: true,
            outcome: 'CLAIMED',
            claimedByYou: true,
            owner: { id: ALICE },
        });
        expect(h.skuStatus(SKU_A)).toBe('CLAIMED');
        expect(h.prisma.store.sku.find((s) => s.id === SKU_A)!.ownerId).toBe(ALICE);
        expect(h.claims()).toHaveLength(1);
        expect(h.prisma.store.skuHistory).toHaveLength(1);
        expect(h.prisma.store.buyerCollection[0]).toMatchObject({ userId: ALICE, visibility: 'PRIVATE' });
        // MINT (origin) then CLAIM.
        expect(h.prisma.store.blockchainLedger.map((l) => l.txType)).toEqual(['MINT', 'CLAIM']);
        // The claim event is published.
        expect(h.eventBus.published.map((p) => p.event)).toContain('claims.product.claimed');
    });

    it('moves the chip and the unit to ACTIVE', async () => {
        const { h, taps } = setup();
        await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(h.prisma.store.nfcTag[0]).toMatchObject({ lifecycleState: 'ACTIVE' });
        expect(h.prisma.store.nfcTag[0]!.activatedAt).toBeInstanceOf(Date);
        expect(h.prisma.store.sku.find((s) => s.id === SKU_A)!.tagLifecycleState).toBe('ACTIVE');
    });

    it('honours the visibility the claimer chose', async () => {
        const { h, taps } = setup();
        await h.service.claimByTap(ALICE, claimBody(taps.url(1), 'PUBLIC'), 'req-1');
        expect(h.prisma.store.buyerCollection[0]!.visibility).toBe('PUBLIC');
    });

    it('returns the product with image, price and rarity, without a second call', async () => {
        const { h, taps } = setup();
        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');
        if (!result.verified) throw new Error('expected verified');

        expect(result.product).toMatchObject({
            groupCode: 'HB-DEMO-001',
            name: 'Demo Collectible',
            rarity: 'RARE',
            imageUrl: null,
            priceInDollars: null,
        });
        expect(result.sku.skuCode).toMatch(/^HB-DEMO-001-/);
    });

    it('passes the request id and the three values to the verifier', async () => {
        const { h, taps } = setup();
        const tap = taps.url(1);
        await h.service.claimByTap(ALICE, claimBody(tap), 'req-xyz');
        expect(taps.seen[0]).toEqual({ ...tap, requestId: 'req-xyz' });
    });
});

describe('a tap that does not authenticate', () => {
    it('answers NOT_VERIFIED, generically, and writes nothing', async () => {
        const { h } = setup();
        const forged = { b: B, e: 'F'.repeat(32), c: 'F'.repeat(16) };
        const result = await h.service.claimByTap(ALICE, claimBody(forged), 'req-1');

        expect(result).toEqual({
            verified: false,
            outcome: 'NOT_VERIFIED',
            message: expect.any(String),
        });
        expect(h.claims()).toHaveLength(0);
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
        expect(h.prisma.store.buyerCollection).toHaveLength(0);
        expect(h.prisma.store.nfcTag[0]!.lifecycleState).toBe('BOUND');
    });

    it('never says which check failed', async () => {
        const { h, taps } = setup();
        const tap = taps.url(1);
        await h.service.claimByTap(ALICE, claimBody(tap), 'req-1');
        const replay = await h.service.claimByTap(BOB, claimBody(tap), 'req-2');
        const forged = await h.service.claimByTap(BOB, claimBody({ ...tap, c: '0'.repeat(16) }), 'req-3');

        // A replay and a forgery are indistinguishable to the caller.
        expect(replay).toEqual(forged);
        const text = JSON.stringify([replay, forged]);
        for (const word of ['REPLAY', 'BAD_CMAC', 'BAD_PICC', 'UNKNOWN', 'MISMATCH', 'RETIRED']) {
            expect(text).not.toContain(word);
        }
    });

    it('replaying a URL that already claimed changes nothing', async () => {
        const { h, taps } = setup();
        const tap = taps.url(1);
        await h.service.claimByTap(ALICE, claimBody(tap), 'req-1');
        const again = await h.service.claimByTap(ALICE, claimBody(tap), 'req-2');

        expect(again).toMatchObject({ verified: false, outcome: 'NOT_VERIFIED' });
        expect(h.claims()).toHaveLength(1);
    });

    it('a URL already spent on verify cannot also claim', async () => {
        const { h, taps } = setup();
        const tap = taps.url(1);

        const checked = await h.service.verifyByTap(tap, 'req-1');
        expect(checked).toMatchObject({ verified: true });

        const claim = await h.service.claimByTap(ALICE, claimBody(tap), 'req-2');
        expect(claim).toMatchObject({ verified: false, outcome: 'NOT_VERIFIED' });
        expect(h.claims()).toHaveLength(0);
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
    });

    it('answers 503 when no verifier is configured, and touches nothing', async () => {
        const { h, taps } = setup({ withVerifier: false });
        await expect(
            h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1'),
        ).rejects.toMatchObject({ statusCode: 503 });
        await expect(h.service.verifyByTap(taps.url(2), 'req-2')).rejects.toMatchObject({
            statusCode: 503,
        });
        expect(h.claims()).toHaveLength(0);
    });
});

describe('an item that is already claimed', () => {
    it('returns the owner and changes nothing when the owner is PUBLIC', async () => {
        const { h, taps } = setup();
        ownedBy(h, BOB, 'PUBLIC');
        const before = JSON.stringify(h.prisma.store);

        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(result).toMatchObject({
            verified: true,
            outcome: 'ALREADY_CLAIMED',
            claimedByYou: false,
            owner: { id: BOB, handle: 'bob' },
        });
        expect(h.claims()).toHaveLength(0);
        // The only difference allowed: nothing. (The chip counter lives in the
        // verifier, not in this store.)
        expect(JSON.stringify(h.prisma.store)).toBe(before);
    });

    it('hides the owner when they keep the item PRIVATE', async () => {
        const { h, taps } = setup();
        ownedBy(h, BOB, 'PRIVATE');

        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(result).toMatchObject({ outcome: 'ALREADY_CLAIMED', claimedByYou: false, owner: null });
        const text = JSON.stringify(result);
        expect(text).not.toContain('bob');
        expect(text).not.toContain(BOB);
        expect(text).toContain('another collector');
    });

    it('treats an owner with no collection row as private', async () => {
        const { h, taps } = setup();
        ownedBy(h, BOB, 'PUBLIC');
        h.prisma.store.buyerCollection.length = 0;

        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');
        expect(result).toMatchObject({ outcome: 'ALREADY_CLAIMED', owner: null });
    });

    it('tells the owner it is theirs, even when it is PRIVATE', async () => {
        const { h, taps } = setup();
        ownedBy(h, ALICE, 'PRIVATE');

        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(result).toMatchObject({
            outcome: 'ALREADY_CLAIMED',
            claimedByYou: true,
            owner: { id: ALICE },
        });
        expect(h.claims()).toHaveLength(0);
    });

    it('reports a frozen item as UNAVAILABLE, not as a lost race', async () => {
        const { h, taps } = setup();
        h.prisma.store.sku.find((s) => s.id === SKU_A)!.claimedStatus = 'FLAGGED';

        const result = await h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-1');

        expect(result).toMatchObject({ verified: true, outcome: 'UNAVAILABLE', owner: null });
        expect(h.claims()).toHaveLength(0);
        expect(h.skuStatus(SKU_A)).toBe('FLAGGED');
    });
});

describe('two users claiming the same item at the same time', () => {
    it('exactly one wins; the other is told it just lost', async () => {
        const { h, taps } = setup();
        const a = taps.url(1);
        const b = taps.url(2);

        const [first, second] = await Promise.all([
            h.service.claimByTap(ALICE, claimBody(a), 'req-a'),
            h.service.claimByTap(BOB, claimBody(b), 'req-b'),
        ]);

        const outcomes = [first, second].map((r) => (r.verified ? r.outcome : 'NOT_VERIFIED')).sort();
        expect(outcomes).toEqual(['CLAIMED', 'CLAIMED_BY_OTHER_JUST_NOW']);
        expect(h.claims()).toHaveLength(1);
        expect(h.prisma.store.skuHistory.filter((r) => r.isCurrent)).toHaveLength(1);
        expect(h.prisma.store.buyerCollection).toHaveLength(1);
    });

    it('stays exactly one winner across many rounds', async () => {
        for (let round = 0; round < 20; round += 1) {
            const { h, taps } = setup();
            await Promise.all([
                h.service.claimByTap(ALICE, claimBody(taps.url(1)), 'req-a'),
                h.service.claimByTap(BOB, claimBody(taps.url(2)), 'req-b'),
            ]);
            expect(h.claims()).toHaveLength(1);
        }
    });
});

describe('verifying with a tap URL (public, never claims)', () => {
    it('reports an unclaimed item without an owner, and claims nothing', async () => {
        const { h, taps } = setup();
        const result = await h.service.verifyByTap(taps.url(1), 'req-1');

        expect(result).toMatchObject({
            verified: true,
            claimed: false,
            claimedStatus: 'UNCLAIMED',
            owner: null,
            product: { name: 'Demo Collectible', rarity: 'RARE' },
        });
        expect(h.claims()).toHaveLength(0);
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
    });

    it('shows a PUBLIC owner and hides a PRIVATE one', async () => {
        const open = setup();
        ownedBy(open.h, BOB, 'PUBLIC');
        const shown = await open.h.service.verifyByTap(open.taps.url(1), 'req-1');
        expect(shown).toMatchObject({ claimed: true, owner: { id: BOB } });

        const closed = setup();
        ownedBy(closed.h, BOB, 'PRIVATE');
        const hidden = await closed.h.service.verifyByTap(closed.taps.url(1), 'req-2');
        expect(hidden).toMatchObject({ claimed: true, owner: null });
        expect(JSON.stringify(hidden)).not.toContain(BOB);
    });

    it('answers a generic not-verified for a bad tap', async () => {
        const { h } = setup();
        const result = await h.service.verifyByTap(
            { b: B, e: 'A'.repeat(32), c: 'B'.repeat(16) },
            'req-1',
        );
        expect(result).toEqual({ verified: false, message: expect.any(String) });
    });

    it('the same URL cannot be verified twice', async () => {
        const { h, taps } = setup();
        const tap = taps.url(1);
        expect(await h.service.verifyByTap(tap, 'req-1')).toMatchObject({ verified: true });
        expect(await h.service.verifyByTap(tap, 'req-2')).toMatchObject({ verified: false });
    });
});

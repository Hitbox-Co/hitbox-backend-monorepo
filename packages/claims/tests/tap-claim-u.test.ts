import { describe, expect, it } from '@jest/globals';
import type { INfcTapVerifier, NfcTapInput } from '../src/domain/interfaces/nfc-tap-verifier.interface';
import { claimTapBodySchema, verifyTapQuerySchema } from '../src/dto/claims.dto';
import { ALICE, BOB, SKU_A, harness } from './helpers';

/**
 * The per-tag (`u`) form of the tap flow, through the claims service and the
 * request schemas. The verifier is a stand-in with the one property that
 * matters here: a URL authenticates once, then it is a replay. Its real
 * behaviour is covered in packages/skus/tests/nfc-verify-per-tag.test.ts.
 */

const UID = '04DE5F1EACC040';
const TAG = 'tag-1';

function setup() {
    const used = new Set<string>();
    const seen: NfcTapInput[] = [];
    const verifier: INfcTapVerifier = {
        async verifyTap(input) {
            seen.push(input);
            if (input.u !== UID) return { ok: false, reason: 'UNKNOWN_TAG' };
            const key = `${input.e}|${input.c}`;
            if (used.has(key)) return { ok: false, reason: 'REPLAY' };
            used.add(key);
            return { ok: true, nfcTagId: TAG, skuId: SKU_A, nfcTagKeyId: 'key-1', counter: used.size };
        },
    };
    const h = harness({ tapVerifier: verifier });
    h.prisma.store.nfcTag.push({ id: TAG, lifecycleState: 'BOUND', activatedAt: null });
    h.prisma.store.sku.find((s) => s.id === SKU_A)!.currentNfcTagId = TAG;
    const url = (n: number) => ({
        u: UID,
        e: n.toString(16).padStart(32, '0').toUpperCase(),
        c: n.toString(16).padStart(16, '0').toUpperCase(),
    });
    return { h, seen, url };
}

describe('claiming with u/e/c', () => {
    it('claims for the signed-in user and hands u, e, c to the verifier', async () => {
        const { h, seen, url } = setup();
        const tap = url(1);
        const result = await h.service.claimByTap(ALICE, { ...tap, visibility: 'PRIVATE' }, 'req-1');

        expect(result).toMatchObject({ verified: true, outcome: 'CLAIMED', claimedByYou: true });
        expect(seen).toEqual([{ ...tap, requestId: 'req-1' }]);
        expect(seen[0]!.b).toBeUndefined();
        expect(h.claims()).toHaveLength(1);
    });

    it('a URL already spent on verify cannot also claim (REPLAY → NOT_VERIFIED)', async () => {
        const { h, url } = setup();
        const tap = url(2);
        await h.service.verifyByTap(tap, 'req-v');
        const result = await h.service.claimByTap(ALICE, { ...tap, visibility: 'PRIVATE' }, 'req-c');

        expect(result).toMatchObject({ verified: false, outcome: 'NOT_VERIFIED' });
        expect(h.claims()).toHaveLength(0);
    });

    it('an unknown u is a generic NOT_VERIFIED and writes nothing', async () => {
        const { h, url } = setup();
        const result = await h.service.claimByTap(
            ALICE,
            { ...url(3), u: '04FFFFFFFFFFFF', visibility: 'PRIVATE' },
            'req-1',
        );
        expect(result).toEqual({
            verified: false,
            outcome: 'NOT_VERIFIED',
            message: expect.any(String),
        });
        expect(JSON.stringify(result)).not.toMatch(/UNKNOWN_TAG|REPLAY|BAD_/);
        expect(h.claims()).toHaveLength(0);
    });

    it('two users claiming at once: exactly one wins', async () => {
        const { h, url } = setup();
        const [a, b] = await Promise.all([
            h.service.claimByTap(ALICE, { ...url(4), visibility: 'PRIVATE' }, 'r-a'),
            h.service.claimByTap(BOB, { ...url(5), visibility: 'PRIVATE' }, 'r-b'),
        ]);
        const outcomes = [a, b].map((r) => r.outcome).sort();
        expect(outcomes.filter((o) => o === 'CLAIMED')).toHaveLength(1);
        expect(h.claims()).toHaveLength(1);
    });

    it('two taps from the same user at once: one claims, the other is told they own it', async () => {
        const { h, url } = setup();
        const results = await Promise.all([
            h.service.claimByTap(ALICE, { ...url(8), visibility: 'PRIVATE' }, 'r-1'),
            h.service.claimByTap(ALICE, { ...url(9), visibility: 'PRIVATE' }, 'r-2'),
        ]);
        const outcomes = results.map((r) => r.outcome).sort();
        expect(outcomes).toEqual(['ALREADY_CLAIMED', 'CLAIMED']);
        expect(results.every((r) => r.verified && r.claimedByYou)).toBe(true);
        expect(JSON.stringify(results)).not.toContain('CLAIMED_BY_OTHER_JUST_NOW');
        expect(h.claims()).toHaveLength(1);
    });

    it('claiming an already claimed item shows the owner and changes nothing', async () => {
        const { h, url } = setup();
        await h.service.claimByTap(ALICE, { ...url(6), visibility: 'PUBLIC' }, 'r-1');
        const second = await h.service.claimByTap(BOB, { ...url(7), visibility: 'PRIVATE' }, 'r-2');

        expect(second).toMatchObject({ outcome: 'ALREADY_CLAIMED', claimedByYou: false });
        expect(h.claims()).toHaveLength(1);
    });
});

describe('the request schemas', () => {
    const base = { e: 'A'.repeat(32), c: 'B'.repeat(16) };

    it('accept u and upper-case it', () => {
        expect(verifyTapQuerySchema.parse({ ...base, u: UID.toLowerCase() }).u).toBe(UID);
        expect(claimTapBodySchema.parse({ ...base, u: UID }).visibility).toBe('PRIVATE');
    });

    it('still accept the batch form b', () => {
        expect(verifyTapQuerySchema.parse({ ...base, b: '786' }).b).toBe('786');
    });

    it('refuse both u and b, and neither', () => {
        expect(verifyTapQuerySchema.safeParse({ ...base, u: UID, b: '786' }).success).toBe(false);
        expect(verifyTapQuerySchema.safeParse(base).success).toBe(false);
        expect(claimTapBodySchema.safeParse({ ...base, u: UID, b: '786' }).success).toBe(false);
    });

    it('refuse a malformed u, e or c', () => {
        expect(verifyTapQuerySchema.safeParse({ ...base, u: '04DE5F' }).success).toBe(false);
        expect(verifyTapQuerySchema.safeParse({ ...base, u: UID, e: 'xyz' }).success).toBe(false);
        expect(verifyTapQuerySchema.safeParse({ ...base, u: UID, c: '12' }).success).toBe(false);
    });

    it('refuse an unknown field in a claim body, and a claimer in the body', () => {
        expect(claimTapBodySchema.safeParse({ ...base, u: UID, userId: 'x' }).success).toBe(false);
    });
});

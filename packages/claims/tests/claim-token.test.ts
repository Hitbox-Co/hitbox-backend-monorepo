import { describe, expect, it } from '@jest/globals';
import { CLAIM_OUTCOME, CLAIMS_ERROR_CODES, CLAIMS_METRICS } from '../src/constants/claims.constant';
import { CLAIM_TOKEN_TTL_SECONDS, hashClaimToken } from '../src/domain/claim-token';
import { ALICE, BOB, SKU_A, TAG_A, TAG_B, harness, validatedToken } from './helpers';
import { claimCodeCollision } from './fake-prisma';

/**
 * US-P018 — claim integrity.
 *
 * The three acceptance criteria, and what pins each:
 *
 *   1. a replayed confirm is rejected and creates no second claim  → (b), (h)
 *   2. two simultaneous taps produce exactly one claim             → (f)
 *   3. the loser is told it *just* lost, not that it was claimed   → (f)
 *
 * Read tests/fake-prisma.ts before trusting (f): it proves the application
 * logic yields one winner, not that Postgres does.
 */

describe('a · a valid token claims the item once', () => {
    it('creates exactly one claim and burns the token to CONSUMED', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);

        const result = await h.service.claim(TAG_A, ALICE, {
            visibility: 'PRIVATE',
            claimToken: token,
        });

        expect(result.outcome).toBe(CLAIM_OUTCOME.CLAIMED);
        expect(result.claimedByYou).toBe(true);
        expect(h.claims()).toHaveLength(1);
        expect(h.skuStatus(SKU_A)).toBe('CLAIMED');

        const stored = h.tokens()[0]!;
        expect(stored.status).toBe('CONSUMED');
        expect(stored.consumedAt).toBeInstanceOf(Date);
        // The link back to what the token bought. Set inside the same
        // transaction, so a CONSUMED token without a claimId never commits.
        expect(stored.claimId).toBe(h.claims()[0]!.id);
    });

    it('stores only the hash, never the token', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        // A database dump must not be a list of working authorisations.
        expect(h.tokens()[0]!.tokenHash).toBe(hashClaimToken(token));
        expect(JSON.stringify(h.tokens())).not.toContain(token);
    });

    it('issues a token only on the CLAIMABLE screen', async () => {
        const h = harness();
        const first = await h.service.validate(TAG_A, ALICE);
        expect(first.claimToken).toEqual(expect.any(String));
        expect(first.claimTokenExpiresAt).toEqual(expect.any(String));

        await h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: first.claimToken! });

        // Now claimed: minting a token here would hand out a credential for a
        // claim that cannot happen — and would leave it live for the moment a
        // refund revokes the item back to UNCLAIMED.
        const afterMine = await h.service.validate(TAG_A, ALICE);
        expect(afterMine.screen).toBe('ALREADY_CLAIMED_BY_YOU');
        expect(afterMine.claimToken).toBeNull();

        const afterTheirs = await h.service.validate(TAG_A, BOB);
        expect(afterTheirs.screen).toBe('ALREADY_CLAIMED');
        expect(afterTheirs.claimToken).toBeNull();
    });

    it('expires the token two minutes out', async () => {
        const h = harness();
        const result = await h.service.validate(TAG_A, ALICE);
        const ttlMs = Date.parse(result.claimTokenExpiresAt!) - Date.now();
        expect(ttlMs).toBeGreaterThan((CLAIM_TOKEN_TTL_SECONDS - 5) * 1_000);
        expect(ttlMs).toBeLessThanOrEqual(CLAIM_TOKEN_TTL_SECONDS * 1_000);
    });
});

describe('b · the same request sent twice', () => {
    it('is rejected with 409 REUSED and creates no second claim', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        const body = { visibility: 'PRIVATE' as const, claimToken: token };

        await h.service.claim(TAG_A, ALICE, body);
        // Byte-for-byte the same request — this is the captured-replay case.
        const replay = await h.service.claim(TAG_A, ALICE, body).catch((e: unknown) => e);

        expect(replay).toMatchObject({
            statusCode: 409,
            code: CLAIMS_ERROR_CODES.TOKEN_REUSED,
        });
        expect(h.claims()).toHaveLength(1);
    });

    it('counts the replay on the token', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        const body = { visibility: 'PRIVATE' as const, claimToken: token };

        await h.service.claim(TAG_A, ALICE, body);
        await h.service.claim(TAG_A, ALICE, body).catch(() => undefined);

        const stored = h.tokens()[0]!;
        expect(stored.replayCount).toBe(1);
        expect(stored.lastReplayAt).toBeInstanceOf(Date);
        // Still CONSUMED: a replay must not overwrite the fact that this
        // token bought a claim.
        expect(stored.status).toBe('CONSUMED');
    });

    it('publishes and logs the rejection for the replay-rate alert', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        const body = { visibility: 'PRIVATE' as const, claimToken: token };

        await h.service.claim(TAG_A, ALICE, body);
        await h.service.claim(TAG_A, ALICE, body).catch(() => undefined);

        expect(h.eventBus.published).toContainEqual({
            event: 'claims.token.rejected',
            payload: expect.objectContaining({ skuId: SKU_A, userId: ALICE, reason: 'REUSED' }),
        });
        expect(
            h.logger.entries.some((e) => e.context.metric === CLAIMS_METRICS.TOKEN_REJECTED),
        ).toBe(true);
    });

    it('does not leak why in the response', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        const body = { visibility: 'PRIVATE' as const, claimToken: token };
        await h.service.claim(TAG_A, ALICE, body);

        const error = (await h.service.claim(TAG_A, ALICE, body).catch((e) => e)) as Error;
        // The sub-reason ("consumed by a concurrent request" etc.) is for the
        // log. In the body it would tell a prober what the token's state is.
        expect(error.message).not.toMatch(/concurrent|superseded|tiebreak/i);
    });
});

describe('c · an expired token', () => {
    it('is rejected as EXPIRED and leaves the item unclaimed', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        // Wind the clock past the TTL by ageing the row.
        h.tokens()[0]!.expiresAt = new Date(Date.now() - 1_000);

        const error = await h.service
            .claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: token })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            statusCode: 410,
            code: CLAIMS_ERROR_CODES.TOKEN_EXPIRED,
        });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
        expect(h.claims()).toHaveLength(0);
    });

    it('moves the row to EXPIRED so a later attempt reads the same way', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        h.tokens()[0]!.expiresAt = new Date(Date.now() - 1_000);

        await h.service
            .claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: token })
            .catch(() => undefined);

        expect(h.tokens()[0]!.status).toBe('EXPIRED');
        expect(h.tokens()[0]!.replayCount).toBe(1);
    });
});

describe('d · a token belonging to another user', () => {
    it('is rejected as INVALID', async () => {
        const h = harness();
        const alicesToken = await validatedToken(h, ALICE);

        const error = await h.service
            .claim(TAG_A, BOB, { visibility: 'PRIVATE', claimToken: alicesToken })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            statusCode: 400,
            code: CLAIMS_ERROR_CODES.TOKEN_INVALID,
        });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
        expect(h.claims()).toHaveLength(0);
        // Alice's token is untouched — Bob's failure must not burn it.
        expect(h.tokens()[0]!.status).toBe('ISSUED');
    });
});

describe('e · a token used against a different item', () => {
    it('is rejected as INVALID', async () => {
        const h = harness();
        const tokenForA = await validatedToken(h, ALICE, TAG_A);

        const error = await h.service
            .claim(TAG_B, ALICE, { visibility: 'PRIVATE', claimToken: tokenForA })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            statusCode: 400,
            code: CLAIMS_ERROR_CODES.TOKEN_INVALID,
        });
        expect(h.claims()).toHaveLength(0);
    });
});

describe('f · two simultaneous taps', () => {
    // Repeated because a race that passes once may only have been lucky with
    // the interleaving. See tests/fake-prisma.ts for what this does and does
    // not prove — it needs a real Postgres to prove the database side.
    const RUNS = 20;

    it(`produces exactly one claim, ${RUNS} times over`, async () => {
        for (let run = 0; run < RUNS; run += 1) {
            const h = harness();
            const [aliceToken, bobToken] = await Promise.all([
                validatedToken(h, ALICE),
                validatedToken(h, BOB),
            ]);

            const [a, b] = await Promise.all([
                h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: aliceToken }),
                h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE', claimToken: bobToken }),
            ]);

            const outcomes = [a.outcome, b.outcome].sort();
            expect(outcomes).toEqual([
                CLAIM_OUTCOME.CLAIMED,
                CLAIM_OUTCOME.CLAIMED_BY_OTHER_JUST_NOW,
            ]);
            expect(h.claims()).toHaveLength(1);
        }
    });

    it('tells the loser it just lost, not that it belongs to someone else', async () => {
        const h = harness();
        const [aliceToken, bobToken] = await Promise.all([
            validatedToken(h, ALICE),
            validatedToken(h, BOB),
        ]);

        const [a, b] = await Promise.all([
            h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: aliceToken }),
            h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE', claimToken: bobToken }),
        ]);

        const winner = a.outcome === CLAIM_OUTCOME.CLAIMED ? a : b;
        const loser = a.outcome === CLAIM_OUTCOME.CLAIMED ? b : a;

        expect(loser.outcome).toBe(CLAIM_OUTCOME.CLAIMED_BY_OTHER_JUST_NOW);
        expect(loser.message).toBe('This item was just claimed by someone else.');
        expect(loser.claimedByYou).toBe(false);
        expect(loser.claim).toBeNull();
        // The winner is named, so the app can show whose it is.
        expect(loser.owner.id).toBe(winner.owner.id);
    });

    it('burns the loser token to LOST_TIEBREAK', async () => {
        const h = harness();
        const [aliceToken, bobToken] = await Promise.all([
            validatedToken(h, ALICE),
            validatedToken(h, BOB),
        ]);

        await Promise.all([
            h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: aliceToken }),
            h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE', claimToken: bobToken }),
        ]);

        const statuses = h.tokens().map((t) => t.status).sort();
        // A losing tap must not leave a reusable authorisation behind — that
        // is the hole a later revocation would reopen.
        expect(statuses).toEqual(['CONSUMED', 'LOST_TIEBREAK']);
    });

    it('publishes the lost tiebreak, so the rate is measurable', async () => {
        const h = harness();
        const [aliceToken, bobToken] = await Promise.all([
            validatedToken(h, ALICE),
            validatedToken(h, BOB),
        ]);

        await Promise.all([
            h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: aliceToken }),
            h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE', claimToken: bobToken }),
        ]);

        const lost = h.eventBus.published.filter((e) => e.event === 'claims.tiebreak.lost');
        expect(lost).toHaveLength(1);
        expect(lost[0]!.payload).toMatchObject({ skuId: SKU_A, tokenId: expect.any(String) });
        expect(
            h.logger.entries.some((e) => e.context.metric === CLAIMS_METRICS.TIEBREAK_LOST),
        ).toBe(true);
    });
});

describe('g · re-validating', () => {
    it('supersedes the previous token', async () => {
        const h = harness();
        const first = await validatedToken(h, ALICE);
        const second = await validatedToken(h, ALICE);

        expect(second).not.toBe(first);
        const byHash = (raw: string) => h.tokens().find((t) => t.tokenHash === hashClaimToken(raw))!;
        expect(byHash(first).status).toBe('SUPERSEDED');
        expect(byHash(second).status).toBe('ISSUED');
    });

    it('refuses the superseded token', async () => {
        const h = harness();
        const first = await validatedToken(h, ALICE);
        await validatedToken(h, ALICE);

        const error = await h.service
            .claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: first })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({ code: CLAIMS_ERROR_CODES.TOKEN_REUSED });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
    });

    it('leaves another user’s live token alone', async () => {
        const h = harness();
        const bobToken = await validatedToken(h, BOB);
        await validatedToken(h, ALICE);

        // The whole reason this is a table and not Sku.claimToken: Alice
        // validating must not invalidate Bob's simultaneous tap.
        const bobRow = h.tokens().find((t) => t.tokenHash === hashClaimToken(bobToken))!;
        expect(bobRow.status).toBe('ISSUED');
    });
});

describe('h · replay after a revocation', () => {
    it('is rejected, and the item stays unclaimed', async () => {
        const h = harness();
        const token = await validatedToken(h, ALICE);
        const body = { visibility: 'PRIVATE' as const, claimToken: token };

        await h.service.claim(TAG_A, ALICE, body);
        const claimId = h.claims()[0]!.id;

        await h.service.revokeClaim({
            skuId: SKU_A,
            claimId,
            reason: 'refund executed',
            actorId: null,
            resaleBlockedUntil: null,
        });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');

        // THE bug this story exists to close. Before the token, this replay
        // succeeded: the item was UNCLAIMED again, and the captured request
        // was indistinguishable from a fresh one.
        const replay = await h.service.claim(TAG_A, ALICE, body).catch((e: unknown) => e);

        expect(replay).toMatchObject({ code: CLAIMS_ERROR_CODES.TOKEN_REUSED });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
        expect(h.claims()).toHaveLength(1);
    });
});

describe('i · claim-code collision retry', () => {
    it('still succeeds, using the same token', async () => {
        // The first insert collides; the transaction rolls back, which also
        // un-consumes the token, so the retry finds it ISSUED again. If the
        // token burn were not inside the transaction this would fail.
        const h = harness({
            onSkuClaimCreate: (attempt) => {
                if (attempt === 1) throw claimCodeCollision();
            },
        });
        const token = await validatedToken(h, ALICE);

        const result = await h.service.claim(TAG_A, ALICE, {
            visibility: 'PRIVATE',
            claimToken: token,
        });

        expect(result.outcome).toBe(CLAIM_OUTCOME.CLAIMED);
        expect(h.claims()).toHaveLength(1);
        expect(h.tokens()[0]!.status).toBe('CONSUMED');
        // The retry consumed it once, not twice.
        expect(h.tokens()[0]!.replayCount).toBe(0);
    });
});

describe('j · the CLAIM_TOKEN_REQUIRED flag', () => {
    it('off: a confirm with no token still works, and says so in the log', async () => {
        const h = harness({ claimTokenRequired: false });

        const result = await h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE' });

        expect(result.outcome).toBe(CLAIM_OUTCOME.CLAIMED);
        expect(h.claims()).toHaveLength(1);
        expect(h.tokens()).toHaveLength(0);
        expect(
            h.logger.entries.some((e) => e.context.metric === CLAIMS_METRICS.TOKEN_MISSING),
        ).toBe(true);
    });

    it('off: a token that IS sent is still checked in full', async () => {
        // No "off means ignore it" mode — a client that sends a token has
        // already been told the item is claimable, and must not silently
        // fall back to the unauthenticated path.
        const h = harness({ claimTokenRequired: false });
        const token = await validatedToken(h, ALICE);
        h.tokens()[0]!.status = 'SUPERSEDED';

        const error = await h.service
            .claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: token })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({ code: CLAIMS_ERROR_CODES.TOKEN_REUSED });
    });

    it('on: a confirm with no token is a 400', async () => {
        const h = harness({ claimTokenRequired: true });

        const error = await h.service
            .claim(TAG_A, ALICE, { visibility: 'PRIVATE' })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            statusCode: 400,
            code: CLAIMS_ERROR_CODES.TOKEN_INVALID,
        });
        expect(h.skuStatus(SKU_A)).toBe('UNCLAIMED');
    });

    it('the race outcome applies with the flag off', async () => {
        // Criterion 3 is not gated on the rollout: a losing tap gets the
        // explicit answer whether or not tokens are required.
        const h = harness({ claimTokenRequired: false });
        const [a, b] = await Promise.all([
            h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE' }),
            h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE' }),
        ]);

        expect([a.outcome, b.outcome].sort()).toEqual([
            CLAIM_OUTCOME.CLAIMED,
            CLAIM_OUTCOME.CLAIMED_BY_OTHER_JUST_NOW,
        ]);
        expect(h.claims()).toHaveLength(1);
    });
});

describe('an item claimed long ago', () => {
    it('still reads as ALREADY_CLAIMED, not as a race', async () => {
        // The distinction only means something if the old case keeps its old
        // answer. Bob taps something Alice claimed in a previous request.
        const h = harness();
        const aliceToken = await validatedToken(h, ALICE);
        await h.service.claim(TAG_A, ALICE, { visibility: 'PRIVATE', claimToken: aliceToken });

        const bobsView = await h.service.validate(TAG_A, BOB);
        expect(bobsView.screen).toBe('ALREADY_CLAIMED');

        const result = await h.service.claim(TAG_A, BOB, { visibility: 'PRIVATE' });
        expect(result.outcome).toBe(CLAIM_OUTCOME.ALREADY_CLAIMED);
        expect(result.message).toContain('already claimed by');
        expect(h.claims()).toHaveLength(1);
    });
});

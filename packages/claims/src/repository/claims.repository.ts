import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, SkuClaim, User } from '@hitbox/database';
import { LEDGER_ORIGIN_OWNER } from '../constants/claims.constant';
import { ClaimTokenRejectedError } from '../domain/claim-token';
import { computeLedgerHash } from '../domain/ledger-hash';

/**
 * The only place in this module that touches Prisma.
 *
 * **The claim subject is a SKU, not a product.** The NFC tag moved from
 * `Product.tagId` to `Sku.tagId`, and with it `claimedStatus` and `ownerId` —
 * which is the correct shape: a tag is glued to one serialized item, not to a
 * catalog entry. Every lookup here starts from `Sku` and reaches the catalog
 * as `sku.drop`.
 *
 * `SkuClaim`, `SkuHistory` and `BlockchainLedger` are all keyed by
 * `skuId` now, so the provenance chain is per-item rather than per-drop —
 * previously every SKU of a product shared one chain, which could not
 * represent two buyers holding two copies.
 */

/** The one base price a ledger/validate response can legitimately quote. */
const basePriceArgs = {
    where: {
        status: 'ACTIVE',
        variantId: null,
        market: { isDefault: true, isActive: true },
    },
    take: 1,
    select: { amount: true, isFree: true, market: { select: { currency: true } } },
} satisfies Prisma.Drop$dropPricesArgs;

// SKU projection needed to verify a tag and drive the claim flow.
const skuByTagInclude = {
    owner: { select: { id: true, handle: true, fullName: true } },
    drop: {
        select: {
            id: true,
            groupCode: true,
            name: true,
            status: true,
            collectionId: true,
            collection: { select: { id: true, artistId: true } },
            dropImages: {
                where: { archivedAt: null },
                orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
                take: 1,
                select: { asset: { select: { storageRef: true } } },
            },
            dropPrices: basePriceArgs,
        },
    },
    // Most recent claim, for the "claimed at" timestamp — `Sku` carries no
    // claimedAt column; the claim row is the record of when it happened.
    skuClaims: { orderBy: { claimedNo: 'desc' }, take: 1, select: { claimedAt: true } },
} satisfies Prisma.SkuInclude;

export type SkuForTag = Prisma.SkuGetPayload<{ include: typeof skuByTagInclude }>;

/**
 * Ledger row with the SKU's tag and its product's code resolved, so each row
 * renders self-contained per the demo ledger spec.
 *
 * The `fromUser`/`toUser` relations are gone — the current `BlockchainLedger`
 * has no user foreign keys. Participants now live in the `payload` JSON
 * column, which is what that column is for: per-transaction detail that
 * varies by `txType` and must not change the table's shape.
 */
const ledgerInclude = {
    sku: { select: { tagId: true, drop: { select: { groupCode: true } } } },
} satisfies Prisma.BlockchainLedgerInclude;

export type LedgerRowFull = Prisma.BlockchainLedgerGetPayload<{ include: typeof ledgerInclude }>;

/** Shape written into `BlockchainLedger.payload`. */
export interface LedgerPayload {
    /** Display label of the owner this row records ("HitBox" for the origin). */
    ownerLabel: string;
    /** Set on CLAIM rows. */
    claimId?: string;
    toUserId?: string;
    amount?: string;
    currency?: string;
}

export function readLedgerPayload(value: Prisma.JsonValue | null): LedgerPayload {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return {
            ownerLabel:
                typeof record.ownerLabel === 'string' ? record.ownerLabel : LEDGER_ORIGIN_OWNER,
            ...(typeof record.claimId === 'string' ? { claimId: record.claimId } : {}),
            ...(typeof record.toUserId === 'string' ? { toUserId: record.toUserId } : {}),
            ...(typeof record.amount === 'string' ? { amount: record.amount } : {}),
            ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
        };
    }
    return { ownerLabel: LEDGER_ORIGIN_OWNER };
}

export interface ClaimTxParams {
    sku: SkuForTag;
    userId: string;
    /** Owner label recorded on the CLAIM row's hash (the claimer's display name). */
    ownerLabel: string;
    claimCode: string;
    visibility: 'PUBLIC' | 'PRIVATE';
    now: Date;
    /**
     * SHA-256 of the token presented on confirm, or null when the caller sent
     * none and CLAIM_TOKEN_REQUIRED is off. Null skips the token step
     * entirely; it never means "accept any token".
     */
    tokenHash?: string | null;
}

/**
 * What one claim attempt did.
 *
 * A discriminated union rather than the old `ClaimTxResult | null`, because
 * "lost the race" now has something to say: the token it burned. The caller
 * needs that id to report the tiebreak, and `null` could not carry it.
 */
export type ClaimTxOutcome =
    | {
        lost: false;
        claim: SkuClaim;
        ledger: LedgerRowFull;
        ownerId: string;
        /** The token this claim consumed, when one was presented. */
        tokenId: string | null;
    }
    | {
        lost: true;
        /** Burned to LOST_TIEBREAK before the transaction committed. */
        tokenId: string | null;
    };

/** Fields needed to explain why a presented token was refused. */
const tokenRejectionSelect = {
    id: true,
    skuId: true,
    userId: true,
    status: true,
    consumedAt: true,
    expiresAt: true,
} satisfies Prisma.ClaimTokenSelect;

/** The base price of a SKU's product in the default market, or null. */
export function basePriceOf(
    sku: SkuForTag,
): { amount: string; currency: string } | null {
    const price = sku.drop.dropPrices[0];
    if (!price) return null;
    return {
        amount: price.isFree ? '0' : (price.amount?.toString() ?? '0'),
        currency: price.market.currency,
    };
}

export class ClaimsRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** The tag is unique on `Sku`, so this resolves at most one item. */
    findSkuByTagId(tagId: string): Promise<SkuForTag | null> {
        return this.prisma.sku.findUnique({ where: { tagId }, include: skuByTagInclude });
    }

    findSkuById(id: string): Promise<SkuForTag | null> {
        return this.prisma.sku.findUnique({ where: { id }, include: skuByTagInclude });
    }

    findUserById(id: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { id } });
    }

    /** Ordered provenance chain for one SKU (seq 0 first). */
    getLedger(skuId: string): Promise<LedgerRowFull[]> {
        return this.prisma.blockchainLedger.findMany({
            where: { skuId },
            orderBy: { sequenceNo: 'asc' },
            include: ledgerInclude,
        });
    }

    /**
     * The "First Time" origin record (seq 0, owner = HitBox, no claim), so a
     * SKU's ledger shows its origin before anyone claims. Idempotent — a no-op
     * if the origin row already exists.
     */
    async ensureOriginRecord(sku: SkuForTag): Promise<void> {
        const exists = await this.prisma.blockchainLedger.findFirst({
            where: { skuId: sku.id, sequenceNo: 0 },
            select: { id: true },
        });
        if (exists) return;

        const dateTime = sku.createdAt;
        const hash = computeLedgerHash({
            productId: sku.drop.groupCode,
            tagId: sku.tagId,
            ownerId: LEDGER_ORIGIN_OWNER,
            dateTime: dateTime.toISOString(),
        });
        try {
            await this.prisma.blockchainLedger.create({
                data: mintRow({ sku, hash, dateTime }),
            });
        } catch (err) {
            // Unique (skuId, sequenceNo) — another request won the race.
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                throw err;
            }
        }
    }

    /**
     * Takes ownership back, atomically.
     *
     * Called when a refund or a lost dispute means the buyer no longer has the
     * item. Five things move together, and the reason they are one transaction
     * is that any subset of them is a lie about who owns what:
     *
     *   * the claim is stamped revoked (never deleted — the claim *happened*)
     *   * the SKU's owner is cleared and its claim state reset
     *   * the tag is quarantined if a block window was supplied
     *   * the current ownership period is closed
     *   * a FLAG row extends the hash chain, so the revocation is provable
     *
     * The buyer's shelf entry is archived rather than removed, for the same
     * reason the claim row survives: it is a record of something that was true.
     *
     * Returns null when there was nothing to revoke — an unclaimed unit, or a
     * claim already revoked. Idempotent by that guard, because a refund that
     * is executed twice must not write two FLAG rows.
     */
    async revokeClaim(params: {
        sku: SkuForTag;
        claimId: string | null;
        reason: string;
        resaleBlockedUntil: Date | null;
        now: Date;
    }): Promise<{ claimId: string | null; ledgerEntryId: string } | null> {
        const { sku, reason, resaleBlockedUntil, now } = params;

        return this.prisma.$transaction(async (tx) => {
            // Race guard: only proceed while the SKU is still CLAIMED.
            const released = await tx.sku.updateMany({
                where: { id: sku.id, claimedStatus: { in: ['CLAIMED', 'FLAGGED'] } },
                data: {
                    claimedStatus: resaleBlockedUntil ? 'FLAGGED' : 'UNCLAIMED',
                    ownerId: null,
                    ...(resaleBlockedUntil
                        ? {
                            resaleBlocked: true,
                            resaleBlockedReason: reason.slice(0, 500),
                            tagLifecycleState: 'DISPUTED' as const,
                        }
                        : {}),
                    updatedAt: now,
                },
            });
            if (released.count === 0) return null;

            const claim = params.claimId
                ? await tx.skuClaim.findUnique({ where: { id: params.claimId } })
                : await tx.skuClaim.findFirst({
                    where: { skuId: sku.id, revokedAt: null },
                    orderBy: { claimedNo: 'desc' },
                });

            if (claim && claim.revokedAt === null) {
                await tx.skuClaim.updateMany({
                    where: { id: claim.id, revokedAt: null },
                    data: { revokedAt: now, revokedReason: reason.slice(0, 500) },
                });
            }

            await tx.skuHistory.updateMany({
                where: { skuId: sku.id, isCurrent: true },
                data: { isCurrent: false, endedAt: now },
            });

            if (claim?.userId) {
                await tx.buyerCollection.updateMany({
                    where: { userId: claim.userId, skuId: sku.id, archivedAt: null },
                    data: { archivedAt: now },
                });
            }

            // Extend the chain rather than rewriting it: the CLAIM row stays,
            // and a FLAG row after it records that the claim was undone. An
            // edit would break every subsequent hash, which is the property
            // the chain exists to have.
            const last = await tx.blockchainLedger.findFirst({
                where: { skuId: sku.id },
                orderBy: { sequenceNo: 'desc' },
            });
            const hash = computeLedgerHash({
                productId: sku.drop.groupCode,
                tagId: sku.tagId,
                ownerId: LEDGER_ORIGIN_OWNER,
                dateTime: now.toISOString(),
            });
            const payload: LedgerPayload = {
                ownerLabel: LEDGER_ORIGIN_OWNER,
                ...(claim ? { claimId: claim.id } : {}),
            };
            const ledger = await tx.blockchainLedger.create({
                data: {
                    id: randomUUID(),
                    skuId: sku.id,
                    txType: 'FLAG',
                    sequenceNo: (last?.sequenceNo ?? -1) + 1,
                    previousHash: last?.currentHash ?? null,
                    currentHash: hash,
                    payload: {
                        ...payload,
                        revocationReason: reason.slice(0, 500),
                        resaleBlockedUntil: resaleBlockedUntil?.toISOString() ?? null,
                    } as unknown as Prisma.InputJsonValue,
                    createdAt: now,
                },
            });

            return { claimId: claim?.id ?? null, ledgerEntryId: ledger.id };
        }, { maxWait: 10_000, timeout: 20_000 });
    }

    /**
     * Issues a one-shot claim token for one user and one item.
     *
     * Supersedes that user's live tokens for the same item first, so
     * re-validating cannot leave two usable authorisations behind — otherwise
     * a client that taps twice ends up holding a spare token that outlives the
     * screen it was minted for.
     *
     * Scoped to `(userId, skuId)`: another person's live token for the same
     * item is left alone, which is the whole reason this is a table and not
     * `Sku.claimToken`. Two people tapping at once each keep their own.
     */
    async issueClaimToken(params: {
        skuId: string;
        userId: string;
        tokenHash: string;
        now: Date;
        expiresAt: Date;
        requestId?: string | null;
    }): Promise<{ id: string; expiresAt: Date }> {
        const { skuId, userId, tokenHash, now, expiresAt } = params;

        return this.prisma.$transaction(async (tx) => {
            await tx.claimToken.updateMany({
                where: { skuId, userId, status: 'ISSUED' },
                data: { status: 'SUPERSEDED' },
            });

            const token = await tx.claimToken.create({
                data: {
                    skuId,
                    userId,
                    tokenHash,
                    status: 'ISSUED',
                    issuedAt: now,
                    expiresAt,
                    requestId: params.requestId ?? null,
                },
                select: { id: true, expiresAt: true },
            });
            return token;
        });
    }

    /**
     * Records that a dead token was presented again.
     *
     * Best-effort and outside the claim transaction, necessarily: the
     * transaction that rejected the token rolled back, so anything written
     * inside it is gone. Callers must not let a failure here turn into a
     * failed request — the rejection already happened and is already correct.
     */
    async markTokenReplay(params: {
        tokenId: string;
        now: Date;
        expired: boolean;
    }): Promise<void> {
        await this.prisma.claimToken.update({
            where: { id: params.tokenId },
            data: {
                replayCount: { increment: 1 },
                lastReplayAt: params.now,
                // Only a token still nominally live gets moved to EXPIRED. A
                // CONSUMED token that expired afterwards is still CONSUMED —
                // overwriting that would erase the fact that it bought a claim.
                ...(params.expired ? { status: 'EXPIRED' as const } : {}),
            },
        });
    }

    /**
     * First-time claim, atomic.
     *
     * Returns `{ lost: true }` when a concurrent request claimed the item
     * first (the conditional update matched zero rows), and throws
     * `ClaimTokenRejectedError` when the presented token was not usable —
     * which rolls the whole transaction back, so a replayed request changes
     * nothing on its way to being refused. May throw Prisma P2002 on a
     * claimCode collision; the service retries with a new code, and because
     * the retry re-enters this transaction the token is still ISSUED when it
     * does.
     */
    async claimByTag(params: ClaimTxParams): Promise<ClaimTxOutcome> {
        const { sku, userId, ownerLabel, claimCode, visibility, now } = params;
        const tokenHash = params.tokenHash ?? null;
        const price = basePriceOf(sku);

        return this.prisma.$transaction(async (tx) => {
            // ── 1. Burn the token, before anything else ──────────────────
            // Order is load-bearing. If the SKU flip ran first, a replayed
            // request would claim the item and only then discover its token
            // was spent — and the rollback would be doing real work rather
            // than nothing.
            let tokenId: string | null = null;
            if (tokenHash) {
                const consumed = await tx.claimToken.updateMany({
                    where: {
                        tokenHash,
                        skuId: sku.id,
                        userId,
                        status: 'ISSUED',
                        consumedAt: null,
                        expiresAt: { gt: now },
                    },
                    data: { status: 'CONSUMED', consumedAt: now },
                });

                if (consumed.count === 0) {
                    const row = await tx.claimToken.findUnique({
                        where: { tokenHash },
                        select: tokenRejectionSelect,
                    });
                    throw rejectionFor(row, { skuId: sku.id, userId, now });
                }

                tokenId =
                    (
                        await tx.claimToken.findUnique({
                            where: { tokenHash },
                            select: { id: true },
                        })
                    )?.id ?? null;
            }

            // ── 2. Race guard: only proceed while the SKU is still UNCLAIMED.
            const flipped = await tx.sku.updateMany({
                where: { id: sku.id, claimedStatus: 'UNCLAIMED' },
                data: {
                    claimedStatus: 'CLAIMED',
                    ownerId: userId,
                    claimTokenUsedAt: now,
                    updatedAt: now,
                },
            });
            if (flipped.count === 0) {
                // Lost by milliseconds. Commit rather than throw: the token
                // must stay burned. A losing tap that left a reusable token
                // behind would let the loser replay it the moment the item
                // was ever revoked, which is the hole this whole story closes.
                if (tokenId) {
                    await tx.claimToken.update({
                        where: { id: tokenId },
                        data: { status: 'LOST_TIEBREAK' },
                    });
                }
                return { lost: true, tokenId };
            }

            // claimedNo counts claims on this SKU — unique [skuId, claimedNo].
            const priorClaims = await tx.skuClaim.count({ where: { skuId: sku.id } });
            const claim = await tx.skuClaim.create({
                data: {
                    id: randomUUID(),
                    claimCode,
                    claimedNo: priorClaims + 1,
                    claimedAt: now,
                    userId,
                    skuId: sku.id,
                    productId: sku.drop.id,
                    artistId: sku.drop.collection?.artistId ?? null,
                    collectionId: sku.drop.collectionId ?? null,
                },
            });

            // Ensure the "First Time" origin (MINT, seq 0) row exists first.
            const last = await tx.blockchainLedger.findFirst({
                where: { skuId: sku.id },
                orderBy: { sequenceNo: 'desc' },
            });
            let prevSeq = last?.sequenceNo ?? -1;
            let prevHash = last?.currentHash ?? null;

            if (!last) {
                const dateTime = sku.createdAt;
                const mintHash = computeLedgerHash({
                    productId: sku.drop.groupCode,
                    tagId: sku.tagId,
                    ownerId: LEDGER_ORIGIN_OWNER,
                    dateTime: dateTime.toISOString(),
                });
                await tx.blockchainLedger.create({ data: mintRow({ sku, hash: mintHash, dateTime }) });
                prevSeq = 0;
                prevHash = mintHash;
            }

            // The new CLAIM record — owner is the claimer.
            const claimHash = computeLedgerHash({
                productId: sku.drop.groupCode,
                tagId: sku.tagId,
                ownerId: ownerLabel,
                dateTime: now.toISOString(),
            });
            const payload: LedgerPayload = {
                ownerLabel,
                claimId: claim.id,
                toUserId: userId,
                ...(price ? { amount: price.amount, currency: price.currency } : {}),
            };
            const ledger = await tx.blockchainLedger.create({
                data: {
                    id: randomUUID(),
                    skuId: sku.id,
                    txType: 'CLAIM',
                    sequenceNo: prevSeq + 1,
                    previousHash: prevHash,
                    currentHash: claimHash,
                    sellerDigitalSignature: `sig_hitbox_${sku.drop.groupCode}`,
                    buyerDigitalSignature: `sig_buyer_${claim.id}`,
                    receiverPublicKey: `pk_${userId}`,
                    payload: payload as unknown as Prisma.InputJsonValue,
                    createdAt: now,
                },
                include: ledgerInclude,
            });

            // Close any open ownership period, then open the new one. Exactly
            // one row per SKU carries isCurrent = true.
            await tx.skuHistory.updateMany({
                where: { skuId: sku.id, isCurrent: true },
                data: { isCurrent: false, endedAt: now },
            });
            await tx.skuHistory.create({
                data: {
                    id: randomUUID(),
                    skuId: sku.id,
                    ownerId: userId,
                    acquiredVia: 'CLAIM',
                    ...(price
                        ? {
                            price: new Prisma.Decimal(price.amount),
                            currency: price.currency as never,
                        }
                        : {}),
                    startedAt: now,
                    isCurrent: true,
                },
            });

            // Collection entry — the only way items enter a buyer's shelf.
            await tx.buyerCollection.upsert({
                where: { userId_skuId: { userId, skuId: sku.id } },
                create: {
                    id: randomUUID(),
                    userId,
                    skuId: sku.id,
                    visibility,
                    acquiredAt: now,
                },
                update: { archivedAt: null },
            });

            // Link the token to what it bought. Inside the transaction, so a
            // CONSUMED token without a claimId is never a state that commits.
            if (tokenId) {
                await tx.claimToken.update({
                    where: { id: tokenId },
                    data: { claimId: claim.id },
                });
            }

            return { lost: false, claim, ledger, ownerId: userId, tokenId };
        }, {
            // Remote (Neon) round-trips add up; the default 5s is too tight.
            maxWait: 10_000,
            timeout: 20_000,
        });
    }
}

/**
 * Turns a failed compare-and-swap into the reason it failed.
 *
 * Runs only on the rejection path, so the happy path pays nothing for it. The
 * order of the checks is the order of what the caller most needs to know, and
 * it is deliberate: a token that is both spent and expired reads as REUSED,
 * because "you already used this" is the true and more useful answer.
 */
function rejectionFor(
    row: Prisma.ClaimTokenGetPayload<{ select: typeof tokenRejectionSelect }> | null,
    context: { skuId: string; userId: string; now: Date },
): ClaimTokenRejectedError {
    if (!row) {
        return new ClaimTokenRejectedError('INVALID', null, 'no token row for that hash');
    }

    // Wrong item or wrong person. Reported as INVALID rather than as its own
    // code: distinguishing them would let a caller probe which tokens exist
    // and who holds them.
    if (row.skuId !== context.skuId) {
        return new ClaimTokenRejectedError('INVALID', row.id, 'token belongs to another sku');
    }
    if (row.userId !== context.userId) {
        return new ClaimTokenRejectedError('INVALID', row.id, 'token belongs to another user');
    }

    if (row.consumedAt !== null || row.status === 'CONSUMED') {
        return new ClaimTokenRejectedError('REUSED', row.id, 'token already consumed');
    }
    if (row.status === 'LOST_TIEBREAK') {
        return new ClaimTokenRejectedError('REUSED', row.id, 'token lost a tiebreak');
    }
    if (row.status === 'SUPERSEDED') {
        return new ClaimTokenRejectedError('REUSED', row.id, 'token superseded by a later validate');
    }
    if (row.status === 'EXPIRED' || row.expiresAt <= context.now) {
        return new ClaimTokenRejectedError('EXPIRED', row.id, 'token past its ttl');
    }

    // ISSUED, unexpired, right owner, right item — and the swap still matched
    // nothing. Another transaction consumed it in between, so it is spent.
    return new ClaimTokenRejectedError('REUSED', row.id, 'consumed by a concurrent request');
}

/** The seq-0 MINT row for a SKU. Shared by the eager and lazy origin paths. */
function mintRow(input: {
    sku: SkuForTag;
    hash: string;
    dateTime: Date;
}): Prisma.BlockchainLedgerUncheckedCreateInput {
    const payload: LedgerPayload = { ownerLabel: LEDGER_ORIGIN_OWNER };
    return {
        id: randomUUID(),
        skuId: input.sku.id,
        txType: 'MINT',
        sequenceNo: 0,
        previousHash: null,
        currentHash: input.hash,
        sellerDigitalSignature: `sig_hitbox_${input.sku.drop.groupCode}`,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdAt: input.dateTime,
    };
}

/**
 * Shared display helper — "@handle" style, falling back to full name.
 *
 * `User.username`/`firstName`/`lastName` were replaced by `handle` and
 * `fullName` in the users restructure.
 */
export function displayNameOf(
    user: Pick<User, 'handle' | 'fullName'> | null | undefined,
): string | null {
    if (!user) return null;
    if (user.handle) return user.handle;
    return user.fullName?.trim() || null;
}

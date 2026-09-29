import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import type { User } from '@hitbox/database';
import {
    CLAIM_CODE_DIGITS,
    CLAIM_CODE_MAX_ATTEMPTS,
    CLAIM_CODE_PREFIX,
    CLAIM_OUTCOME,
    CLAIMS_ERROR_CODES,
    CLAIMS_EVENTS,
    CLAIMS_METRICS,
} from '../constants/claims.constant';
import {
    claimTokenExpiry,
    ClaimTokenRejectedError,
    generateClaimToken,
    hashClaimToken,
    isClaimTokenRejected,
} from '../domain/claim-token';
import type { IMediaUrlResolver } from '../domain/interfaces/media-url-resolver.interface';
import type {
    ClaimBodyDto,
    ClaimFlowResult,
    LedgerEntryView,
    OwnerView,
    ValidateResult,
    VerifyResult,
} from '../dto/claims.dto';
import {
    basePriceOf,
    ClaimsRepository,
    displayNameOf,
    readLedgerPayload,
    type LedgerRowFull,
    type SkuForTag,
} from '../repository/claims.repository';

interface ClaimsServiceDeps {
    claims: ClaimsRepository;
    eventBus: IEventBus;
    logger: Logger;
    /** Optional: without it, product image URLs come back null. */
    mediaUrls?: IMediaUrlResolver | undefined;
    /**
     * CLAIM_TOKEN_REQUIRED. Off during rollout, so app builds that predate
     * the token keep working; on, a confirm without one is a 400.
     *
     * Only governs a *missing* token. A token that is sent is always checked
     * in full, and the race outcome applies either way.
     */
    claimTokenRequired: boolean;
}

/** Minimal user shape needed to render an owner. */
type OwnerLike = Pick<User, 'id' | 'handle' | 'fullName'>;

function generateClaimCode(): string {
    let digits = '';
    for (let i = 0; i < CLAIM_CODE_DIGITS; i += 1) digits += String(randomInt(0, 10));
    return `${CLAIM_CODE_PREFIX}${digits}`;
}

/**
 * The NFC claim flow.
 *
 * Every route is keyed by a tag, and a tag now identifies a **SKU** — one
 * serialized item — rather than a product. That is the whole shape of this
 * restructure: claim state, ownership and the provenance chain all live per
 * item, so two buyers holding copies #7 and #8 of the same drop no longer
 * share one claim record and one ledger.
 */
export class ClaimsService {
    constructor(private readonly deps: ClaimsServiceDeps) { }

    /** GET /verify/:tagId — read-only authenticity + ownership check. */
    async verify(tagId: string): Promise<VerifyResult> {
        const sku = await this.requireSku(tagId);
        const ledger = await this.deps.claims.getLedger(sku.id);
        return {
            valid: true,
            skuId: sku.id,
            skuCode: sku.skuCode,
            serialNumber: sku.serialNumber,
            productId: sku.drop.id,
            groupCode: sku.drop.groupCode,
            name: sku.drop.name,
            claimed: sku.claimedStatus === 'CLAIMED',
            claimedStatus: sku.claimedStatus,
            status: sku.drop.status,
            owner: this.ownerView(sku.owner),
            ledgerLength: ledger.length,
            verifiedAt: new Date().toISOString(),
        };
    }

    /** GET /ledger/:tagId — the raw provenance chain for one SKU. */
    async ledger(tagId: string): Promise<LedgerEntryView[]> {
        const sku = await this.requireSku(tagId);
        const rows = await this.deps.claims.getLedger(sku.id);
        return rows.map((row) => this.ledgerView(row));
    }

    /**
     * Create the "First Time" origin record for a tagged SKU, so its ledger
     * shows the HitBox origin before anyone claims. A no-op for SKUs without
     * an NFC tag.
     *
     * Previously driven by the `products.product.created` event. That no
     * longer works: a product carries no tag, and its SKUs do not exist yet
     * when it is created. The skus module owns tag provisioning and should
     * call this when it binds a tag — until it publishes an event, the MINT
     * row is written lazily inside the claim transaction instead, so a chain
     * is never missing its origin.
     */
    async ensureOriginForSku(skuId: string): Promise<void> {
        const sku = await this.deps.claims.findSkuById(skuId);
        if (!sku || !sku.tagId) return;
        await this.deps.claims.ensureOriginRecord(sku);
    }

    /**
     * POST /claims/:tagId — validate step. Reads the tag + ownership and tells
     * the app which screen to show. Does NOT claim anything. 404 if the tag is
     * not registered to any SKU.
     */
    async validate(tagId: string, userId: string, requestId?: string | null): Promise<ValidateResult> {
        const sku = await this.requireSku(tagId);
        const claimed = sku.claimedStatus === 'CLAIMED';
        const claimedByYou = claimed && sku.ownerId === userId;
        const screen: ValidateResult['screen'] = !claimed
            ? 'CLAIMABLE'
            : claimedByYou
                ? 'ALREADY_CLAIMED_BY_YOU'
                : 'ALREADY_CLAIMED';
        const price = basePriceOf(sku);

        // A token is only minted for a screen that can lead to a claim.
        // Issuing one for an already-claimed item would hand out a credential
        // for something that can never happen — and would leave a live token
        // lying around for the moment the item is revoked back to UNCLAIMED.
        const token =
            screen === 'CLAIMABLE'
                ? await this.issueToken(sku.id, userId, requestId ?? null)
                : null;

        return {
            tagId,
            screen,
            claimedByYou,
            sku: {
                id: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                tagId: sku.tagId,
            },
            product: {
                id: sku.drop.id,
                groupCode: sku.drop.groupCode,
                name: sku.drop.name,
                priceInDollars: price?.amount ?? null,
                currency: price?.currency ?? null,
                status: sku.drop.status,
                imageUrl: this.imageUrlOf(sku),
            },
            owner: this.ownerView(sku.owner),
            claimedAt: this.claimedAtOf(sku),
            claimToken: token?.token ?? null,
            claimTokenExpiresAt: token?.expiresAt.toISOString() ?? null,
        };
    }

    /**
     * Mints a token, stores only its hash, and hands the raw value back once.
     *
     * The raw token is returned to this caller and never written anywhere —
     * not to the row, not to a log line. If the client loses it, the answer is
     * to validate again, not to look it up.
     */
    private async issueToken(
        skuId: string,
        userId: string,
        requestId: string | null,
    ): Promise<{ token: string; expiresAt: Date }> {
        const now = new Date();
        const raw = generateClaimToken();
        const issued = await this.deps.claims.issueClaimToken({
            skuId,
            userId,
            tokenHash: hashClaimToken(raw),
            now,
            expiresAt: claimTokenExpiry(now),
            requestId,
        });
        return { token: raw, expiresAt: issued.expiresAt };
    }

    /**
     * POST /claims/:tagId/confirm — perform the claim.
     *
     * - Unclaimed → claim it for the caller, who becomes the owner (`CLAIMED`).
     * - Already claimed → don't error; report the current owner's name so the
     *   app can show "already claimed by <name>" (`ALREADY_CLAIMED`).
     */
    async claim(tagId: string, userId: string, body: ClaimBodyDto): Promise<ClaimFlowResult> {
        const sku = await this.requireSku(tagId);
        const tokenHash = this.resolveTokenHash(sku.id, userId, body.claimToken);

        // The item's state as of *now*, before the token is spent. Two things
        // depend on it, and it has to be captured here:
        //
        //   - There is deliberately no early `if (CLAIMED) return` any more.
        //     That return was the replay hole: a captured confirm sent at a
        //     claimed item got a friendly 200 and its token was never looked
        //     at, so the token stayed ISSUED — and the moment a refund revoked
        //     the claim and put the unit back to UNCLAIMED, the same captured
        //     request worked. Every confirm now goes through the token check.
        //
        //   - It is what separates a race from an old claim further down.
        //     Both arrive at the same place (the SKU flip matches nothing),
        //     and after the fact they are indistinguishable — the row just
        //     says CLAIMED either way.
        const claimedBeforeWeStarted = sku.claimedStatus === 'CLAIMED';

        const now = new Date();
        // Fetch the claimer once, before the transaction (keeps the tx short).
        const me = await this.deps.claims.findUserById(userId);
        const ownerLabel = displayNameOf(me) ?? userId;

        for (let attempt = 1; attempt <= CLAIM_CODE_MAX_ATTEMPTS; attempt += 1) {
            try {
                const result = await this.deps.claims.claimByTag({
                    sku,
                    userId,
                    ownerLabel,
                    claimCode: generateClaimCode(),
                    visibility: body.visibility,
                    now,
                    tokenHash,
                });

                if (result.lost) {
                    // Re-read to name whoever holds it now.
                    const fresh = await this.deps.claims.findSkuByTagId(tagId);
                    const winner = fresh?.owner ?? null;

                    // Race, or an old claim? The discriminator is the status
                    // read at the top of this request, before the token was
                    // spent: UNCLAIMED then and CLAIMED now means it changed
                    // hands while this request was in flight, which is the
                    // simultaneous tap. Already CLAIMED then means it was
                    // someone else's before the caller ever tapped, and
                    // telling them they "just" lost would be a lie.
                    if (claimedBeforeWeStarted) {
                        return this.alreadyClaimed(fresh ?? sku, winner, userId);
                    }

                    await this.reportTiebreakLost({
                        skuId: sku.id,
                        loserUserId: userId,
                        winnerUserId: winner?.id ?? null,
                        tokenId: result.tokenId,
                        at: now,
                    });

                    return this.claimedByOtherJustNow(fresh ?? sku, winner);
                }

                await this.deps.eventBus.publish(CLAIMS_EVENTS.PRODUCT_CLAIMED, {
                    claimId: result.claim.id,
                    skuId: sku.id,
                    productId: sku.drop.id,
                    userId,
                });

                return {
                    outcome: CLAIM_OUTCOME.CLAIMED,
                    claimedByYou: true,
                    message: `You claimed "${sku.drop.name}". You now own it.`,
                    owner: this.ownerView(me) ?? { id: userId, handle: null, displayName: null },
                    sku: {
                        id: sku.id,
                        skuCode: sku.skuCode,
                        serialNumber: sku.serialNumber,
                        tagId: sku.tagId,
                        claimedStatus: 'CLAIMED',
                    },
                    product: {
                        id: sku.drop.id,
                        groupCode: sku.drop.groupCode,
                        name: sku.drop.name,
                    },
                    claimedAt: result.claim.claimedAt.toISOString(),
                    claim: {
                        id: result.claim.id,
                        claimCode: result.claim.claimCode,
                        claimedNo: result.claim.claimedNo,
                    },
                };
            } catch (error) {
                if (isClaimTokenRejected(error)) {
                    // The transaction rolled back, so nothing was written and
                    // the item is untouched. Turn it into the right HTTP
                    // answer, after recording that it happened.
                    throw await this.handleTokenRejection(error, sku.id, userId, now);
                }
                if (this.isClaimCodeCollision(error) && attempt < CLAIM_CODE_MAX_ATTEMPTS) {
                    // The rollback also undid the token consumption, so the
                    // retry re-enters the transaction with the token back at
                    // ISSUED and consumes it cleanly.
                    this.deps.logger.warn({ attempt }, 'claimCode collision — retrying');
                    continue;
                }
                throw error;
            }
        }
        throw AppError.conflict(
            'Could not allocate a unique claim code',
            CLAIMS_ERROR_CODES.CLAIM_CODE_TAKEN,
        );
    }

    // ── token helpers ─────────────────────────────────────────────────────

    /**
     * Decides what to do about the token on a confirm, and returns the hash to
     * check — or null to skip the check entirely.
     *
     * The rollout flag lives here rather than in the DTO because "no token" is
     * a policy question, not a shape question. With the flag off a missing
     * token is the old behaviour plus a log line; with it on, it is a 400. A
     * token that *is* sent is always checked in full either way — there is no
     * mode in which a presented token is ignored, because a client that sends
     * one has already been told the item is claimable and should not silently
     * fall back to the unauthenticated path.
     */
    private resolveTokenHash(
        skuId: string,
        userId: string,
        claimToken: string | undefined,
    ): string | null {
        if (claimToken) return hashClaimToken(claimToken);

        if (this.deps.claimTokenRequired) {
            throw AppError.badRequest(
                'This claim needs a claim token. Tap the item again to start a new claim.',
                CLAIMS_ERROR_CODES.TOKEN_INVALID,
            );
        }

        this.deps.logger.info(
            { metric: CLAIMS_METRICS.TOKEN_MISSING, skuId, userId },
            'confirm arrived with no claim token — accepted because CLAIM_TOKEN_REQUIRED is off',
        );
        return null;
    }

    /**
     * Records a rejected token and maps it to the HTTP answer.
     *
     * The status codes are not interchangeable. 409 says "this was valid and
     * is spent" — the client should re-validate. 410 says the same about time
     * rather than use. 400 says the token was never ours. A client can act on
     * each; a single 403 for all three would leave it guessing.
     */
    private async handleTokenRejection(
        error: ClaimTokenRejectedError,
        skuId: string,
        userId: string,
        now: Date,
    ): Promise<AppError> {
        this.deps.logger.warn(
            {
                metric: CLAIMS_METRICS.TOKEN_REJECTED,
                skuId,
                userId,
                reason: error.reason,
                tokenId: error.tokenId,
                // The sub-reason is logged and never returned: which of
                // "wrong user" / "wrong item" / "never existed" it was would
                // tell a prober whether a token exists and who holds it.
                detail: error.detail ?? null,
            },
            'claim token rejected',
        );

        if (error.tokenId) {
            // Best-effort by design — the rejection already stands, and the
            // counter is analytics. Failing the request because we could not
            // increment it would turn a correct refusal into a 500.
            try {
                await this.deps.claims.markTokenReplay({
                    tokenId: error.tokenId,
                    now,
                    expired: error.reason === 'EXPIRED',
                });
            } catch (markError) {
                this.deps.logger.error(
                    { err: markError, tokenId: error.tokenId },
                    'could not record the token replay — the rejection still stands',
                );
            }
        }

        try {
            await this.deps.eventBus.publish(CLAIMS_EVENTS.TOKEN_REJECTED, {
                skuId,
                userId,
                reason: error.reason,
                tokenId: error.tokenId,
                at: now.toISOString(),
            });
        } catch (publishError) {
            this.deps.logger.error({ err: publishError }, 'could not publish claims.token.rejected');
        }

        switch (error.reason) {
            case 'REUSED':
                return AppError.conflict(
                    'This claim link has already been used. Tap the item again.',
                    CLAIMS_ERROR_CODES.TOKEN_REUSED,
                );
            case 'EXPIRED':
                // 410 Gone: it existed, it was valid, and time took it. Built
                // directly because AppError has no `gone()` shorthand — the
                // constructor takes any status and `isOperational` is
                // status < 500, so this behaves like the other 4xx helpers.
                return new AppError(
                    'This claim link has expired. Tap the item again.',
                    410,
                    CLAIMS_ERROR_CODES.TOKEN_EXPIRED,
                );
            case 'INVALID':
            default:
                return AppError.badRequest(
                    'This claim link is not valid. Tap the item again to start a new claim.',
                    CLAIMS_ERROR_CODES.TOKEN_INVALID,
                );
        }
    }

    /** Counts a lost race. Never throws — the caller already has its answer. */
    private async reportTiebreakLost(input: {
        skuId: string;
        loserUserId: string;
        winnerUserId: string | null;
        tokenId: string | null;
        at: Date;
    }): Promise<void> {
        this.deps.logger.info(
            {
                metric: CLAIMS_METRICS.TIEBREAK_LOST,
                skuId: input.skuId,
                loserUserId: input.loserUserId,
                winnerUserId: input.winnerUserId,
                tokenId: input.tokenId,
            },
            'simultaneous claim — this tap lost the tiebreak',
        );
        try {
            await this.deps.eventBus.publish(CLAIMS_EVENTS.TIEBREAK_LOST, {
                ...input,
                at: input.at.toISOString(),
            });
        } catch (error) {
            this.deps.logger.error({ err: error }, 'could not publish claims.tiebreak.lost');
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /**
     * The losing half of a simultaneous tap.
     *
     * Same facts as `alreadyClaimed`, different outcome and different words.
     * Worth the duplication: "this belongs to someone else" and "someone beat
     * you to it by a moment" are the same row in the database and completely
     * different things to be told while you are still holding your phone
     * against the item.
     */
    private claimedByOtherJustNow(sku: SkuForTag, winner: OwnerLike | null): ClaimFlowResult {
        return {
            outcome: CLAIM_OUTCOME.CLAIMED_BY_OTHER_JUST_NOW,
            claimedByYou: false,
            message: 'This item was just claimed by someone else.',
            owner: this.ownerView(winner) ?? { id: '', handle: null, displayName: null },
            sku: {
                id: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                tagId: sku.tagId,
                claimedStatus: 'CLAIMED',
            },
            product: {
                id: sku.drop.id,
                groupCode: sku.drop.groupCode,
                name: sku.drop.name,
            },
            claimedAt: this.claimedAtOf(sku),
            claim: null,
        };
    }

    private alreadyClaimed(
        sku: SkuForTag,
        owner: OwnerLike | null,
        callerId: string,
    ): ClaimFlowResult {
        const claimedByYou = owner?.id === callerId;
        const ownerName = displayNameOf(owner) ?? 'another collector';
        return {
            outcome: CLAIM_OUTCOME.ALREADY_CLAIMED,
            claimedByYou,
            message: claimedByYou
                ? `You already own "${sku.drop.name}".`
                : `"${sku.drop.name}" is already claimed by ${ownerName}.`,
            owner: this.ownerView(owner) ?? { id: '', handle: null, displayName: null },
            sku: {
                id: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                tagId: sku.tagId,
                claimedStatus: 'CLAIMED',
            },
            product: {
                id: sku.drop.id,
                groupCode: sku.drop.groupCode,
                name: sku.drop.name,
            },
            claimedAt: this.claimedAtOf(sku),
            claim: null,
        };
    }

    /**
     * Takes a claim back — the claims side of payments' `IClaimRevocation`.
     *
     * The design document's day-21 step: a refunded collectible whose claim
     * still stands would leave someone holding the certificate of authenticity
     * for an object they returned, and nothing would stop them listing it for
     * resale. So the claim is revoked, the owner cleared, and — if the tag came
     * back damaged, missing or tampered with — the unit is quarantined for the
     * window the refund workflow computed.
     *
     * Nothing is deleted. The claim row keeps its timestamp and gains a
     * revocation; the hash chain gains a FLAG row rather than losing its CLAIM
     * row. Provenance that can be edited is not provenance.
     *
     * A unit that was never claimed returns `revoked: false` and is not an
     * error: refunding an order whose buyer never tapped the tag is ordinary.
     */
    async revokeClaim(input: {
        skuId: string;
        claimId?: string | null;
        reason: string;
        actorId: string | null;
        resaleBlockedUntil: Date | null;
    }): Promise<{ revoked: boolean; claimId: string | null; ledgerEntryId: string | null }> {
        const sku = await this.deps.claims.findSkuById(input.skuId);
        if (!sku) {
            throw AppError.notFound(
                'No serialized unit with that id',
                CLAIMS_ERROR_CODES.TAG_NOT_FOUND,
            );
        }

        const result = await this.deps.claims.revokeClaim({
            sku,
            claimId: input.claimId ?? null,
            reason: input.reason,
            resaleBlockedUntil: input.resaleBlockedUntil,
            now: new Date(),
        });

        if (!result) {
            this.deps.logger.info(
                { skuId: input.skuId },
                'claim revocation had nothing to revoke — the unit was not claimed',
            );
            return { revoked: false, claimId: null, ledgerEntryId: null };
        }

        this.deps.logger.info(
            {
                skuId: input.skuId,
                claimId: result.claimId,
                actorId: input.actorId,
                resaleBlockedUntil: input.resaleBlockedUntil?.toISOString() ?? null,
            },
            'claim revoked',
        );

        await this.deps.eventBus.publish(CLAIMS_EVENTS.CLAIM_REVOKED, {
            skuId: input.skuId,
            claimId: result.claimId,
            reason: input.reason,
            actorId: input.actorId,
            resaleBlockedUntil: input.resaleBlockedUntil?.toISOString() ?? null,
        });

        return { revoked: true, claimId: result.claimId, ledgerEntryId: result.ledgerEntryId };
    }

    private async requireSku(tagId: string): Promise<SkuForTag> {
        const sku = await this.deps.claims.findSkuByTagId(tagId);
        if (!sku) {
            throw AppError.notFound(
                'No item is registered to this NFC tag',
                CLAIMS_ERROR_CODES.TAG_NOT_FOUND,
            );
        }
        return sku;
    }

    /** `Sku` has no claimedAt column — the most recent claim row is the record. */
    private claimedAtOf(sku: SkuForTag): string | null {
        return sku.skuClaims[0]?.claimedAt.toISOString() ?? null;
    }

    private imageUrlOf(sku: SkuForTag): string | null {
        const ref = sku.drop.dropImages[0]?.asset.storageRef;
        if (!ref) return null;
        return this.deps.mediaUrls?.publicUrl(ref) ?? null;
    }

    private ownerView(owner: OwnerLike | null | undefined): OwnerView | null {
        if (!owner) return null;
        return { id: owner.id, handle: owner.handle, displayName: displayNameOf(owner) };
    }

    private ledgerView(row: LedgerRowFull): LedgerEntryView {
        // Participants and the owner label live in `payload` now — the current
        // BlockchainLedger has no user foreign keys.
        const payload = readLedgerPayload(row.payload);
        const isClaim = payload.claimId !== undefined;
        return {
            sequenceNo: row.sequenceNo,
            txType: row.txType,
            productId: row.sku.drop.groupCode,
            tag: row.sku.tagId,
            ownerId: payload.ownerLabel,
            dateTime: row.createdAt.toISOString(),
            hash: row.currentHash,
            previousHash: row.previousHash,
            claimHistory: isClaim,
            peerToPeerTrading: isClaim,
        };
    }

    private isClaimCodeCollision(error: unknown): boolean {
        return (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002' &&
            (Array.isArray(error.meta?.target)
                ? (error.meta?.target as string[]).some((t) => t.includes('claimCode') || t.includes('claim_code'))
                : String(error.meta?.target ?? '').includes('claim'))
        );
    }
}

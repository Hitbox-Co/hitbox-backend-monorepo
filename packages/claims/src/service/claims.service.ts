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
} from '../constants/claims.constant';
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
            productId: sku.product.id,
            groupCode: sku.product.groupCode,
            name: sku.product.name,
            claimed: sku.claimedStatus === 'CLAIMED',
            claimedStatus: sku.claimedStatus,
            status: sku.product.status,
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
    async validate(tagId: string, userId: string): Promise<ValidateResult> {
        const sku = await this.requireSku(tagId);
        const claimed = sku.claimedStatus === 'CLAIMED';
        const claimedByYou = claimed && sku.ownerId === userId;
        const screen: ValidateResult['screen'] = !claimed
            ? 'CLAIMABLE'
            : claimedByYou
                ? 'ALREADY_CLAIMED_BY_YOU'
                : 'ALREADY_CLAIMED';
        const price = basePriceOf(sku);
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
                id: sku.product.id,
                groupCode: sku.product.groupCode,
                name: sku.product.name,
                priceInDollars: price?.amount ?? null,
                currency: price?.currency ?? null,
                status: sku.product.status,
                imageUrl: this.imageUrlOf(sku),
            },
            owner: this.ownerView(sku.owner),
            claimedAt: this.claimedAtOf(sku),
        };
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

        if (sku.claimedStatus === 'CLAIMED') {
            return this.alreadyClaimed(sku, sku.owner, userId);
        }

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
                });

                if (!result) {
                    // Lost the race — re-read and report whoever won.
                    const fresh = await this.deps.claims.findSkuByTagId(tagId);
                    return this.alreadyClaimed(fresh ?? sku, fresh?.owner ?? null, userId);
                }

                await this.deps.eventBus.publish(CLAIMS_EVENTS.PRODUCT_CLAIMED, {
                    claimId: result.claim.id,
                    skuId: sku.id,
                    productId: sku.product.id,
                    userId,
                });

                return {
                    outcome: CLAIM_OUTCOME.CLAIMED,
                    claimedByYou: true,
                    message: `You claimed "${sku.product.name}". You now own it.`,
                    owner: this.ownerView(me) ?? { id: userId, handle: null, displayName: null },
                    sku: {
                        id: sku.id,
                        skuCode: sku.skuCode,
                        serialNumber: sku.serialNumber,
                        tagId: sku.tagId,
                        claimedStatus: 'CLAIMED',
                    },
                    product: {
                        id: sku.product.id,
                        groupCode: sku.product.groupCode,
                        name: sku.product.name,
                    },
                    claimedAt: result.claim.claimedAt.toISOString(),
                    claim: {
                        id: result.claim.id,
                        claimCode: result.claim.claimCode,
                        claimedNo: result.claim.claimedNo,
                    },
                };
            } catch (error) {
                if (this.isClaimCodeCollision(error) && attempt < CLAIM_CODE_MAX_ATTEMPTS) {
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

    // ── helpers ───────────────────────────────────────────────────────────

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
                ? `You already own "${sku.product.name}".`
                : `"${sku.product.name}" is already claimed by ${ownerName}.`,
            owner: this.ownerView(owner) ?? { id: '', handle: null, displayName: null },
            sku: {
                id: sku.id,
                skuCode: sku.skuCode,
                serialNumber: sku.serialNumber,
                tagId: sku.tagId,
                claimedStatus: 'CLAIMED',
            },
            product: {
                id: sku.product.id,
                groupCode: sku.product.groupCode,
                name: sku.product.name,
            },
            claimedAt: this.claimedAtOf(sku),
            claim: null,
        };
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
        return sku.productClaims[0]?.claimedAt.toISOString() ?? null;
    }

    private imageUrlOf(sku: SkuForTag): string | null {
        const ref = sku.product.productImages[0]?.asset.storageRef;
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
            productId: row.sku.product.groupCode,
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

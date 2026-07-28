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
    LEDGER_ORIGIN_OWNER,
} from '../constants/claims.constant';
import type {
    ClaimBodyDto,
    ClaimFlowResult,
    LedgerEntryView,
    OwnerView,
    ValidateResult,
    VerifyResult,
} from '../dto/claims.dto';
import {
    ClaimsRepository,
    displayNameOf,
    type LedgerRowFull,
    type ProductForTag,
} from '../repository/claims.repository';

interface ClaimsServiceDeps {
    claims: ClaimsRepository;
    eventBus: IEventBus;
    logger: Logger;
}

/** Minimal user shape needed to render an owner. */
type OwnerLike = Pick<User, 'id' | 'username' | 'firstName' | 'lastName'>;

function generateClaimCode(): string {
    let digits = '';
    for (let i = 0; i < CLAIM_CODE_DIGITS; i += 1) digits += String(randomInt(0, 10));
    return `${CLAIM_CODE_PREFIX}${digits}`;
}

export class ClaimsService {
    constructor(private readonly deps: ClaimsServiceDeps) { }

    /** GET /verify/:tagId — read-only authenticity + ownership check. */
    async verify(tagId: string): Promise<VerifyResult> {
        const product = await this.requireProduct(tagId);
        const ledger = await this.deps.claims.getLedger(product.id);
        return {
            valid: true,
            productId: product.id,
            productCode: product.productCode,
            name: product.name,
            claimed: product.claimedStatus === 'CLAIMED',
            claimedStatus: product.claimedStatus,
            state: product.state,
            owner: this.ownerView(product.owner),
            ledgerLength: ledger.length,
            verifiedAt: new Date().toISOString(),
        };
    }

    /** GET /ledger/:tagId — the raw provenance chain for a product. */
    async ledger(tagId: string): Promise<LedgerEntryView[]> {
        const product = await this.requireProduct(tagId);
        const rows = await this.deps.claims.getLedger(product.id);
        return rows.map((row) => this.ledgerView(row));
    }

    /**
     * Create the "First Time" origin record for a tagged product, so its ledger
     * shows the HitBox origin before anyone claims. Called by the product-created
     * event subscriber; a no-op for products without an NFC tag.
     */
    async ensureOriginForProduct(productId: string): Promise<void> {
        const product = await this.deps.claims.findProductById(productId);
        if (!product || !product.tagId) return;
        await this.deps.claims.ensureOriginRecord(product);
    }

    /**
     * POST /claims/:tagId — validate step. Reads the tag + ownership and tells
     * the app which screen to show. Does NOT claim anything. 404 if the tag is
     * not registered to any product.
     */
    async validate(tagId: string, userId: string): Promise<ValidateResult> {
        const product = await this.requireProduct(tagId);
        const claimed = product.claimedStatus === 'CLAIMED';
        const claimedByYou = claimed && product.ownerId === userId;
        const screen: ValidateResult['screen'] = !claimed
            ? 'CLAIMABLE'
            : claimedByYou
                ? 'ALREADY_CLAIMED_BY_YOU'
                : 'ALREADY_CLAIMED';
        return {
            tagId,
            screen,
            claimedByYou,
            product: {
                id: product.id,
                productCode: product.productCode,
                name: product.name,
                tagId: product.tagId,
                priceInDollars: product.priceInDollars.toString(),
                rewardPoints: product.rewardPoints,
                state: product.state,
                imageUrl: product.images[0]?.url ?? null,
            },
            owner: this.ownerView(product.owner),
            claimedAt: product.claimedAt?.toISOString() ?? null,
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
        const product = await this.requireProduct(tagId);

        if (product.claimedStatus === 'CLAIMED') {
            return this.alreadyClaimed(product, product.owner, userId);
        }

        const now = new Date();
        // Fetch the claimer once, before the transaction (keeps the tx short).
        const me = await this.deps.claims.findUserById(userId);
        const ownerLabel = displayNameOf(me) ?? userId;

        for (let attempt = 1; attempt <= CLAIM_CODE_MAX_ATTEMPTS; attempt += 1) {
            try {
                const result = await this.deps.claims.claimByTag({
                    product,
                    userId,
                    ownerLabel,
                    claimCode: generateClaimCode(),
                    visibility: body.visibility,
                    now,
                });

                if (!result) {
                    // Lost the race — re-read and report whoever won.
                    const fresh = await this.deps.claims.findProductByTagId(tagId);
                    return this.alreadyClaimed(fresh ?? product, fresh?.owner ?? null, userId);
                }

                await this.deps.eventBus.publish(CLAIMS_EVENTS.PRODUCT_CLAIMED, {
                    claimId: result.claim.id,
                    productId: product.id,
                    userId,
                });

                return {
                    outcome: CLAIM_OUTCOME.CLAIMED,
                    claimedByYou: true,
                    message: `You claimed "${product.name}". You now own it.`,
                    owner: this.ownerView(me) ?? { id: userId, username: null, displayName: null },
                    product: {
                        id: product.id,
                        productCode: product.productCode,
                        name: product.name,
                        tagId: product.tagId,
                        claimedStatus: 'CLAIMED',
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
        product: Pick<ProductForTag, 'id' | 'productCode' | 'name' | 'tagId' | 'claimedAt'>,
        owner: OwnerLike | null,
        callerId: string,
    ): ClaimFlowResult {
        const claimedByYou = owner?.id === callerId;
        const ownerName = displayNameOf(owner) ?? 'another collector';
        return {
            outcome: CLAIM_OUTCOME.ALREADY_CLAIMED,
            claimedByYou,
            message: claimedByYou
                ? `You already own "${product.name}".`
                : `"${product.name}" is already claimed by ${ownerName}.`,
            owner: this.ownerView(owner) ?? { id: '', username: null, displayName: null },
            product: {
                id: product.id,
                productCode: product.productCode,
                name: product.name,
                tagId: product.tagId,
                claimedStatus: 'CLAIMED',
            },
            claimedAt: product.claimedAt?.toISOString() ?? null,
            claim: null,
        };
    }

    private async requireProduct(tagId: string): Promise<ProductForTag> {
        const product = await this.deps.claims.findProductByTagId(tagId);
        if (!product) {
            throw AppError.notFound(
                'No product is registered to this NFC tag',
                CLAIMS_ERROR_CODES.TAG_NOT_FOUND,
            );
        }
        return product;
    }

    private ownerView(owner: OwnerLike | null | undefined): OwnerView | null {
        if (!owner) return null;
        return { id: owner.id, username: owner.username, displayName: displayNameOf(owner) };
    }

    private ledgerView(row: LedgerRowFull): LedgerEntryView {
        // Owner Id: "HitBox" for the origin record, else the recorded owner.
        const ownerId = row.toUser ? displayNameOf(row.toUser) ?? row.originOwner : row.originOwner;
        const isClaim = row.claimId !== null;
        return {
            sequenceNo: row.sequenceNo,
            txType: row.txType,
            productId: row.originProduct.productCode,
            tag: row.originProduct.tagId,
            ownerId,
            dateTime: row.transactionDateTime.toISOString(),
            hash: row.productBuyerHash,
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

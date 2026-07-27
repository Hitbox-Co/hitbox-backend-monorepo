import { Prisma } from '@hitbox/database';
import type { PrismaClient, ProductClaim, User } from '@hitbox/database';
import { LEDGER_ORIGIN_OWNER } from '../constants/claims.constant';
import { computeLedgerHash } from '../domain/ledger-hash';

// Product projection needed to verify a tag and drive the claim flow.
const productByTagInclude = {
    owner: { select: { id: true, username: true, firstName: true, lastName: true } },
    collection: { select: { id: true, artistId: true } },
    images: { take: 1, select: { url: true } },
} satisfies Prisma.ProductInclude;

export type ProductForTag = Prisma.ProductGetPayload<{ include: typeof productByTagInclude }>;

// Ledger row with the owner endpoints AND the product's code/tag resolved, so
// each row can render self-contained per the demo ledger spec.
const ledgerInclude = {
    fromUser: { select: { id: true, username: true, firstName: true, lastName: true } },
    toUser: { select: { id: true, username: true, firstName: true, lastName: true } },
    originProduct: { select: { productCode: true, tagId: true } },
} satisfies Prisma.BlockchainLedgerInclude;

export type LedgerRowFull = Prisma.BlockchainLedgerGetPayload<{ include: typeof ledgerInclude }>;

export interface ClaimTxParams {
    product: ProductForTag;
    userId: string;
    /** Owner label recorded on the CLAIM row's hash (the claimer's display name). */
    ownerLabel: string;
    claimCode: string;
    visibility: 'PUBLIC' | 'PRIVATE';
    now: Date;
}

export interface ClaimTxResult {
    claim: ProductClaim;
    ledger: LedgerRowFull;
    ownerId: string;
}

export class ClaimsRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findProductByTagId(tagId: string): Promise<ProductForTag | null> {
        return this.prisma.product.findUnique({
            where: { tagId },
            include: productByTagInclude,
        });
    }

    findProductById(id: string): Promise<ProductForTag | null> {
        return this.prisma.product.findUnique({
            where: { id },
            include: productByTagInclude,
        });
    }

    findUserById(id: string): Promise<User | null> {
        return this.prisma.user.findUnique({ where: { id } });
    }

    /** Ordered provenance chain for a product (seq 0 first). */
    getLedger(productId: string): Promise<LedgerRowFull[]> {
        return this.prisma.blockchainLedger.findMany({
            where: { originProductId: productId },
            orderBy: { sequenceNo: 'asc' },
            include: ledgerInclude,
        });
    }

    /**
     * The "First Time" origin record (seq 0, owner = HitBox, no claim). Created
     * up front for every tagged product so its ledger shows the origin before
     * anyone claims. Idempotent — a no-op if the origin row already exists.
     */
    async ensureOriginRecord(product: ProductForTag): Promise<void> {
        const exists = await this.prisma.blockchainLedger.findFirst({
            where: { originProductId: product.id, sequenceNo: 0 },
            select: { id: true },
        });
        if (exists) return;

        const dateTime = product.releaseDate ?? product.createdAt;
        const hash = computeLedgerHash({
            productId: product.productCode,
            tagId: product.tagId,
            ownerId: LEDGER_ORIGIN_OWNER,
            dateTime: dateTime.toISOString(),
        });
        try {
            await this.prisma.blockchainLedger.create({
                data: {
                    txType: 'MINT',
                    sequenceNo: 0,
                    originDateTime: dateTime,
                    originOwner: LEDGER_ORIGIN_OWNER,
                    sellerDigitalSignature: `sig_hitbox_${product.productCode}`,
                    productBuyerHash: hash,
                    previousHash: null,
                    transactionDateTime: dateTime,
                    transactionAmount: new Prisma.Decimal(0),
                    originProductId: product.id,
                },
            });
        } catch (err) {
            // Unique (originProductId, sequenceNo) — another request won the race.
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
    }

    /**
     * First-time claim, atomic. Returns null if the product was claimed by a
     * concurrent request (the conditional update matched zero rows). May throw
     * Prisma P2002 on a claimCode collision — the service retries with a new code.
     */
    async claimByTag(params: ClaimTxParams): Promise<ClaimTxResult | null> {
        const { product, userId, ownerLabel, claimCode, visibility, now } = params;

        return this.prisma.$transaction(async (tx) => {
            // Race guard: only proceed while the product is still UNCLAIMED.
            const flipped = await tx.product.updateMany({
                where: { id: product.id, claimedStatus: 'UNCLAIMED' },
                data: { claimedStatus: 'CLAIMED', claimedAt: now, ownerId: userId },
            });
            if (flipped.count === 0) return null;

            const priorClaims = await tx.productClaim.count({ where: { productId: product.id } });
            const claim = await tx.productClaim.create({
                data: {
                    claimCode,
                    claimedNo: priorClaims + 1,
                    claimedAt: now,
                    userId,
                    productId: product.id,
                    artistId: product.collection?.artistId ?? null,
                    collectionId: product.collectionId ?? null,
                },
            });

            const originDateTime = product.releaseDate ?? product.createdAt;

            // Ensure the "First Time" origin (MINT, seq 0) row exists first.
            const last = await tx.blockchainLedger.findFirst({
                where: { originProductId: product.id },
                orderBy: { sequenceNo: 'desc' },
            });
            let prevSeq = last?.sequenceNo ?? -1;
            let prevHash = last?.productBuyerHash ?? null;

            if (!last) {
                const mintHash = computeLedgerHash({
                    productId: product.productCode,
                    tagId: product.tagId,
                    ownerId: LEDGER_ORIGIN_OWNER,
                    dateTime: originDateTime.toISOString(),
                });
                await tx.blockchainLedger.create({
                    data: {
                        txType: 'MINT',
                        sequenceNo: 0,
                        originDateTime,
                        originOwner: LEDGER_ORIGIN_OWNER,
                        sellerDigitalSignature: `sig_hitbox_${product.productCode}`,
                        productBuyerHash: mintHash,
                        previousHash: null,
                        transactionDateTime: originDateTime,
                        transactionAmount: new Prisma.Decimal(0),
                        originProductId: product.id,
                    },
                });
                prevSeq = 0;
                prevHash = mintHash;
            }

            // The new CLAIM record — owner is the claimer.
            const claimSeq = prevSeq + 1;
            const claimHash = computeLedgerHash({
                productId: product.productCode,
                tagId: product.tagId,
                ownerId: ownerLabel,
                dateTime: now.toISOString(),
            });
            const ledger = await tx.blockchainLedger.create({
                data: {
                    txType: 'CLAIM',
                    sequenceNo: claimSeq,
                    originDateTime,
                    originOwner: LEDGER_ORIGIN_OWNER,
                    sellerDigitalSignature: `sig_hitbox_${product.productCode}`,
                    buyerDigitalSignature: `sig_buyer_${claim.id}`,
                    receiverPublicKey: `pk_${userId}`,
                    productBuyerHash: claimHash,
                    previousHash: prevHash,
                    transactionDateTime: now,
                    transactionAmount: product.priceInDollars,
                    originProductId: product.id,
                    claimId: claim.id,
                    toUserId: userId,
                },
                include: ledgerInclude,
            });

            // Ownership period + collection entry (the only way items enter a collection).
            await tx.productHistory.create({
                data: {
                    productId: product.id,
                    ownerId: userId,
                    price: product.priceInDollars,
                    ownershipStartDate: now,
                },
            });
            await tx.buyerCollection.upsert({
                where: { userId_productId: { userId, productId: product.id } },
                create: {
                    userId,
                    productId: product.id,
                    genre: product.genre,
                    visibility,
                    totalClaimedNo: 1,
                },
                update: {},
            });

            return { claim, ledger, ownerId: userId };
        }, {
            // Remote (Neon) round-trips add up; the default 5s is too tight.
            maxWait: 10_000,
            timeout: 20_000,
        });
    }
}

/** Shared display helper — "@username" style, falling back to full name. */
export function displayNameOf(
    user: Pick<User, 'username' | 'firstName' | 'lastName'> | null | undefined,
): string | null {
    if (!user) return null;
    if (user.username) return user.username;
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return full || null;
}

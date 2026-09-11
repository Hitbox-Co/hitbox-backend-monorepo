import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, ProductClaim, User } from '@hitbox/database';
import { LEDGER_ORIGIN_OWNER } from '../constants/claims.constant';
import { computeLedgerHash } from '../domain/ledger-hash';

/**
 * The only place in this module that touches Prisma.
 *
 * **The claim subject is a SKU, not a product.** The NFC tag moved from
 * `Product.tagId` to `Sku.tagId`, and with it `claimedStatus` and `ownerId` —
 * which is the correct shape: a tag is glued to one serialized item, not to a
 * catalog entry. Every lookup here starts from `Sku` and reaches the catalog
 * as `sku.product`.
 *
 * `ProductClaim`, `ProductHistory` and `BlockchainLedger` are all keyed by
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
} satisfies Prisma.Product$productPricesArgs;

// SKU projection needed to verify a tag and drive the claim flow.
const skuByTagInclude = {
    owner: { select: { id: true, handle: true, fullName: true } },
    product: {
        select: {
            id: true,
            groupCode: true,
            name: true,
            status: true,
            collectionId: true,
            collection: { select: { id: true, artistId: true } },
            productImages: {
                where: { archivedAt: null },
                orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
                take: 1,
                select: { asset: { select: { storageRef: true } } },
            },
            productPrices: basePriceArgs,
        },
    },
    // Most recent claim, for the "claimed at" timestamp — `Sku` carries no
    // claimedAt column; the claim row is the record of when it happened.
    productClaims: { orderBy: { claimedNo: 'desc' }, take: 1, select: { claimedAt: true } },
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
    sku: { select: { tagId: true, product: { select: { groupCode: true } } } },
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
}

export interface ClaimTxResult {
    claim: ProductClaim;
    ledger: LedgerRowFull;
    ownerId: string;
}

/** The base price of a SKU's product in the default market, or null. */
export function basePriceOf(
    sku: SkuForTag,
): { amount: string; currency: string } | null {
    const price = sku.product.productPrices[0];
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
            productId: sku.product.groupCode,
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
     * First-time claim, atomic. Returns null if the SKU was claimed by a
     * concurrent request (the conditional update matched zero rows). May throw
     * Prisma P2002 on a claimCode collision — the service retries with a new code.
     */
    async claimByTag(params: ClaimTxParams): Promise<ClaimTxResult | null> {
        const { sku, userId, ownerLabel, claimCode, visibility, now } = params;
        const price = basePriceOf(sku);

        return this.prisma.$transaction(async (tx) => {
            // Race guard: only proceed while the SKU is still UNCLAIMED.
            const flipped = await tx.sku.updateMany({
                where: { id: sku.id, claimedStatus: 'UNCLAIMED' },
                data: {
                    claimedStatus: 'CLAIMED',
                    ownerId: userId,
                    claimTokenUsedAt: now,
                    updatedAt: now,
                },
            });
            if (flipped.count === 0) return null;

            // claimedNo counts claims on this SKU — unique [skuId, claimedNo].
            const priorClaims = await tx.productClaim.count({ where: { skuId: sku.id } });
            const claim = await tx.productClaim.create({
                data: {
                    id: randomUUID(),
                    claimCode,
                    claimedNo: priorClaims + 1,
                    claimedAt: now,
                    userId,
                    skuId: sku.id,
                    productId: sku.product.id,
                    artistId: sku.product.collection?.artistId ?? null,
                    collectionId: sku.product.collectionId ?? null,
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
                    productId: sku.product.groupCode,
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
                productId: sku.product.groupCode,
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
                    sellerDigitalSignature: `sig_hitbox_${sku.product.groupCode}`,
                    buyerDigitalSignature: `sig_buyer_${claim.id}`,
                    receiverPublicKey: `pk_${userId}`,
                    payload: payload as unknown as Prisma.InputJsonValue,
                    createdAt: now,
                },
                include: ledgerInclude,
            });

            // Close any open ownership period, then open the new one. Exactly
            // one row per SKU carries isCurrent = true.
            await tx.productHistory.updateMany({
                where: { skuId: sku.id, isCurrent: true },
                data: { isCurrent: false, endedAt: now },
            });
            await tx.productHistory.create({
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

            return { claim, ledger, ownerId: userId };
        }, {
            // Remote (Neon) round-trips add up; the default 5s is too tight.
            maxWait: 10_000,
            timeout: 20_000,
        });
    }
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
        sellerDigitalSignature: `sig_hitbox_${input.sku.product.groupCode}`,
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

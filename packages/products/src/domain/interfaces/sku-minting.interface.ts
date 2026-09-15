import type { Prisma } from '@hitbox/database';

/**
 * Port: mint the serialized units of a drop.
 *
 * Products owns the catalog definition — what a drop is, how many units it
 * *will* have. It does not own `Sku`, which is the skus module's table, so it
 * asks for units through this contract rather than writing them itself.
 *
 * The transaction client is part of the contract on purpose. Creating a drop
 * and minting its edition has to be one atomic act: a product that exists with
 * half an edition minted, and no record of which half, is worse than a failed
 * request. Bootstrap connects @hitbox/skus as the implementation; both modules
 * share one PrismaClient, so the same `tx` is valid on both sides.
 */
export interface ISkuMinting {
    mintWithin(tx: Prisma.TransactionClient, spec: SkuMintSpec): Promise<SkuMintOutcome>;
}

export interface SkuMintSpec {
    productId: string;
    /** The drop's public code; the provider derives each `skuCode` from it. */
    groupCode: string;
    /** Declared edition size. 0 means undeclared, and no cap is applied. */
    totalSupply: number;
    count: number;
    variantId?: string | null | undefined;
}

export interface SkuMintOutcome {
    minted: number;
    firstSerial: number;
    lastSerial: number;
    skuCodes: string[];
    tagsBound: number;
}

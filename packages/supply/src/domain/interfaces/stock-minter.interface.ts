import type { Prisma } from '@hitbox/database';

/**
 * Turns accepted chips into sellable units, as a port.
 *
 * Implemented at the bootstrap boundary on @hitbox/skus' minting core, so the
 * edition's serial numbering, its `totalSupply` cap and the MINT ledger record
 * stay owned by skus — this module only says how many units, of which
 * variant, embedding which chips. Runs inside the accept transaction: if the
 * mint fails (the drop's totalSupply is full, say) the consignment stays
 * undecided and nothing is half-written.
 */
export interface ISupplyStockMinter {
    /**
     * Everything that must hold before units of this drop may exist: the drop
     * has cleared release approval, and each variant group respects the drop
     * type's variant rules and the variant's own cap. Throws an AppError
     * naming the first failure. Read-only — the caps are enforced again
     * inside `mintBound`'s transaction.
     */
    assertMintable(input: {
        productId: string;
        groups: { variantId: string | null; count: number }[];
    }): Promise<void>;

    mintBound(
        tx: Prisma.TransactionClient,
        input: {
            productId: string;
            groupCode: string;
            totalSupply: number;
            variantId: string | null;
            /** One unit per chip, in this order. */
            nfcTagIds: string[];
            vendorId: string;
            supplyBatchId: string;
            /** The vendor's own batch label, kept on the unit. */
            provisioningBatchId: string | null;
            actorId: string;
        },
    ): Promise<{ minted: number; firstSerial: number; lastSerial: number }>;
}

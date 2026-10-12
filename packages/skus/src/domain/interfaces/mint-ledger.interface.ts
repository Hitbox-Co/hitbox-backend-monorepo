import type { Prisma } from '@hitbox/database';

/**
 * Port: "write the MINT (genesis) ledger record for these new units."
 *
 * Every serialized unit starts its provenance chain at birth: sequence 0,
 * txType MINT, owner = HitBox. The rows are written with the SAME transaction
 * client that inserted the units, so the two commit or roll back together —
 * there is never a unit without its MINT record, nor a MINT record for a unit
 * that was rolled back.
 *
 * Implemented by @hitbox/claims (`claimsModule.mintLedger`), which owns
 * `BlockchainLedger` and the hash rules; wired in apps/backend/src/bootstrap.ts.
 * This module never imports claims.
 *
 * Optional only so unit tests can build the service without it. A running
 * server always wires it.
 */
export interface MintedUnitRef {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    /** NFC tag UID bound at mint time, or null when bound later from the manifest. */
    tagId: string | null;
    /** The drop's public code — part of the ledger hash. */
    groupCode: string;
    createdAt: Date;
}

export interface ISkuMintLedger {
    recordMintWithin(
        tx: Prisma.TransactionClient,
        input: {
            units: MintedUnitRef[];
            /** The user who minted, when known. Null for system / inline mints. */
            actorId: string | null;
        },
    ): Promise<void>;
}

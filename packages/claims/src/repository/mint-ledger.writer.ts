import { randomUUID } from 'node:crypto';
import type { Prisma } from '@hitbox/database';
import { LEDGER_ORIGIN_OWNER } from '../constants/claims.constant';
import { computeLedgerHash } from '../domain/ledger-hash';
import type { LedgerPayload } from './claims.repository';

/** One newly minted unit, as the skus module describes it. */
export interface MintLedgerUnit {
    skuId: string;
    skuCode: string;
    serialNumber: number;
    tagId: string | null;
    groupCode: string;
    createdAt: Date;
}

/**
 * Writes the MINT (genesis) record of each new unit's provenance chain.
 *
 * Called by @hitbox/skus with the transaction client that inserted the units,
 * so units and their MINT rows commit or roll back together. Satisfies the
 * skus module's `ISkuMintLedger` port structurally; wired in bootstrap.
 *
 * The row is the same shape the lazy origin paths in claims.repository.ts
 * write — sequence 0, no previous hash, owner "HitBox", hashed with
 * `computeLedgerHash(groupCode, tagId, "HitBox", createdAt)` — so a chain reads
 * identically whether its MINT row was written at mint time (every unit from
 * now on) or lazily at first claim (units minted before this existed).
 *
 * `tagId` is whatever was bound at mint time, usually null: tags are mostly
 * bound later from the vendor manifest. The hash records the unit as it was
 * when it was born, which is what a genesis record should do.
 */
export class MintLedgerWriter {
    async recordMintWithin(
        tx: Prisma.TransactionClient,
        input: { units: MintLedgerUnit[]; actorId: string | null },
    ): Promise<void> {
        if (input.units.length === 0) return;

        const payload: LedgerPayload = { ownerLabel: LEDGER_ORIGIN_OWNER };
        const rows: Prisma.BlockchainLedgerCreateManyInput[] = input.units.map((unit) => ({
            id: randomUUID(),
            skuId: unit.skuId,
            txType: 'MINT',
            sequenceNo: 0,
            previousHash: null,
            currentHash: computeLedgerHash({
                productId: unit.groupCode,
                tagId: unit.tagId,
                ownerId: LEDGER_ORIGIN_OWNER,
                dateTime: unit.createdAt.toISOString(),
            }),
            sellerDigitalSignature: `sig_hitbox_${unit.groupCode}`,
            payload: payload as unknown as Prisma.InputJsonValue,
            // A person pressed "mint" (USER), or it came with drop creation /
            // a script and nobody is attributable (SYSTEM).
            actorType: input.actorId ? 'USER' : 'SYSTEM',
            actorRef: input.actorId,
            reason: 'Minted',
            occurredAt: unit.createdAt,
            createdAt: unit.createdAt,
        }));

        // No skipDuplicates: these units were created a moment ago in this
        // same transaction, so a conflict on (skuId, sequenceNo) means
        // something is wrong — and failing rolls the units back with it.
        await tx.blockchainLedger.createMany({ data: rows });
    }
}

import type { PrismaClient } from '@hitbox/database';
import type { ListKeySetsQuery } from '../dto/nfc-key-set.dto';

/**
 * The only place that reads or writes `NfcKeySet`.
 *
 * Every read selects the view columns explicitly. The three wrapped-key
 * columns are never selected here: key material is read only by the verifier
 * in @hitbox/skus, and a list screen must not be one query away from it.
 */
const keySetSelect = {
    id: true,
    publicCode: true,
    keySetCode: true,
    supplyBatchId: true,
    kmsKeyRef: true,
    keyVersion: true,
    status: true,
    retiredAt: true,
    retireReason: true,
    createdAt: true,
} as const;

export interface KeySetRow {
    id: string;
    publicCode: string | null;
    keySetCode: string;
    supplyBatchId: string | null;
    kmsKeyRef: string;
    keyVersion: number;
    status: 'ACTIVE' | 'RETIRED';
    retiredAt: Date | null;
    retireReason: string | null;
    createdAt: Date;
}

export interface NewKeySet {
    keySetCode: string;
    supplyBatchId: string | null;
    key0Wrapped: Buffer;
    key1Wrapped: Buffer;
    key2Wrapped: Buffer;
    kmsKeyRef: string;
    createdById: string | null;
}

export class NfcKeySetRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async create(input: NewKeySet): Promise<KeySetRow> {
        return this.prisma.nfcKeySet.create({
            data: {
                keySetCode: input.keySetCode,
                supplyBatchId: input.supplyBatchId,
                key0Wrapped: new Uint8Array(input.key0Wrapped),
                key1Wrapped: new Uint8Array(input.key1Wrapped),
                key2Wrapped: new Uint8Array(input.key2Wrapped),
                kmsKeyRef: input.kmsKeyRef,
                createdById: input.createdById,
            },
            select: keySetSelect,
        });
    }

    findById(id: string): Promise<KeySetRow | null> {
        return this.prisma.nfcKeySet.findUnique({ where: { id }, select: keySetSelect });
    }

    list(query: ListKeySetsQuery): Promise<KeySetRow[]> {
        return this.prisma.nfcKeySet.findMany({
            where: {
                ...(query.status ? { status: query.status } : {}),
                ...(query.supplyBatchId ? { supplyBatchId: query.supplyBatchId } : {}),
            },
            orderBy: { createdAt: 'desc' },
            select: keySetSelect,
        });
    }

    async batchExists(batchId: string): Promise<boolean> {
        const row = await this.prisma.supplyBatch.findUnique({
            where: { id: batchId },
            select: { id: true },
        });
        return row !== null;
    }

    /**
     * Gives this key set to every chip of the batch that has none yet, in one
     * statement. A chip with no key set has never been personalised, so it has
     * never been tapped: its counter is reset to -1 ("never tapped") in the
     * same write. Chips that already carry a key set are not touched — moving
     * a chip to other keys is a re-key, not this operation.
     */
    async personaliseBatch(params: {
        keySetId: string;
        supplyBatchId: string;
        now: Date;
    }): Promise<number> {
        const result = await this.prisma.nfcTag.updateMany({
            where: { supplyBatchId: params.supplyBatchId, keySetId: null },
            data: {
                keySetId: params.keySetId,
                personalizedAt: params.now,
                lastTapCounter: -1,
            },
        });
        return result.count;
    }

    /** Marks an ACTIVE set RETIRED. Returns false when it was not ACTIVE. */
    async retire(params: { id: string; reason: string; now: Date }): Promise<boolean> {
        const result = await this.prisma.nfcKeySet.updateMany({
            where: { id: params.id, status: 'ACTIVE' },
            data: { status: 'RETIRED', retiredAt: params.now, retireReason: params.reason },
        });
        return result.count === 1;
    }
}

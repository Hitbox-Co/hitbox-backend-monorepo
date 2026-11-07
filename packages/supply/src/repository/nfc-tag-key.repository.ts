import type { PrismaClient } from '@hitbox/database';

/**
 * The only place in supply that reads or writes `NfcTagKey`.
 *
 * Every read selects the view columns explicitly. The wrapped-key columns and
 * the UID columns are never selected for a view: key material is read only by
 * the verifier in @hitbox/skus.
 *
 * Nothing here updates or deletes an `NfcTag` column. Re-keying adds a row;
 * old rows are kept.
 */
const tagKeySelect = {
    id: true,
    publicCode: true,
    nfcTagId: true,
    kmsKeyRef: true,
    keyVersion: true,
    status: true,
    lastTapCounter: true,
    lastTapAt: true,
    personalizedAt: true,
    revokedAt: true,
    revokeReason: true,
    createdAt: true,
} as const;

export interface TagKeyRow {
    id: string;
    publicCode: string | null;
    nfcTagId: string;
    kmsKeyRef: string;
    keyVersion: number;
    status: 'ACTIVE' | 'REVOKED';
    lastTapCounter: number;
    lastTapAt: Date | null;
    personalizedAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
    createdAt: Date;
}

/** The chip fields key generation needs. Includes the encrypted UID, never the plain one. */
export interface KeyableTag {
    id: string;
    nfcTagCode: string;
    supplyBatchId: string;
    tagUidEncrypted: string;
    tagUidHash: string;
}

export interface NewTagKey {
    nfcTagId: string;
    tagUidEncrypted: string;
    tagUidHash: string;
    key0Wrapped: Buffer;
    key1Wrapped: Buffer;
    key2Wrapped: Buffer;
    kmsKeyRef: string;
    createdById: string | null;
}

const keyableTagSelect = {
    id: true,
    nfcTagCode: true,
    supplyBatchId: true,
    tagUidEncrypted: true,
    tagUidHash: true,
} as const;

export class NfcTagKeyRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findTag(nfcTagId: string): Promise<KeyableTag | null> {
        return this.prisma.nfcTag.findUnique({
            where: { id: nfcTagId },
            select: keyableTagSelect,
        });
    }

    async batchExists(batchId: string): Promise<boolean> {
        const row = await this.prisma.supplyBatch.findUnique({
            where: { id: batchId },
            select: { id: true },
        });
        return row !== null;
    }

    async hasActiveKey(nfcTagId: string): Promise<boolean> {
        const count = await this.prisma.nfcTagKey.count({
            where: { nfcTagId, status: 'ACTIVE' },
        });
        return count > 0;
    }

    findById(id: string): Promise<TagKeyRow | null> {
        return this.prisma.nfcTagKey.findUnique({ where: { id }, select: tagKeySelect });
    }

    findActiveForTag(nfcTagId: string): Promise<TagKeyRow | null> {
        return this.prisma.nfcTagKey.findFirst({
            where: { nfcTagId, status: 'ACTIVE' },
            select: tagKeySelect,
        });
    }

    /** One row. A second ACTIVE row for the tag is refused by the partial unique index (P2002). */
    create(input: NewTagKey): Promise<TagKeyRow> {
        return this.prisma.nfcTagKey.create({
            data: toData(input),
            select: tagKeySelect,
        });
    }

    /** All rows or none: a failure leaves no chip keyed with keys nobody received. */
    createMany(inputs: NewTagKey[]): Promise<TagKeyRow[]> {
        return this.prisma.$transaction(
            inputs.map((input) =>
                this.prisma.nfcTagKey.create({ data: toData(input), select: tagKeySelect }),
            ),
        );
    }

    /** Chips of a consignment with no ACTIVE key row, oldest first. */
    tagsNeedingKeys(supplyBatchId: string, limit: number): Promise<KeyableTag[]> {
        return this.prisma.nfcTag.findMany({
            where: { supplyBatchId, keys: { none: { status: 'ACTIVE' } } },
            orderBy: { createdAt: 'asc' },
            take: limit,
            select: keyableTagSelect,
        });
    }

    countTagsNeedingKeys(supplyBatchId: string): Promise<number> {
        return this.prisma.nfcTag.count({
            where: { supplyBatchId, keys: { none: { status: 'ACTIVE' } } },
        });
    }

    /** Sets `personalizedAt` on this key row only. False when it was ACTIVE-and-unset no longer. */
    async markPersonalized(id: string, now: Date): Promise<boolean> {
        const result = await this.prisma.nfcTagKey.updateMany({
            where: { id, status: 'ACTIVE', personalizedAt: null },
            data: { personalizedAt: now },
        });
        return result.count === 1;
    }

    /** Revokes the tag's ACTIVE row. Returns false when there was none. */
    async revokeActive(params: {
        nfcTagId: string;
        reason: string;
        now: Date;
    }): Promise<boolean> {
        const result = await this.prisma.nfcTagKey.updateMany({
            where: { nfcTagId: params.nfcTagId, status: 'ACTIVE' },
            data: { status: 'REVOKED', revokedAt: params.now, revokeReason: params.reason },
        });
        return result.count === 1;
    }
}

function toData(input: NewTagKey) {
    return {
        nfcTagId: input.nfcTagId,
        tagUidEncrypted: input.tagUidEncrypted,
        tagUidHash: input.tagUidHash,
        key0Wrapped: new Uint8Array(input.key0Wrapped),
        key1Wrapped: new Uint8Array(input.key1Wrapped),
        key2Wrapped: new Uint8Array(input.key2Wrapped),
        kmsKeyRef: input.kmsKeyRef,
        createdById: input.createdById,
    };
}

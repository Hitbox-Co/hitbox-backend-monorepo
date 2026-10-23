import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, RefundEvidence, RefundRequest } from '@hitbox/database';
import type { ListRefundsQuery } from '../dto/payments.dto';

/** A refund as list reads return it: the row plus its photo count. */
export type RefundRow = RefundRequest & { _count?: { evidence: number } };

const withEvidenceCount = { _count: { select: { evidence: true } } } as const;

export class RefundRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<RefundRequest | null> {
        return this.prisma.refundRequest.findUnique({ where: { id } });
    }

    /** An order may only have one refund in flight at a time. */
    findOpenForOrder(orderId: string): Promise<RefundRequest | null> {
        return this.prisma.refundRequest.findFirst({
            where: {
                orderId,
                status: { in: ['REQUESTED', 'AWAITING_RETURN', 'APPROVED'] },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    findByGatewayRefundId(gatewayRefundId: string): Promise<RefundRequest | null> {
        return this.prisma.refundRequest.findFirst({ where: { gatewayRefundId } });
    }

    /**
     * The approved refund on an order that has not been paid out yet — what a
     * refund issued in the provider's dashboard is matched against.
     */
    findApprovedUnissuedForOrder(orderId: string): Promise<RefundRequest | null> {
        return this.prisma.refundRequest.findFirst({
            where: { orderId, status: 'APPROVED', gatewayRefundId: null },
            orderBy: { approvedAt: 'desc' },
        });
    }

    /**
     * Records what the provider said about the money, never going backwards.
     *
     * Webhooks arrive out of order and more than once, and the synchronous
     * answer to `process` races the first webhook. So: PENDING is written only
     * over nothing; a terminal status (SUCCEEDED / FAILED / CANCELED) is
     * written over anything different — Stripe can move a refund from
     * succeeded to failed. `onlyIfUnset` is for `process`'s own first write,
     * which must not overwrite a webhook that got there first.
     *
     * Returns the number of rows changed: 0 means "already knew", which is
     * what keeps a retried webhook from alerting twice.
     */
    async setGatewayStatus(input: {
        id: string;
        status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
        failureReason: string | null;
        at: Date;
        onlyIfUnset?: boolean;
    }): Promise<number> {
        const guard: Prisma.RefundRequestWhereInput =
            input.onlyIfUnset || input.status === 'PENDING'
                ? { gatewayStatus: null }
                : { OR: [{ gatewayStatus: null }, { gatewayStatus: { not: input.status } }] };
        const result = await this.prisma.refundRequest.updateMany({
            where: { id: input.id, ...guard },
            data: {
                gatewayStatus: input.status,
                gatewayFailureReason: input.failureReason,
                gatewayStatusAt: input.at,
                updatedAt: new Date(),
            },
        });
        return result.count;
    }

    /**
     * The refund and its photos, together or not at all.
     *
     * A return that exists without the photos it was placed with would be a
     * return the rules say cannot exist, so both go in one transaction. The
     * unique index on `RefundEvidence.mediaAssetId` is the last word on a
     * photo being attached twice — two returns racing for one asset produce
     * one success and a P2002, which the service turns into a 409.
     */
    async create(
        data: Prisma.RefundRequestUncheckedCreateInput,
        evidence: { mediaAssetIds: string[]; attachedById: string } = {
            mediaAssetIds: [],
            attachedById: data.requestedById,
        },
    ): Promise<RefundRow> {
        return this.prisma.$transaction(async (tx) => {
            const refund = await tx.refundRequest.create({ data });
            if (evidence.mediaAssetIds.length > 0) {
                await tx.refundEvidence.createMany({
                    data: evidence.mediaAssetIds.map((mediaAssetId, position) => ({
                        id: randomUUID(),
                        refundRequestId: refund.id,
                        mediaAssetId,
                        position,
                        attachedById: evidence.attachedById,
                        createdAt: data.createdAt as Date,
                    })),
                });
            }
            return { ...refund, _count: { evidence: evidence.mediaAssetIds.length } };
        });
    }

    /** Which of these assets already back some refund. */
    async findAttachedAssetIds(mediaAssetIds: string[]): Promise<string[]> {
        if (mediaAssetIds.length === 0) return [];
        const rows = await this.prisma.refundEvidence.findMany({
            where: { mediaAssetId: { in: mediaAssetIds } },
            select: { mediaAssetId: true },
        });
        return rows.map((row) => row.mediaAssetId);
    }

    /** A refund's photos, in the order the buyer gave them. */
    findEvidence(refundRequestId: string): Promise<RefundEvidence[]> {
        return this.prisma.refundEvidence.findMany({
            where: { refundRequestId },
            orderBy: { position: 'asc' },
        });
    }

    /**
     * Every refund state change is a guarded `updateMany`.
     *
     * Approve and process are both buttons, both consequential, and both
     * reachable by two operators at once. A plain `update` would let the second
     * press quietly re-run the money movement.
     */
    async transition(input: {
        id: string;
        from: Prisma.RefundRequestWhereInput['status'];
        data: Prisma.RefundRequestUncheckedUpdateManyInput;
        tx?: Prisma.TransactionClient;
    }): Promise<number> {
        const client = input.tx ?? this.prisma;
        const result = await client.refundRequest.updateMany({
            where: { id: input.id, status: input.from },
            data: { ...input.data, updatedAt: new Date() },
        });
        return result.count;
    }

    async list(
        query: ListRefundsQuery & {
            scopeFilter: Prisma.RefundRequestWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: RefundRow[] }> {
        const where: Prisma.RefundRequestWhereInput = {
            ...query.scopeFilter,
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}),
            ...(query.gatewayStatus ? { gatewayStatus: query.gatewayStatus } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.refundRequest.count({ where }),
            this.prisma.refundRequest.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: query.skip,
                take: query.take,
                include: withEvidenceCount,
            }),
        ]);
        return { total, items };
    }

    /** Total already refunded on an order — the over-refund guard. */
    async refundedTotal(orderId: string): Promise<Prisma.Decimal> {
        const result = await this.prisma.refundRequest.aggregate({
            where: { orderId, status: 'PROCESSED' },
            _sum: { amount: true },
        });
        return result._sum.amount ?? new Prisma.Decimal(0);
    }
}

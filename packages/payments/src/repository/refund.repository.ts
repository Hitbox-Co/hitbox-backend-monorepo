import { Prisma } from '@hitbox/database';
import type { PrismaClient, RefundRequest } from '@hitbox/database';
import type { ListRefundsQuery } from '../dto/payments.dto';

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

    create(data: Prisma.RefundRequestUncheckedCreateInput): Promise<RefundRequest> {
        return this.prisma.refundRequest.create({ data });
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
    ): Promise<{ total: number; items: RefundRequest[] }> {
        const where: Prisma.RefundRequestWhereInput = {
            ...query.scopeFilter,
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}),
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

import { Prisma } from '@hitbox/database';
import type { DisputeCase, PrismaClient } from '@hitbox/database';
import type { ListDisputesQuery } from '../dto/payments.dto';

export class DisputeRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<DisputeCase | null> {
        return this.prisma.disputeCase.findUnique({ where: { id } });
    }

    findByGatewayRef(gatewayCaseRef: string): Promise<DisputeCase | null> {
        return this.prisma.disputeCase.findUnique({ where: { gatewayCaseRef } });
    }

    /**
     * Opens a case, or returns the existing one for the same provider case id.
     *
     * A dispute arrives as a webhook and the provider redelivers it; a second
     * `DisputeCase` for one chargeback would double-count the loss when it is
     * resolved. The unique `gatewayCaseRef` is what prevents that, and this
     * turns the collision into an ordinary "already open".
     */
    async createOrGet(
        data: Prisma.DisputeCaseUncheckedCreateInput,
    ): Promise<{ dispute: DisputeCase; created: boolean }> {
        try {
            const dispute = await this.prisma.disputeCase.create({ data });
            return { dispute, created: true };
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002' &&
                data.gatewayCaseRef
            ) {
                const existing = await this.prisma.disputeCase.findUnique({
                    where: { gatewayCaseRef: data.gatewayCaseRef },
                });
                if (existing) return { dispute: existing, created: false };
            }
            throw error;
        }
    }

    async transition(input: {
        id: string;
        from: Prisma.DisputeCaseWhereInput['status'];
        data: Prisma.DisputeCaseUncheckedUpdateManyInput;
        tx?: Prisma.TransactionClient;
    }): Promise<number> {
        const client = input.tx ?? this.prisma;
        const result = await client.disputeCase.updateMany({
            where: { id: input.id, ...(input.from ? { status: input.from } : {}) },
            data: { ...input.data, updatedAt: new Date() },
        });
        return result.count;
    }

    async list(
        query: ListDisputesQuery & {
            scopeFilter: Prisma.DisputeCaseWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: DisputeCase[] }> {
        const where: Prisma.DisputeCaseWhereInput = {
            ...query.scopeFilter,
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.dueBefore ? { evidenceDueBy: { lte: query.dueBefore } } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.disputeCase.count({ where }),
            this.prisma.disputeCase.findMany({
                where,
                // Soonest deadline first: the queue is a countdown, and a case
                // whose evidence window closes tomorrow matters more than one
                // opened yesterday with three weeks left.
                orderBy: [{ evidenceDueBy: 'asc' }, { openedAt: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }
}

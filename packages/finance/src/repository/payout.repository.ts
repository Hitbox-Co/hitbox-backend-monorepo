import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { ListPayoutsQuery } from '../dto/finance.dto';

const payoutSelect = {
    id: true,
    payeeType: true,
    payeeArtistId: true,
    payeeOrganizationId: true,
    amount: true,
    currency: true,
    entryCount: true,
    thresholdApplied: true,
    status: true,
    scheduledAt: true,
    approvedById: true,
    approvedAt: true,
    gatewayPayoutRef: true,
    paidAt: true,
    failureReason: true,
    payeeArtist: { select: { id: true, name: true } },
    payeeOrganization: { select: { id: true, name: true } },
} satisfies Prisma.RoyaltyPayoutSelect;

export type PayoutRow = Prisma.RoyaltyPayoutGetPayload<{ select: typeof payoutSelect }>;

export class PayoutRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<PayoutRow | null> {
        return this.prisma.royaltyPayout.findUnique({ where: { id }, select: payoutSelect });
    }

    async list(
        query: ListPayoutsQuery & {
            scopeFilter: Prisma.RoyaltyPayoutWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: PayoutRow[] }> {
        const where: Prisma.RoyaltyPayoutWhereInput = {
            ...query.scopeFilter,
            ...(query.status ? { status: query.status } : {}),
            ...(query.currency ? { currency: query.currency } : {}),
            ...(query.artistId ? { payeeArtistId: query.artistId } : {}),
            ...(query.organizationId ? { payeeOrganizationId: query.organizationId } : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.royaltyPayout.count({ where }),
            this.prisma.royaltyPayout.findMany({
                where,
                select: payoutSelect,
                orderBy: { scheduledAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(
        data: Prisma.RoyaltyPayoutUncheckedCreateInput,
        tx: Prisma.TransactionClient,
    ): Promise<{ id: string }> {
        return tx.royaltyPayout.create({ data, select: { id: true } });
    }

    /**
     * Every status change on a batch is a guarded `updateMany`, never a plain
     * update: "approve" and "execute" are both buttons two people can press at
     * the same moment, and the loser of that race has to be told, not ignored.
     */
    async transition(input: {
        id: string;
        from: Prisma.RoyaltyPayoutWhereInput['status'];
        data: Prisma.RoyaltyPayoutUncheckedUpdateManyInput;
        tx?: Prisma.TransactionClient;
    }): Promise<number> {
        const client = input.tx ?? this.prisma;
        const result = await client.royaltyPayout.updateMany({
            where: { id: input.id, status: input.from },
            data: { ...input.data, updatedAt: new Date() },
        });
        return result.count;
    }
}

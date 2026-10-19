import { Prisma } from '@hitbox/database';
import type { PaymentGatewayConfig, PrismaClient } from '@hitbox/database';
import type { ListGatewayConfigsQuery } from '../dto/payments.dto';

export class GatewayConfigRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<PaymentGatewayConfig | null> {
        return this.prisma.paymentGatewayConfig.findUnique({ where: { id } });
    }

    /**
     * The configuration that applies to one sale: most specific scope wins,
     * DROP over ORGANIZATION over PLATFORM.
     *
     * Ordered in the database rather than picked in memory because the
     * candidate set is tiny and the precedence is total — there is no business
     * rule here to keep next to anything, unlike royalty rule resolution.
     */
    async resolve(input: {
        gateway: Prisma.PaymentGatewayConfigWhereInput['gateway'];
        organizationId: string | null;
    }): Promise<PaymentGatewayConfig | null> {
        const candidates = await this.prisma.paymentGatewayConfig.findMany({
            where: {
                gateway: input.gateway,
                status: 'ACTIVE',
                OR: [
                    { scope: 'PLATFORM' },
                    ...(input.organizationId
                        ? [
                            {
                                scope: 'ORGANIZATION' as const,
                                organizationId: input.organizationId,
                            },
                        ]
                        : []),
                ],
            },
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        });

        const rank = { DROP: 3, ORGANIZATION: 2, PLATFORM: 1 } as const;
        return (
            candidates
                .slice()
                .sort((a, b) => rank[b.scope] - rank[a.scope])[0] ?? null
        );
    }

    async list(
        query: ListGatewayConfigsQuery & { skip: number; take: number },
    ): Promise<{ total: number; items: PaymentGatewayConfig[] }> {
        const where: Prisma.PaymentGatewayConfigWhereInput = {
            ...(query.scope ? { scope: query.scope } : {}),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.status ? { status: query.status } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.paymentGatewayConfig.count({ where }),
            this.prisma.paymentGatewayConfig.findMany({
                where,
                orderBy: { updatedAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(data: Prisma.PaymentGatewayConfigUncheckedCreateInput) {
        return this.prisma.paymentGatewayConfig.create({ data });
    }

    update(id: string, data: Prisma.PaymentGatewayConfigUncheckedUpdateInput) {
        return this.prisma.paymentGatewayConfig.update({ where: { id }, data });
    }

    /**
     * Clears the default flag across a scope before setting a new one.
     * "Two defaults" is a state with no correct interpretation, so it is made
     * unreachable rather than resolved by ordering at read time.
     */
    async clearDefault(input: {
        gateway: Prisma.PaymentGatewayConfigWhereInput['gateway'];
        scope: Prisma.PaymentGatewayConfigWhereInput['scope'];
        organizationId: string | null;
        exceptId?: string;
    }): Promise<number> {
        const result = await this.prisma.paymentGatewayConfig.updateMany({
            where: {
                gateway: input.gateway,
                scope: input.scope,
                organizationId: input.organizationId,
                isDefault: true,
                ...(input.exceptId ? { id: { not: input.exceptId } } : {}),
            },
            data: { isDefault: false, updatedAt: new Date() },
        });
        return result.count;
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, TaxConfiguration } from '@hitbox/database';
import type { CreateTaxConfigurationDto, ListTaxConfigurationsQuery } from '../dto/tax.dto';

export class TaxConfigurationRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<TaxConfiguration | null> {
        return this.prisma.taxConfiguration.findUnique({ where: { id } });
    }

    /**
     * Every rate row that *could* apply to one sale.
     *
     * Deliberately over-fetches — the product's own rows and the jurisdiction's
     * defaults — and the winner is picked in memory by `resolveTaxConfiguration`.
     * Same reasoning as `RoyaltyRuleRepository.findCandidates`: precedence is a
     * business rule and belongs beside the arithmetic it feeds, and a handful of
     * rows per product makes the "expensive" version one indexed lookup.
     */
    findCandidates(target: {
        productId: string;
        countryCode: string;
        stateCode: string | null;
    }): Promise<TaxConfiguration[]> {
        return this.prisma.taxConfiguration.findMany({
            where: {
                countryCode: target.countryCode,
                status: 'ACTIVE',
                OR: [{ productId: target.productId }, { productId: null }],
                ...(target.stateCode
                    ? { AND: [{ OR: [{ stateCode: target.stateCode }, { stateCode: null }] }] }
                    : { stateCode: null }),
            },
            orderBy: { effectiveFrom: 'desc' },
        });
    }

    async list(
        query: ListTaxConfigurationsQuery & { skip: number; take: number },
    ): Promise<{ total: number; items: TaxConfiguration[] }> {
        const where: Prisma.TaxConfigurationWhereInput = {
            ...(query.countryCode ? { countryCode: query.countryCode } : {}),
            ...(query.stateCode ? { stateCode: query.stateCode } : {}),
            ...(query.productId ? { productId: query.productId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.activeAt
                ? {
                    effectiveFrom: { lte: query.activeAt },
                    OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.activeAt } }],
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.taxConfiguration.count({ where }),
            this.prisma.taxConfiguration.findMany({
                where,
                orderBy: [{ countryCode: 'asc' }, { effectiveFrom: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(
        dto: CreateTaxConfigurationDto,
        createdById: string | null,
    ): Promise<TaxConfiguration> {
        const now = new Date();
        return this.prisma.taxConfiguration.create({
            data: {
                id: randomUUID(),
                productId: dto.productId ?? null,
                countryCode: dto.countryCode,
                stateCode: dto.stateCode ?? null,
                taxType: dto.taxType,
                taxRate: dto.taxRate,
                hsnCode: dto.hsnCode ?? null,
                sacCode: dto.sacCode ?? null,
                exemptionReason: dto.exemptionReason ?? null,
                effectiveFrom: dto.effectiveFrom,
                effectiveTo: dto.effectiveTo ?? null,
                status: 'ACTIVE',
                createdById,
                createdAt: now,
                updatedAt: now,
            },
        });
    }

    /**
     * Closes a rate's effective window. The only mutation this table allows —
     * a new rate is a new row, so an invoice issued last year still resolves to
     * the rate it was actually charged at.
     */
    close(id: string, effectiveTo: Date): Promise<TaxConfiguration> {
        return this.prisma.taxConfiguration.update({
            where: { id },
            data: { effectiveTo, status: 'INACTIVE', updatedAt: new Date() },
        });
    }
}

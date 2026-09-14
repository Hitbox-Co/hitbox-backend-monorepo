import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { Currency, PrismaClient } from '@hitbox/database';

const marketInclude = {
    marketCountrys: { select: { countryCode: true }, orderBy: { countryCode: 'asc' } },
    _count: { select: { productPrices: true, orders: true } },
} satisfies Prisma.MarketInclude;

export type MarketRow = Prisma.MarketGetPayload<{ include: typeof marketInclude }>;

/** The only place in this module that touches Prisma. */
export class MarketRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(input: {
        includeArchived: boolean;
        isActive?: boolean | undefined;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: MarketRow[] }> {
        const where: Prisma.MarketWhereInput = {
            ...(input.includeArchived ? {} : { archivedAt: null }),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        };
        const [total, items] = await Promise.all([
            this.prisma.market.count({ where }),
            this.prisma.market.findMany({
                where,
                include: marketInclude,
                // Default first, then alphabetically — the default market is
                // the one an operator looks for.
                orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
                skip: input.skip,
                take: input.take,
            }),
        ]);
        return { total, items };
    }

    findById(id: string): Promise<MarketRow | null> {
        return this.prisma.market.findUnique({ where: { id }, include: marketInclude });
    }

    findByCode(code: string): Promise<MarketRow | null> {
        return this.prisma.market.findUnique({ where: { code }, include: marketInclude });
    }

    /** Which markets already own these countries, if any. */
    findCountryOwners(
        countryCodes: string[],
        exceptMarketId?: string,
    ): Promise<{ countryCode: string; marketId: string }[]> {
        return this.prisma.marketCountry.findMany({
            where: {
                countryCode: { in: countryCodes },
                ...(exceptMarketId ? { marketId: { not: exceptMarketId } } : {}),
            },
            select: { countryCode: true, marketId: true },
        });
    }

    /**
     * Creates the market and its country mappings atomically, demoting the
     * previous default when this one claims it.
     *
     * The demote-then-promote pair has to be one transaction: between the two
     * statements the platform would otherwise have zero default markets, and
     * any order placed in that window resolves its market to nothing.
     */
    async create(input: {
        code: string;
        name: string;
        currency: Currency;
        isActive: boolean;
        isDefault: boolean;
        countryCodes: string[];
    }): Promise<MarketRow> {
        const id = randomUUID();
        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            if (input.isDefault) {
                await tx.market.updateMany({
                    where: { isDefault: true },
                    data: { isDefault: false, updatedAt: now },
                });
            }
            await tx.market.create({
                data: {
                    id,
                    code: input.code,
                    name: input.name,
                    currency: input.currency,
                    isActive: input.isActive,
                    isDefault: input.isDefault,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            if (input.countryCodes.length > 0) {
                await tx.marketCountry.createMany({
                    data: input.countryCodes.map((countryCode) => ({
                        id: randomUUID(),
                        marketId: id,
                        countryCode,
                        createdAt: now,
                    })),
                });
            }
        });

        return (await this.findById(id))!;
    }

    async update(
        id: string,
        input: {
            name?: string | undefined;
            currency?: Currency | undefined;
            isActive?: boolean | undefined;
            isDefault?: boolean | undefined;
            countryCodes?: string[] | undefined;
        },
    ): Promise<MarketRow> {
        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            if (input.isDefault === true) {
                await tx.market.updateMany({
                    where: { isDefault: true, id: { not: id } },
                    data: { isDefault: false, updatedAt: now },
                });
            }

            await tx.market.update({
                where: { id },
                data: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.currency !== undefined ? { currency: input.currency } : {}),
                    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
                    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
                    updatedAt: now,
                },
            });

            // Country mappings are replaced wholesale rather than diffed: the
            // set is small and a replace makes "these are the countries now"
            // unambiguous, where a partial diff invites drift.
            if (input.countryCodes !== undefined) {
                await tx.marketCountry.deleteMany({ where: { marketId: id } });
                if (input.countryCodes.length > 0) {
                    await tx.marketCountry.createMany({
                        data: input.countryCodes.map((countryCode) => ({
                            id: randomUUID(),
                            marketId: id,
                            countryCode,
                            createdAt: now,
                        })),
                    });
                }
            }
        });

        return (await this.findById(id))!;
    }

    /**
     * Soft archive. The row survives because orders reference it and an order
     * must always be able to name the market it was placed in.
     */
    async archive(id: string): Promise<MarketRow> {
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
            await tx.market.update({
                where: { id },
                data: { isActive: false, isDefault: false, archivedAt: now, updatedAt: now },
            });
            // Free the countries so they can be remapped to a live market.
            await tx.marketCountry.deleteMany({ where: { marketId: id } });
        });
        return (await this.findById(id))!;
    }
}

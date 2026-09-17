import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, TaxReturnFiling } from '@hitbox/database';
import type { CreateTaxFilingDto, ListTaxFilingsQuery } from '../dto/tax.dto';

export class TaxFilingRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<TaxReturnFiling | null> {
        return this.prisma.taxReturnFiling.findUnique({ where: { id } });
    }

    async list(
        query: ListTaxFilingsQuery & {
            /** Set for an OWN-scoped artist caller: their own filings only. */
            restrictToArtistIds: string[] | null;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: TaxReturnFiling[] }> {
        const where: Prisma.TaxReturnFilingWhereInput = {
            // An artist-scoped caller sees only information returns about
            // themselves — never HitBox's own GSTR-1, which is the platform's
            // return and contains every other artist's sales.
            ...(query.restrictToArtistIds === null
                ? {}
                : { artistId: { in: query.restrictToArtistIds } }),
            ...(query.artistId ? { artistId: query.artistId } : {}),
            ...(query.filingType ? { filingType: query.filingType } : {}),
            ...(query.countryCode ? { countryCode: query.countryCode } : {}),
            ...(query.stateCode ? { stateCode: query.stateCode } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.periodFrom || query.periodTo
                ? {
                    periodStart: {
                        ...(query.periodFrom ? { gte: query.periodFrom } : {}),
                        ...(query.periodTo ? { lt: query.periodTo } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.taxReturnFiling.count({ where }),
            this.prisma.taxReturnFiling.findMany({
                where,
                orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(
        dto: CreateTaxFilingDto,
        computed: {
            totalTaxableAmount: string | null;
            totalTaxCollected: string | null;
            totalTaxDue: string | null;
            currency: TaxReturnFiling['currency'];
            dueDate: Date;
            createdById: string | null;
        },
    ): Promise<TaxReturnFiling> {
        const now = new Date();
        return this.prisma.taxReturnFiling.create({
            data: {
                id: randomUUID(),
                filingType: dto.filingType,
                countryCode: dto.countryCode,
                stateCode: dto.stateCode ?? null,
                periodStart: dto.periodStart,
                periodEnd: dto.periodEnd,
                totalTaxableAmount: computed.totalTaxableAmount,
                totalTaxCollected: computed.totalTaxCollected,
                totalTaxDue: computed.totalTaxDue,
                inputTaxCredit: null,
                currency: computed.currency,
                artistId: dto.artistId ?? null,
                payoutId: dto.payoutId ?? null,
                status: 'READY',
                dueDate: computed.dueDate,
                notes: dto.notes ?? null,
                createdById: computed.createdById,
                createdAt: now,
                updatedAt: now,
            },
        });
    }

    markFiled(
        id: string,
        detail: { referenceNumber: string; filedAt: Date; filedById: string; notes?: string },
    ): Promise<TaxReturnFiling> {
        return this.prisma.taxReturnFiling.update({
            where: { id },
            data: {
                status: 'FILED',
                referenceNumber: detail.referenceNumber,
                filedAt: detail.filedAt,
                filedById: detail.filedById,
                ...(detail.notes ? { notes: detail.notes } : {}),
                updatedAt: new Date(),
            },
        });
    }

    attachDocument(id: string, storageRef: string): Promise<TaxReturnFiling> {
        return this.prisma.taxReturnFiling.update({
            where: { id },
            data: { documentStorageRef: storageRef, updatedAt: new Date() },
        });
    }
}

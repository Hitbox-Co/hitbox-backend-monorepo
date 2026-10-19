import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, TaxAdjustmentEntry } from '@hitbox/database';
import type { ListTaxAdjustmentsQuery } from '../dto/tax.dto';

export class TaxAdjustmentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<TaxAdjustmentEntry | null> {
        return this.prisma.taxAdjustmentEntry.findUnique({ where: { id } });
    }

    async list(
        query: ListTaxAdjustmentsQuery & { skip: number; take: number },
    ): Promise<{ total: number; items: TaxAdjustmentEntry[] }> {
        const where: Prisma.TaxAdjustmentEntryWhereInput = {
            ...(query.invoiceId ? { invoiceId: query.invoiceId } : {}),
            ...(query.status ? { status: query.status } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.taxAdjustmentEntry.count({ where }),
            this.prisma.taxAdjustmentEntry.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    create(input: {
        invoiceId: string;
        adjustmentType: TaxAdjustmentEntry['adjustmentType'];
        reason: string;
        originalTaxAmount: string;
        adjustedTaxAmount: string;
        adjustmentAmount: string;
        currency: TaxAdjustmentEntry['currency'];
        createdById: string | null;
    }): Promise<TaxAdjustmentEntry> {
        const now = new Date();
        return this.prisma.taxAdjustmentEntry.create({
            data: {
                id: randomUUID(),
                invoiceId: input.invoiceId,
                adjustmentType: input.adjustmentType,
                reason: input.reason,
                originalTaxAmount: input.originalTaxAmount,
                adjustedTaxAmount: input.adjustedTaxAmount,
                adjustmentAmount: input.adjustmentAmount,
                currency: input.currency,
                // Always PENDING_APPROVAL on creation. A correction to a figure
                // already reported to a tax authority is never self-service,
                // even for the operator who spotted the error.
                status: 'PENDING_APPROVAL',
                createdById: input.createdById,
                createdAt: now,
                updatedAt: now,
            },
        });
    }

    decide(
        id: string,
        decision: {
            status: 'APPROVED' | 'REJECTED';
            approvedById: string;
            reason: string;
        },
    ): Promise<TaxAdjustmentEntry> {
        const now = new Date();
        return this.prisma.taxAdjustmentEntry.update({
            where: { id },
            data: {
                status: decision.status,
                approvedById: decision.approvedById,
                approvedAt: now,
                ...(decision.status === 'REJECTED'
                    ? { rejectionReason: decision.reason }
                    : {}),
                updatedAt: now,
            },
        });
    }
}

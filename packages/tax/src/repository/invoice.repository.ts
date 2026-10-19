import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { Invoice, InvoiceLineItem, PrismaClient } from '@hitbox/database';
import type { ListInvoicesQuery } from '../dto/tax.dto';

export type InvoiceWithLines = Invoice & { lineItems: InvoiceLineItem[] };

/** The only place in this module that touches Prisma for invoices. */
export class InvoiceRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<InvoiceWithLines | null> {
        return this.prisma.invoice.findUnique({
            where: { id },
            include: { lineItems: { orderBy: { position: 'asc' } } },
        });
    }

    findByNumber(invoiceNumber: string): Promise<InvoiceWithLines | null> {
        return this.prisma.invoice.findUnique({
            where: { invoiceNumber },
            include: { lineItems: { orderBy: { position: 'asc' } } },
        });
    }

    findByOrderId(orderId: string): Promise<InvoiceWithLines | null> {
        return this.prisma.invoice.findUnique({
            where: { orderId },
            include: { lineItems: { orderBy: { position: 'asc' } } },
        });
    }

    async list(
        query: ListInvoicesQuery & {
            /** Null = unrestricted. Empty array = reaches nothing. */
            organizationIds: string[] | null;
            /** Set for a BUYER-scoped caller; overrides `buyerId` in the query. */
            restrictToBuyerId: string | null;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: InvoiceWithLines[] }> {
        const where: Prisma.InvoiceWhereInput = {
            // Scope first, filters second: a query parameter can only ever
            // narrow what the grant already allows, never widen it.
            ...(query.restrictToBuyerId
                ? { buyerId: query.restrictToBuyerId }
                : query.buyerId
                    ? { buyerId: query.buyerId }
                    : {}),
            ...(query.organizationIds === null
                ? {}
                : { organizationId: { in: query.organizationIds } }),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.countryCode ? { countryCode: query.countryCode } : {}),
            ...(query.stateCode ? { stateCode: query.stateCode } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.fiscalYear ? { fiscalYear: query.fiscalYear } : {}),
            ...(query.issuedFrom || query.issuedTo
                ? {
                    invoiceDate: {
                        ...(query.issuedFrom ? { gte: query.issuedFrom } : {}),
                        ...(query.issuedTo ? { lt: query.issuedTo } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.invoice.count({ where }),
            this.prisma.invoice.findMany({
                where,
                include: { lineItems: { orderBy: { position: 'asc' } } },
                orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /**
     * Mints the next invoice number and writes the invoice + its lines, all in
     * one transaction.
     *
     * This is the method the gap-free numbering requirement lives in. The
     * sequence row is read and written inside the same transaction as the
     * insert, so a failure anywhere — a constraint violation, a lost
     * connection — rolls the counter back with the invoice. A Postgres
     * `SEQUENCE` could not do this: `nextval` is deliberately non-transactional
     * and a rolled-back invoice would burn its number, leaving a hole in a
     * series that an auditor will ask about.
     *
     * `upsert` on the sequence row makes the first invoice of a new fiscal year
     * self-initialising, so nothing has to remember to seed April.
     */
    async createWithNumber(input: {
        countryCode: string;
        fiscalYear: string;
        /** Builds the row once the sequence number is known. */
        build: (sequence: number) => {
            invoice: Omit<Prisma.InvoiceUncheckedCreateInput, 'id' | 'lineItems'>;
            lines: Omit<Prisma.InvoiceLineItemUncheckedCreateInput, 'id' | 'invoiceId'>[];
        };
    }): Promise<InvoiceWithLines> {
        return this.prisma.$transaction(async (tx) => {
            const sequence = await tx.invoiceNumberSequence.upsert({
                where: {
                    countryCode_fiscalYear: {
                        countryCode: input.countryCode,
                        fiscalYear: input.fiscalYear,
                    },
                },
                create: {
                    id: randomUUID(),
                    countryCode: input.countryCode,
                    fiscalYear: input.fiscalYear,
                    lastNumber: 1,
                    updatedAt: new Date(),
                },
                update: { lastNumber: { increment: 1 }, updatedAt: new Date() },
            });

            const { invoice, lines } = input.build(sequence.lastNumber);
            const invoiceId = randomUUID();

            const created = await tx.invoice.create({
                data: { ...invoice, id: invoiceId },
            });
            await tx.invoiceLineItem.createMany({
                data: lines.map((line) => ({ ...line, id: randomUUID(), invoiceId })),
            });

            const lineItems = await tx.invoiceLineItem.findMany({
                where: { invoiceId },
                orderBy: { position: 'asc' },
            });
            return { ...created, lineItems };
        });
    }

    /**
     * Records where the rendered PDF landed.
     *
     * Separate from creation on purpose: the invoice row is the statutory
     * record and must exist even if S3 is briefly unreachable. A row with a
     * null `pdfStorageRef` is a valid, issued invoice whose document has not
     * been produced yet, and re-rendering it is idempotent.
     */
    attachDocument(
        id: string,
        document: { storageRef: string; sha256: string; renderedAt: Date },
    ): Promise<Invoice> {
        return this.prisma.invoice.update({
            where: { id },
            data: {
                pdfStorageRef: document.storageRef,
                pdfSha256: document.sha256,
                pdfRenderedAt: document.renderedAt,
                updatedAt: new Date(),
            },
        });
    }

    markDelivered(id: string, at: Date): Promise<Invoice> {
        return this.prisma.invoice.update({
            where: { id },
            data: { deliveredAt: at, updatedAt: new Date() },
        });
    }

    /** VOID or CORRECTED. The row's figures are never touched. */
    setStatus(
        id: string,
        status: 'VOID' | 'CORRECTED',
        detail: { voidReason?: string; supersedesInvoiceId?: string } = {},
    ): Promise<Invoice> {
        return this.prisma.invoice.update({
            where: { id },
            data: {
                status,
                ...(detail.voidReason ? { voidReason: detail.voidReason } : {}),
                ...(detail.supersedesInvoiceId
                    ? { supersedesInvoiceId: detail.supersedesInvoiceId }
                    : {}),
                updatedAt: new Date(),
            },
        });
    }

    /**
     * The invoice-level totals behind a return, for one jurisdiction and
     * period.
     *
     * VOID invoices are excluded — a cancelled document contributes nothing to
     * a return — but CORRECTED ones are NOT: a corrected invoice was issued and
     * reported, and the correction is a separate line in the trail, not an
     * erasure of the original.
     */
    async summariseForPeriod(filter: {
        countryCode: string;
        stateCode?: string | undefined;
        periodStart: Date;
        periodEnd: Date;
    }): Promise<{
        invoiceCount: number;
        subtotal: string;
        taxAmount: string;
        totalAmount: string;
    }> {
        const where: Prisma.InvoiceWhereInput = {
            countryCode: filter.countryCode,
            ...(filter.stateCode ? { stateCode: filter.stateCode } : {}),
            status: { not: 'VOID' },
            invoiceDate: { gte: filter.periodStart, lt: filter.periodEnd },
        };
        const result = await this.prisma.invoice.aggregate({
            where,
            _count: { _all: true },
            _sum: { subtotal: true, taxAmount: true, totalAmount: true },
        });
        return {
            invoiceCount: result._count._all,
            subtotal: (result._sum.subtotal ?? 0).toString(),
            taxAmount: (result._sum.taxAmount ?? 0).toString(),
            totalAmount: (result._sum.totalAmount ?? 0).toString(),
        };
    }

    /**
     * The HSN-wise breakdown GSTR-1 is filed with (§1.5 of the compliance
     * guide), grouped at the **line** level because that is the level the
     * return is read at.
     */
    async summariseByClassification(filter: {
        countryCode: string;
        stateCode?: string | undefined;
        periodStart: Date;
        periodEnd: Date;
    }): Promise<
        { code: string; taxRate: string; quantity: number; taxableValue: string; taxAmount: string }[]
    > {
        const lines = await this.prisma.invoiceLineItem.findMany({
            where: {
                invoice: {
                    countryCode: filter.countryCode,
                    ...(filter.stateCode ? { stateCode: filter.stateCode } : {}),
                    status: { not: 'VOID' },
                    invoiceDate: { gte: filter.periodStart, lt: filter.periodEnd },
                },
            },
            select: {
                hsnCode: true,
                sacCode: true,
                taxRate: true,
                quantity: true,
                lineSubtotal: true,
                taxAmount: true,
            },
        });

        // Grouped in memory rather than with `groupBy`: the key is
        // "HSN or SAC, whichever is set", which is a COALESCE Prisma cannot
        // express in a groupBy, and the row count here is a month of line
        // items — small enough that the simple version is the right one.
        const buckets = new Map<
            string,
            { code: string; taxRate: string; quantity: number; taxableValue: bigint; taxAmount: bigint }
        >();
        for (const line of lines) {
            const code = line.hsnCode ?? line.sacCode ?? 'UNCLASSIFIED';
            const taxRate = line.taxRate.toString();
            const key = `${code}|${taxRate}`;
            const bucket = buckets.get(key) ?? {
                code,
                taxRate,
                quantity: 0,
                taxableValue: 0n,
                taxAmount: 0n,
            };
            bucket.quantity += line.quantity;
            bucket.taxableValue += toMinor(line.lineSubtotal.toString());
            bucket.taxAmount += toMinor(line.taxAmount.toString());
            buckets.set(key, bucket);
        }

        return [...buckets.values()]
            .map((bucket) => ({
                code: bucket.code,
                taxRate: bucket.taxRate,
                quantity: bucket.quantity,
                taxableValue: fromMinor(bucket.taxableValue),
                taxAmount: fromMinor(bucket.taxAmount),
            }))
            .sort((a, b) => a.code.localeCompare(b.code));
    }
}

/** '2000.00' -> 200000n. Summing in minor units keeps floats out entirely. */
function toMinor(value: string): bigint {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2));
}

function fromMinor(value: bigint): string {
    const negative = value < 0n;
    const magnitude = negative ? -value : value;
    const whole = magnitude / 100n;
    const fraction = (magnitude % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
}

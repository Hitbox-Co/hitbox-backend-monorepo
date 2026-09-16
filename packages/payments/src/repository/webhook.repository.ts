import { Prisma } from '@hitbox/database';
import type { PaymentWebhookEvent, PrismaClient } from '@hitbox/database';
import type { ListWebhookEventsQuery } from '../dto/payments.dto';

/**
 * Webhook deliveries.
 *
 * The primary key is the **provider's** event id, which makes the row's
 * existence the replay guard: there is no "have I seen this?" query whose
 * answer can be stale between two concurrent deliveries, because the insert
 * itself is the check.
 */
export class WebhookRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Records a delivery, or reports that it is a replay.
     *
     * `created: false` means this exact event id is already in the table, and
     * the caller stops there. Stripe retries a delivery for up to three days
     * on any non-2xx, so this path is hit in normal operation, not only under
     * attack — which is why it returns an ordinary result rather than throwing.
     */
    async record(
        data: Prisma.PaymentWebhookEventUncheckedCreateInput,
    ): Promise<{ event: PaymentWebhookEvent; created: boolean }> {
        try {
            const event = await this.prisma.paymentWebhookEvent.create({ data });
            return { event, created: true };
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                const existing = await this.prisma.paymentWebhookEvent.findUnique({
                    where: { id: data.id },
                });
                if (existing) return { event: existing, created: false };
            }
            throw error;
        }
    }

    markProcessed(id: string, processedAt: Date) {
        return this.prisma.paymentWebhookEvent.update({
            where: { id },
            data: { processedAt, processingError: null },
        });
    }

    /**
     * Records a processing failure without discarding the delivery.
     *
     * The row stays unprocessed so it appears in the replay queue. Dropping a
     * webhook that failed to process is how an order silently never gets
     * marked paid.
     */
    markFailed(id: string, error: string) {
        return this.prisma.paymentWebhookEvent.update({
            where: { id },
            data: { processingError: error.slice(0, 1000) },
        });
    }

    findById(id: string): Promise<PaymentWebhookEvent | null> {
        return this.prisma.paymentWebhookEvent.findUnique({ where: { id } });
    }

    async list(
        query: ListWebhookEventsQuery & { skip: number; take: number },
    ): Promise<{ total: number; items: PaymentWebhookEvent[] }> {
        const where: Prisma.PaymentWebhookEventWhereInput = {
            ...(query.provider ? { provider: query.provider } : {}),
            ...(query.eventType ? { eventType: query.eventType } : {}),
            ...(query.unprocessedOnly ? { processedAt: null } : {}),
        };
        const [total, items] = await Promise.all([
            this.prisma.paymentWebhookEvent.count({ where }),
            this.prisma.paymentWebhookEvent.findMany({
                where,
                orderBy: { receivedAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }
}

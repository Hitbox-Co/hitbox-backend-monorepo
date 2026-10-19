import type { Prisma, PrismaClient } from '@hitbox/database';

/**
 * Idempotency ledger for Clerk webhook deliveries (svix-id keyed).
 */
export class WebhookEventRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async hasProcessed(id: string): Promise<boolean> {
        const found = await this.prisma.authWebhookEvent.findUnique({
            where: { id },
            select: { id: true },
        });
        return found !== null;
    }

    async markProcessed(id: string, type: string, payload: unknown): Promise<void> {
        const now = new Date();
        await this.prisma.authWebhookEvent.create({
            // `type` was renamed `eventType` in the schema decomposition, and
            // the model carries no column defaults, so both timestamps are
            // written explicitly here.
            data: {
                id,
                eventType: type,
                payload: payload as Prisma.InputJsonValue,
                receivedAt: now,
                processedAt: now,
            },
        });
    }
}

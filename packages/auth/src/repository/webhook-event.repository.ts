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
        await this.prisma.authWebhookEvent.create({
            data: { id, type, payload: payload as Prisma.InputJsonValue },
        });
    }
}

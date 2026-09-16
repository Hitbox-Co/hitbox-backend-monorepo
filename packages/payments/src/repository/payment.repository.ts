import { Prisma } from '@hitbox/database';
import type { PaymentTransaction, PrismaClient } from '@hitbox/database';
import type { ListPaymentsQuery } from '../dto/payments.dto';

/** Charge attempts. The only place in this module that touches them. */
export class PaymentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<PaymentTransaction | null> {
        return this.prisma.paymentTransaction.findUnique({ where: { id } });
    }

    findByOrder(orderId: string): Promise<PaymentTransaction[]> {
        return this.prisma.paymentTransaction.findMany({
            where: { orderId },
            orderBy: { createdAt: 'desc' },
        });
    }

    findByGatewayRef(gatewayRef: string): Promise<PaymentTransaction | null> {
        return this.prisma.paymentTransaction.findFirst({ where: { gatewayRef } });
    }

    /**
     * Creates a charge attempt, or returns the existing one for the same
     * idempotency key.
     *
     * The key is UNIQUE in the schema, so a client that retries a checkout —
     * double-tapped button, flaky network, a native app resuming — gets the
     * same transaction back rather than a second charge against the same
     * order. This is the first of the two idempotency guards in the payment
     * path; the webhook table is the second.
     */
    async createOrGet(
        data: Prisma.PaymentTransactionUncheckedCreateInput,
    ): Promise<{ transaction: PaymentTransaction; created: boolean }> {
        try {
            const transaction = await this.prisma.paymentTransaction.create({ data });
            return { transaction, created: true };
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                const existing = await this.prisma.paymentTransaction.findUnique({
                    where: { idempotencyKey: data.idempotencyKey },
                });
                if (existing) return { transaction: existing, created: false };
            }
            throw error;
        }
    }

    /**
     * Status change, guarded on the status it is moving from.
     *
     * Every settlement path runs through here, and every settlement path is
     * reachable twice (the webhook retried, the client polled, an operator
     * pressed the button). The guard is what makes the second one a no-op
     * instead of a second revenue posting.
     */
    async transition(input: {
        id: string;
        from: Prisma.PaymentTransactionWhereInput['status'];
        data: Prisma.PaymentTransactionUncheckedUpdateManyInput;
        tx?: Prisma.TransactionClient;
    }): Promise<number> {
        const client = input.tx ?? this.prisma;
        const result = await client.paymentTransaction.updateMany({
            where: { id: input.id, ...(input.from ? { status: input.from } : {}) },
            data: { ...input.data, updatedAt: new Date() },
        });
        return result.count;
    }

    async list(
        query: ListPaymentsQuery & {
            scopeFilter: Prisma.PaymentTransactionWhereInput;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: PaymentTransaction[] }> {
        const where: Prisma.PaymentTransactionWhereInput = {
            ...query.scopeFilter,
            ...(query.orderId ? { orderId: query.orderId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.gateway ? { gateway: query.gateway } : {}),
            ...(query.currency ? { currency: query.currency } : {}),
            ...(query.needsReview !== undefined ? { needsReview: query.needsReview } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.paymentTransaction.count({ where }),
            this.prisma.paymentTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /** The most recent successful charge on an order — what a refund reverses. */
    findSettledForOrder(orderId: string): Promise<PaymentTransaction | null> {
        return this.prisma.paymentTransaction.findFirst({
            where: { orderId, status: 'SUCCEEDED' },
            orderBy: { createdAt: 'desc' },
        });
    }
}

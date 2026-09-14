import { Prisma } from '@hitbox/database';
import type { OrderStatus, PrismaClient } from '@hitbox/database';
import type { ListOrdersQuery } from '../dto/order.dto';

/**
 * The only place in this module that touches Prisma.
 *
 * Both projections resolve the buyer's **email** and the product's
 * **groupCode** at the database, rather than returning ids for the client to
 * look up. Two joins here replace an N+1 of lookups per page.
 */
const listSelect = {
    id: true,
    status: true,
    quantity: true,
    productId: true,
    variantId: true,
    skuId: true,
    marketId: true,
    organizationId: true,
    buyerId: true,
    placedAt: true,
    shippedAt: true,
    deliveredAt: true,
    unitPrice: true,
    amount: true,
    currency: true,
    buyer: { select: { email: true, fullName: true } },
    product: { select: { groupCode: true, name: true } },
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof listSelect }>;

const detailSelect = {
    ...listSelect,
    gateway: true,
    trackingNote: true,
    termsAcceptedAt: true,
    updatedAt: true,
    archivedAt: true,
    market: { select: { id: true, code: true, name: true, currency: true } },

    // The serialized unit the order actually owns, once payment settled.
    sku: {
        select: {
            id: true, skuCode: true, serialNumber: true, claimedStatus: true,
            tagId: true, tagLifecycleState: true, ownerId: true, resaleBlocked: true,
        },
    },
    // …and every hold placed for it, which is what explains an order that has
    // not shipped yet.
    inventoryReservations: {
        orderBy: { createdAt: 'asc' },
        select: {
            id: true, status: true, expiresAt: true,
            sku: {
                select: {
                    id: true, skuCode: true, serialNumber: true, claimedStatus: true,
                    tagId: true, tagLifecycleState: true, ownerId: true, resaleBlocked: true,
                },
            },
        },
    },
    orderAddresss: {
        select: {
            usage: true, label: true, labelCustom: true, recipientName: true,
            line1: true, line2: true, city: true, state: true,
            postalCode: true, countryCode: true, phone: true,
        },
    },
    paymentTransactions: {
        orderBy: { createdAt: 'desc' },
        select: {
            id: true, status: true, gateway: true, amount: true,
            currency: true, needsReview: true, failureReason: true, createdAt: true,
        },
    },
    refundRequests: {
        orderBy: { createdAt: 'desc' },
        select: {
            id: true, status: true, amount: true, reason: true, createdAt: true,
        },
    },
} satisfies Prisma.OrderSelect;

export type OrderDetailRow = Prisma.OrderGetPayload<{ select: typeof detailSelect }>;

export class OrderRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(
        query: ListOrdersQuery & { organizationIds: string[] | null; skip: number; take: number },
    ): Promise<{ total: number; items: OrderListRow[] }> {
        const where: Prisma.OrderWhereInput = {
            archivedAt: null,
            ...(query.organizationIds === null
                ? {}
                : { organizationId: { in: query.organizationIds } }),
            ...(query.status ? { status: query.status } : {}),
            ...(query.marketId ? { marketId: query.marketId } : {}),
            ...(query.organizationId ? { organizationId: query.organizationId } : {}),
            ...(query.buyerEmail
                ? { buyer: { email: { contains: query.buyerEmail, mode: Prisma.QueryMode.insensitive } } }
                : {}),
            ...(query.productCode ? { product: { groupCode: query.productCode } } : {}),
            ...(query.from || query.to
                ? {
                    placedAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lt: query.to } : {}),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                select: listSelect,
                orderBy: { placedAt: 'desc' },
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    findById(id: string): Promise<OrderDetailRow | null> {
        return this.prisma.order.findUnique({ where: { id }, select: detailSelect });
    }

    /**
     * Status change, guarded by the order's current status.
     *
     * `updateMany` with `status` in the WHERE is the concurrency control: two
     * operators pressing "Mark shipped" at once produce one update and one
     * zero-count result, and the caller turns that into a clear conflict
     * rather than a lost write.
     */
    async changeStatus(input: {
        id: string;
        from: OrderStatus;
        to: OrderStatus;
        trackingNote?: string | undefined;
        timestamps: Record<string, Date>;
        now: Date;
    }): Promise<number> {
        const result = await this.prisma.order.updateMany({
            where: { id: input.id, status: input.from },
            data: {
                status: input.to,
                ...(input.trackingNote !== undefined ? { trackingNote: input.trackingNote } : {}),
                ...input.timestamps,
                updatedAt: input.now,
            },
        });
        return result.count;
    }
}

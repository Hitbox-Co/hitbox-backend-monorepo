import { randomUUID } from 'node:crypto';
import type { OrderStatus, OrderStatusSource, Prisma } from '@hitbox/database';

export interface StatusHistoryEntry {
    orderId: string;
    from: OrderStatus | null;
    to: OrderStatus;
    source: OrderStatusSource;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Record<string, string | null>;
    at: Date;
}

/**
 * Appends one row to the order's timeline.
 *
 * Always called with the transaction that changed the status — never after
 * it — so a status write and its history row commit or roll back together.
 * That is the whole guarantee: the timeline cannot miss a step, and cannot
 * show a step that did not happen.
 */
export async function recordStatusChange(
    tx: Prisma.TransactionClient,
    entry: StatusHistoryEntry,
): Promise<void> {
    await tx.orderStatusHistory.create({
        data: {
            id: randomUUID(),
            orderId: entry.orderId,
            fromStatus: entry.from,
            toStatus: entry.to,
            source: entry.source,
            actorId: entry.actorId ?? null,
            reason: entry.reason ? entry.reason.slice(0, 500) : null,
            ...(entry.metadata ? { metadata: entry.metadata } : {}),
            occurredAt: entry.at,
        },
    });
}

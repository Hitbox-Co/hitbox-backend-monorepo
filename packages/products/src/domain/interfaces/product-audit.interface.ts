/**
 * The compliance trail for catalog actions that change what the public can
 * buy, as a port.
 *
 * Only publication goes through it today. An ordinary field edit is already
 * recoverable from the row; taking a drop live is the moment it becomes
 * purchasable, and "who made this live, and on whose approval" has to stay
 * answerable.
 *
 * The port speaks plain records — no Prisma types cross it — so this module
 * never imports the audit module or its JSON types.
 */
export interface ProductAuditInput {
    eventType: string;
    actorId: string;
    organizationId: string | null;
    productId: string;
    result: 'SUCCESS' | 'DENIED';
    correlationId: string;
    before?: Record<string, unknown> | undefined;
    after?: Record<string, unknown> | undefined;
    metadata?: Record<string, unknown> | undefined;
}

export interface IProductAudit {
    /**
     * Awaited, and allowed to throw. A drop that went live with no record of
     * who published it is exactly the gap an audit exists to close, so the
     * request fails with the audit rather than succeeding quietly.
     */
    record(input: ProductAuditInput): Promise<void>;
}

/** Stand-in for a test harness. A server must pass the real recorder. */
export const NOOP_PRODUCT_AUDIT: IProductAudit = {
    record: async () => { },
};

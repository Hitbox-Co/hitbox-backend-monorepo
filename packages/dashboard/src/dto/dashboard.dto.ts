import { z } from 'zod';
import { DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT } from '../constants/dashboard.constant';

/**
 * Query contracts. `organizationId` and `marketId` are **filters**, never
 * grants — they can only narrow a scope the caller already holds, and the
 * access layer rejects one that falls outside it.
 */

const isoDate = z.coerce.date();

export const dashboardQuerySchema = z
    .object({
        period: z.enum(['week', 'month', 'year', 'custom']).default('month'),
        from: isoDate.optional(),
        to: isoDate.optional(),
        organizationId: z.string().uuid().optional(),
        marketId: z.string().uuid().optional(),
    })
    .refine((q) => q.period !== 'custom' || (q.from && q.to), {
        message: 'from and to are required when period=custom',
        path: ['from'],
    });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(DASHBOARD_MAX_LIMIT).default(DASHBOARD_DEFAULT_LIMIT),
};

export const paginatedQuerySchema = dashboardQuerySchema.innerType().extend(pagination);
export type PaginatedQuery = z.infer<typeof paginatedQuerySchema>;

export const ordersQuerySchema = paginatedQuerySchema.extend({
    status: z
        .enum([
            'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED',
            'DELIVERED', 'CANCELLED', 'REFUNDED',
        ])
        .optional(),
});
export type OrdersQuery = z.infer<typeof ordersQuerySchema>;

export const productsQuerySchema = paginatedQuerySchema.extend({
    status: z
        .enum([
            'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED',
            'PUBLISHED', 'ACTIVE', 'ENDED', 'ARCHIVED',
        ])
        .optional(),
});
export type ProductsQuery = z.infer<typeof productsQuerySchema>;

export const activityQuerySchema = paginatedQuerySchema.extend({
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const releaseApprovalsQuerySchema = paginatedQuerySchema.extend({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});
export type ReleaseApprovalsQuery = z.infer<typeof releaseApprovalsQuerySchema>;

export const provenanceQuerySchema = paginatedQuerySchema.extend({
    caseType: z.enum(['LOST', 'DAMAGED', 'STOLEN', 'CLONED', 'DISPUTE']).optional(),
    status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'REJECTED']).optional(),
});
export type ProvenanceQuery = z.infer<typeof provenanceQuerySchema>;

export const supplyQuerySchema = paginatedQuerySchema.extend({
    vendorId: z.string().uuid().optional(),
});
export type SupplyQuery = z.infer<typeof supplyQuerySchema>;

export const resaleQuerySchema = paginatedQuerySchema.extend({
    status: z.enum(['ACTIVE', 'SOLD', 'CANCELLED', 'BLOCKED']).optional(),
});
export type ResaleQuery = z.infer<typeof resaleQuerySchema>;

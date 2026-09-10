import { AuditActionResult, AuditSeverity } from '@hitbox/database';
import { z } from 'zod';
import { AUDIT_QUERY_DEFAULT_LIMIT, AUDIT_QUERY_MAX_LIMIT } from '../constants/audit.constant';
import { isKnownAuditEventType } from '../domain/audit-event-catalog';

/**
 * An event type is accepted as a filter even when it is not in the code
 * catalog — an operator may have registered one directly, and refusing to
 * *search* for it would hide rows that exist. Unknown keys simply match
 * nothing, which is the honest answer.
 */
const eventTypeFilterSchema = z.string().min(1).max(120);

/**
 * The read filter, straight from the access patterns the indexes support.
 * Every field is optional; the unfiltered query is a time-ordered scan of the
 * most recent page, which is what an operator opening the screen wants.
 */
export const auditEventQuerySchema = z
    .object({
        eventType: eventTypeFilterSchema.optional(),
        actorId: z.string().uuid().optional(),
        organizationId: z.string().uuid().optional(),
        resourceType: z.string().min(1).max(120).optional(),
        resourceId: z.string().uuid().optional(),
        actionResult: z.nativeEnum(AuditActionResult).optional(),
        severity: z.nativeEnum(AuditSeverity).optional(),
        correlationId: z.string().uuid().optional(),
        /** Inclusive. */
        from: z.coerce.date().optional(),
        /** Exclusive, so consecutive windows cannot double-count an event. */
        to: z.coerce.date().optional(),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(AUDIT_QUERY_MAX_LIMIT)
            .default(AUDIT_QUERY_DEFAULT_LIMIT),
        cursor: z.string().min(1).max(512).optional(),
    })
    .superRefine((query, ctx) => {
        if (query.from && query.to && query.from >= query.to) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: '`to` must be after `from`',
            });
        }
        // `resourceId` without `resourceType` cannot use the
        // (resourceType, resourceId) index and would scan the table. Ids are
        // also only unique within a type, so the result would mix a product
        // and a role that happen to share an id.
        if (query.resourceId && !query.resourceType) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['resourceType'],
                message: 'resourceType is required when filtering by resourceId',
            });
        }
    });
export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;

/**
 * Bulk export. Deliberately narrower than the read filter: an export must name
 * a bounded time window and say why it is being taken, because the answer to
 * "who pulled the whole trail, when, and what for?" has to be in the trail
 * itself.
 */
export const auditExportQuerySchema = z
    .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        eventType: eventTypeFilterSchema.optional(),
        organizationId: z.string().uuid().optional(),
        severity: z.nativeEnum(AuditSeverity).optional(),
        /** Recorded in the audit.export event's metadata. */
        reason: z.string().min(10).max(500),
    })
    .superRefine((query, ctx) => {
        if (query.from >= query.to) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: '`to` must be after `from`',
            });
        }
    });
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

export const listEventTypesQuerySchema = z.object({
    includeInactive: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
});
export type ListEventTypesQuery = z.infer<typeof listEventTypesQuerySchema>;

/**
 * A retention change. `notes` is mandatory, and there is no route to create or
 * delete a policy — there is exactly one row per severity, forever, so the
 * pruner never has to decide what to do about a missing one.
 */
export const updateRetentionPolicySchema = z.object({
    /**
     * Capped at a century. The floor is one day rather than zero: a policy of
     * zero would make the next prune sweep delete everything at that severity,
     * and "I meant to type 30" should not be able to do that.
     */
    retentionDays: z.number().int().min(1).max(36_500),
    notes: z.string().min(10).max(1_000),
});
export type UpdateRetentionPolicyDto = z.infer<typeof updateRetentionPolicySchema>;

export const retentionSeverityParamSchema = z.nativeEnum(AuditSeverity);

/** Re-exported so a caller can check a key before recording against it. */
export { isKnownAuditEventType };

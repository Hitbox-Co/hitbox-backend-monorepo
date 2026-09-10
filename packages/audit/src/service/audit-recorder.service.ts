import { randomUUID } from 'node:crypto';
import { AuditActionResult, AuditSeverity } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { AUDIT_ERROR_CODES, AUDIT_EVENTS } from '../constants/audit.constant';
import { findAuditEventType } from '../domain/audit-event-catalog';
import type { AuditEventTypeDefinition } from '../domain/audit-event-catalog';
import type {
    AuditRecordInput,
    AuditRecordOptions,
    IAuditRecorder,
} from '../domain/interfaces/audit-recorder.interface';
import type { AuditEventRepository, AuditEventRow } from '../repository/audit-event.repository';
import type { AuditEventTypeRepository } from '../repository/audit-event-type.repository';

export interface AuditRecorderDeps {
    events: AuditEventRepository;
    eventTypes: AuditEventTypeRepository;
    eventBus: IEventBus;
    logger: Logger;
    /** Injectable clock. Tests need a fixed now; production never passes it. */
    now?: () => Date;
}

/** What the recorder needs to know about an event type, from either source. */
interface ResolvedEventType {
    defaultSeverity: AuditSeverity;
    isActive: boolean;
}

/**
 * Writes the trail.
 *
 * The asymmetry between `record` and `emit` is the whole design (see
 * IAuditRecorder): CRITICAL work is accountable or it does not happen, and
 * high-frequency denials are recorded on a path that cannot take the request
 * down with it.
 */
export class AuditRecorderService implements IAuditRecorder {
    /**
     * Event types this process has resolved from the database — only ever
     * consulted for keys absent from the code catalog, i.e. ones an operator
     * registered directly.
     *
     * Unbounded is safe here in a way it would not be for user-keyed data: the
     * key space is the event catalog, which is tens of rows and only grows by
     * a deliberate act. Negative results are NOT cached, so registering a
     * missing event type takes effect without a restart.
     */
    private readonly resolvedFromDb = new Map<string, ResolvedEventType>();

    constructor(private readonly deps: AuditRecorderDeps) { }

    private get now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /**
     * Awaited write. Throws if the event cannot be persisted, so the caller's
     * operation fails with it.
     *
     * Pass `options.tx` whenever the caller has a transaction: an audited
     * change that commits while its audit row failed is the failure mode this
     * method exists to prevent, and awaiting alone does not prevent it — it
     * only guarantees the caller finds out.
     */
    async record(input: AuditRecordInput, options: AuditRecordOptions = {}): Promise<void> {
        const row = await this.buildRow(input, { strict: true });
        try {
            await this.deps.events.append(row, options.tx);
        } catch (error) {
            this.deps.logger.error(
                { err: error, eventType: row.eventType, correlationId: row.correlationId },
                'audit record failed — failing the operation it describes',
            );
            throw new AppError(
                `Could not record the audit event for ${row.eventType}. The operation was not completed.`,
                500,
                AUDIT_ERROR_CODES.WRITE_FAILED,
                { eventType: row.eventType, correlationId: row.correlationId },
            );
        }
    }

    /**
     * Best-effort write. Never throws, never needs awaiting.
     *
     * Returns void rather than a promise on purpose: a `Promise<void>` here
     * would invite `await audit.emit(...)`, and a caller who awaits a
     * best-effort write has quietly put the audit database back on the request
     * path — which is the thing this method exists to keep off it.
     */
    emit(input: AuditRecordInput): void {
        void this.writeBestEffort(input);
    }

    private async writeBestEffort(input: AuditRecordInput): Promise<void> {
        try {
            const row = await this.buildRow(input, { strict: false });
            await this.deps.events.append(row);
        } catch (error) {
            // Deliberately terminal: logged at error level, and published so
            // an alert can fire on a trail developing holes, but never
            // rethrown into the caller's request.
            this.deps.logger.error(
                {
                    err: error,
                    eventType: input.eventType,
                    correlationId: input.correlationId,
                    actorId: input.actor.id ?? null,
                    result: input.result,
                },
                'audit emit dropped',
            );
            try {
                await this.deps.eventBus.publish(AUDIT_EVENTS.WRITE_DROPPED, {
                    eventType: input.eventType,
                    correlationId: input.correlationId,
                    result: input.result,
                });
            } catch {
                // The bus is the last thing left to fail. Nothing above this
                // can act on it, and throwing here would defeat the method.
            }
        }
    }

    private async buildRow(
        input: AuditRecordInput,
        options: { strict: boolean },
    ): Promise<AuditEventRow> {
        if (!input.correlationId) {
            throw AppError.badRequest(
                `Audit event ${input.eventType} has no correlationId. An event that cannot be joined to the request that caused it loses most of its value.`,
                AUDIT_ERROR_CODES.MISSING_CORRELATION_ID,
            );
        }

        const eventType = await this.resolveEventType(input.eventType);
        if (!eventType) {
            throw new AppError(
                `Audit event type "${input.eventType}" is not registered. Add it to AUDIT_EVENT_CATALOG (or insert the AuditEventType row) before recording it.`,
                options.strict ? 500 : 400,
                AUDIT_ERROR_CODES.UNKNOWN_EVENT_TYPE,
                { eventType: input.eventType },
            );
        }

        if (!eventType.isActive) {
            // Retired, but still written: `isActive` means "do not use this
            // going forward", and refusing the write would turn a catalog
            // tidy-up into an outage on whatever path still calls it. The
            // warning is the signal to go fix the call site.
            this.deps.logger.warn(
                { eventType: input.eventType },
                'recording an audit event whose type is marked inactive',
            );
        }

        const now = this.now;

        return {
            eventId: randomUUID(),
            occurredAt: input.occurredAt ?? now,
            eventType: input.eventType,
            actorType: input.actor.type,
            actorId: input.actor.id ?? null,
            actorRoleSnapshot: input.actor.roleSnapshot ?? null,
            organizationId: input.organizationId ?? null,
            resourceType: input.resource?.type ?? null,
            resourceId: input.resource?.id ?? null,
            actionResult: input.result,
            severity: resolveSeverity(input, eventType.defaultSeverity),
            beforeState: input.beforeState ?? null,
            afterState: input.afterState ?? null,
            ipAddress: input.request?.ipAddress ?? null,
            userAgent: input.request?.userAgent ?? null,
            deviceId: input.request?.deviceId ?? null,
            correlationId: input.correlationId,
            ledgerReferenceId: input.ledgerReferenceId ?? null,
            metadata: input.metadata ?? {},
            // Always the write time, never the caller's. The gap between this
            // and occurredAt is how clock skew and late-arriving writes stay
            // visible instead of being smoothed away.
            insertedAt: now,
        };
    }

    /**
     * Code catalog first — that is the common case and costs no round trip.
     * Falls back to the table for a key an operator registered directly, which
     * is the reason AuditEventType is a table at all.
     */
    private async resolveEventType(eventType: string): Promise<ResolvedEventType | null> {
        const fromCode: AuditEventTypeDefinition | undefined = findAuditEventType(eventType);
        if (fromCode) {
            return { defaultSeverity: fromCode.defaultSeverity, isActive: true };
        }

        const cached = this.resolvedFromDb.get(eventType);
        if (cached) return cached;

        const row = await this.deps.eventTypes.findByKey(eventType);
        if (!row) return null;

        const resolved: ResolvedEventType = {
            defaultSeverity: row.defaultSeverity,
            isActive: row.isActive,
        };
        this.resolvedFromDb.set(eventType, resolved);
        return resolved;
    }
}

/**
 * Severity for one row.
 *
 * An explicit `severity` on the input wins. Otherwise a DENIED result is a
 * WARNING regardless of how serious the event type is, because nothing
 * changed: a refused `product.delete` is worth keeping and worth alerting on
 * in aggregate, but it is not the same class of thing as a delete that
 * happened. Left at CRITICAL, routine denials would bury the handful of
 * genuinely critical rows a review is supposed to read one by one.
 *
 * FAILURE keeps the catalog default — a refund that errored halfway is exactly
 * as serious as one that succeeded, and possibly more.
 */
function resolveSeverity(input: AuditRecordInput, defaultSeverity: AuditSeverity): AuditSeverity {
    if (input.severity) return input.severity;
    if (input.result === AuditActionResult.DENIED) return AuditSeverity.WARNING;
    return defaultSeverity;
}

/**
 * @hitbox/audit
 *
 * The compliance trail — event type catalog, append-only events, retention
 * policy, and the read API over them.
 *
 * Business modules should need only one thing from here: the `IAuditRecorder`
 * port, with its two methods.
 *
 *   `await audit.record({ … }, { tx })`  CRITICAL work. Fails the operation
 *                                        if the record cannot be written.
 *   `audit.emit({ … })`                  Hot paths, chiefly DENIED results.
 *                                        Never throws, never awaited.
 *
 * Nothing outside this package should construct an audit row by hand, and
 * nothing inside it holds a Prisma relation to another module's tables — the
 * trail has to stay readable after the records it describes are archived or
 * deleted (see the header of prisma/audit.prisma).
 */

// Module factory
export { createAuditModule } from './module';
export type { AuditModule, AuditModuleDeps, AuditPermissionGuard } from './module';

// Constants
export {
    AUDIT_CAPABILITIES,
    AUDIT_ERROR_CODES,
    AUDIT_EVENTS,
    AUDIT_MODULE,
    AUDIT_QUERY_DEFAULT_LIMIT,
    AUDIT_QUERY_MAX_LIMIT,
} from './constants/audit.constant';
export type { AuditEventName } from './constants/audit.constant';

// The write port — what other modules depend on
export { NOOP_AUDIT_RECORDER } from './domain/interfaces/audit-recorder.interface';
export type {
    AuditActor,
    AuditRecordInput,
    AuditRecordOptions,
    AuditRequestContext,
    AuditResource,
    IAuditRecorder,
} from './domain/interfaces/audit-recorder.interface';

// Event catalog — the authority on which events exist and how serious each is
export {
    AUDIT_EVENT_CATALOG,
    AUDIT_EVENT_TYPES,
    AuditPersonaGroup,
    findAuditEventType,
    isKnownAuditEventType,
} from './domain/audit-event-catalog';
export type {
    AuditEventTypeDefinition,
    KnownAuditEventType,
} from './domain/audit-event-catalog';

// Retention
export { RETENTION_DEFAULTS, retentionCutoff } from './domain/retention-defaults';
export type { RetentionPolicyDefinition } from './domain/retention-defaults';

// Correlation — mount `correlationId()` first, ahead of authentication
export {
    CORRELATION_ID_HEADER,
    correlationId,
    correlationIdOf,
} from './middleware/correlation-id.middleware';
export type { CorrelationIdOptions } from './middleware/correlation-id.middleware';

// Services (constructed by the module factory; exported for direct use in
// jobs and scripts that have no HTTP surface)
export { AuditRecorderService } from './service/audit-recorder.service';
export type { AuditRecorderDeps } from './service/audit-recorder.service';
export { AuditQueryService } from './service/audit-query.service';
export type {
    AuditEventPageResponse,
    AuditQueryServiceDeps,
    AuditReader,
    AuditReaderScope,
} from './service/audit-query.service';
export { AuditRetentionService } from './service/audit-retention.service';
export type {
    AuditRetentionServiceDeps,
    RetentionPolicyView,
} from './service/audit-retention.service';

// Repositories
export { AuditEventRepository } from './repository/audit-event.repository';
export type {
    AuditEventCursor,
    AuditEventFilter,
    AuditEventPage,
    AuditEventRow,
} from './repository/audit-event.repository';
export { AuditEventTypeRepository } from './repository/audit-event-type.repository';
export type { EventTypeSyncResult } from './repository/audit-event-type.repository';
export { AuditRetentionPolicyRepository } from './repository/audit-retention-policy.repository';

// Controller contract
export type { AuditReaderResolver } from './controller/audit.controller';

// DTOs
export {
    auditEventQuerySchema,
    auditExportQuerySchema,
    listEventTypesQuerySchema,
    retentionSeverityParamSchema,
    updateRetentionPolicySchema,
} from './dto/audit.dto';
export type {
    AuditEventQuery,
    AuditExportQuery,
    ListEventTypesQuery,
    UpdateRetentionPolicyDto,
} from './dto/audit.dto';
export { decodeCursor, encodeCursor } from './dto/audit-cursor';

// Seeding
export { seedAudit } from './seed/seed-audit';
export type { AuditSeedResult } from './seed/seed-audit';

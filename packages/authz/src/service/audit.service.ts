import type { Logger } from 'pino';
import { AuditActorType, AuditResult } from '../domain/enums/audit.enum';
import type { AuditQuery, AuditRecord, AuditRepository } from '../repository/audit.repository';

interface AuditServiceDeps {
    repository: AuditRepository;
    logger: Logger;
}

/**
 * AUDIT LOGGING STRATEGY
 * ======================
 * What is audited (see docs/authorization/08-audit-logging.md):
 *   - every sensitive capability (catalog `sensitive: true`), allowed OR denied
 *   - every role assignment / revocation and membership change
 *   - every organization lifecycle change
 *   - authorization DENIALS on privileged surfaces, which is how attempted
 *     escalation becomes visible
 *
 * Two write paths, deliberately:
 *   `record()`  awaited — used where losing the record is unacceptable (role
 *               and money operations). If the write fails, the operation fails.
 *   `emit()`    fire-and-forget — used on hot paths (denials) where an audit
 *               outage must not turn into a request outage. Failures are logged
 *               at error level so they are alertable.
 */
export class AuditService {
    constructor(private readonly deps: AuditServiceDeps) { }

    /** Durable write. Awaited; propagates failure to the caller. */
    async record(record: AuditRecord): Promise<void> {
        await this.deps.repository.append(record);
    }

    /** Best-effort write for hot paths. Never throws. */
    emit(record: AuditRecord): void {
        void this.deps.repository.append(record).catch((err: unknown) => {
            this.deps.logger.error(
                { err, action: record.action, resource: record.resource },
                'audit write failed',
            );
        });
    }

    /** Convenience for the denial path used by the middleware. */
    emitDenial(input: {
        actorUserId: string | null;
        action: string;
        resource: string;
        resourceId?: string | null;
        organizationId?: string | null;
        surface?: string | null;
        ipAddress?: string | null;
        userAgent?: string | null;
        requestId?: string | null;
        reason: string;
    }): void {
        this.emit({
            actorUserId: input.actorUserId,
            actorType: AuditActorType.USER,
            action: input.action,
            resource: input.resource,
            resourceId: input.resourceId ?? null,
            organizationId: input.organizationId ?? null,
            result: AuditResult.DENIED,
            surface: input.surface ?? null,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
            requestId: input.requestId ?? null,
            metadata: { reason: input.reason },
        });
    }

    list(query: AuditQuery) {
        return this.deps.repository.list(query);
    }
}

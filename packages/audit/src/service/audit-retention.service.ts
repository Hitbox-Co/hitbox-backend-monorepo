import { AuditActionResult, AuditSeverity } from '@hitbox/database';
import type { AuditRetentionPolicy, PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { AUDIT_ERROR_CODES, AUDIT_EVENTS } from '../constants/audit.constant';
import type { IAuditRecorder } from '../domain/interfaces/audit-recorder.interface';
import { retentionCutoff } from '../domain/retention-defaults';
import type { UpdateRetentionPolicyDto } from '../dto/audit.dto';
import type { AuditEventRepository } from '../repository/audit-event.repository';
import type { AuditRetentionPolicyRepository } from '../repository/audit-retention-policy.repository';
import type { AuditReader } from './audit-query.service';

/** One severity's policy, with the date it implies. */
export interface RetentionPolicyView {
    severity: AuditSeverity;
    retentionDays: number;
    notes: string;
    /** Events older than this, at this severity, are out of policy. */
    cutoff: Date;
    /**
     * How many rows the next sweep would remove. Only populated when asked
     * for — it is a COUNT over the largest table in the platform.
     */
    pendingDeletion?: number;
}

export interface AuditRetentionServiceDeps {
    policies: AuditRetentionPolicyRepository;
    events: AuditEventRepository;
    recorder: IAuditRecorder;
    eventBus: IEventBus;
    logger: Logger;
    /**
     * Needed for the one operation in this module that spans two tables: a
     * policy change and the CRITICAL record of it must commit together.
     */
    prisma: PrismaClient;
    now?: () => Date;
}

/**
 * Retention policy: read, change, and report what a sweep would remove.
 *
 * It does not delete anything, and that is not an omission. Pruning runs as a
 * scheduled job outside the application, dropping whole monthly partitions
 * rather than issuing DELETEs — and the application's own database credentials
 * should not hold UPDATE or DELETE on AuditEvent at all, since nothing in the
 * schema prevents them (docs/audit-logging.md §7). A prune method here
 * would need exactly the grant that must not exist.
 */
export class AuditRetentionService {
    constructor(private readonly deps: AuditRetentionServiceDeps) { }

    private get now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /**
     * Every policy, with its cutoff. `withCounts` adds the row count each
     * sweep would remove — the number an operator wants to see *before*
     * shortening a window, since the alternative is finding out afterwards.
     */
    async list(options: { withCounts?: boolean } = {}): Promise<RetentionPolicyView[]> {
        const policies = await this.deps.policies.findAll();
        const now = this.now;

        return Promise.all(
            policies.map(async (policy) => {
                const view: RetentionPolicyView = {
                    severity: policy.severity,
                    retentionDays: policy.retentionDays,
                    notes: policy.notes,
                    cutoff: retentionCutoff(policy.retentionDays, now),
                };
                if (options.withCounts) {
                    view.pendingDeletion = await this.deps.events.countOlderThan(
                        policy.severity,
                        view.cutoff,
                    );
                }
                return view;
            }),
        );
    }

    /**
     * Changes one window.
     *
     * The change and its audit record share a transaction: shortening a
     * retention window is how you would destroy evidence, so a version of this
     * where the record can fail while the change lands is not worth having.
     * The bus notification is published after the commit, because a subscriber
     * must never be told about a change that rolled back.
     */
    async update(
        reader: AuditReader,
        severity: AuditSeverity,
        dto: UpdateRetentionPolicyDto,
    ): Promise<RetentionPolicyView> {
        const before = await this.deps.policies.findBySeverity(severity);
        if (!before) {
            throw AppError.notFound(
                `No retention policy exists for ${severity}. Run the audit seed.`,
                AUDIT_ERROR_CODES.RETENTION_POLICY_MISSING,
            );
        }

        const after = await this.deps.prisma.$transaction(async (tx) => {
            const updated = await this.deps.policies.update(severity, dto, tx);

            await this.deps.recorder.record(
                {
                    eventType: 'audit.retention-policy.update',
                    actor: reader.actor,
                    result: AuditActionResult.SUCCESS,
                    resource: { type: 'audit-retention-policy' },
                    correlationId: reader.correlationId,
                    ...(reader.request ? { request: reader.request } : {}),
                    beforeState: {
                        severity: before.severity,
                        retentionDays: before.retentionDays,
                        notes: before.notes,
                    },
                    afterState: {
                        severity: updated.severity,
                        retentionDays: updated.retentionDays,
                        notes: updated.notes,
                    },
                    metadata: {
                        // Called out explicitly so an alert can key on the
                        // direction rather than parse two snapshots.
                        direction:
                            updated.retentionDays < before.retentionDays
                                ? 'shortened'
                                : updated.retentionDays > before.retentionDays
                                    ? 'lengthened'
                                    : 'unchanged',
                        dayDelta: updated.retentionDays - before.retentionDays,
                    },
                },
                { tx },
            );

            return updated;
        });

        this.deps.logger.warn(
            {
                severity,
                from: before.retentionDays,
                to: after.retentionDays,
                actorId: reader.actor.id ?? null,
            },
            'audit retention policy changed',
        );

        await this.deps.eventBus.publish(AUDIT_EVENTS.RETENTION_POLICY_CHANGED, {
            severity,
            previousRetentionDays: before.retentionDays,
            retentionDays: after.retentionDays,
        });

        return {
            severity: after.severity,
            retentionDays: after.retentionDays,
            notes: after.notes,
            cutoff: retentionCutoff(after.retentionDays, this.now),
        };
    }

    /**
     * What the external pruning job needs: one cutoff per severity, plus the
     * count behind each. Read-only by design — the job decides and acts, this
     * only tells it where the line is, so both sides derive the date from the
     * same code and an off-by-one cannot delete a day early.
     */
    async prunePlan(): Promise<RetentionPolicyView[]> {
        const plan = await this.list({ withCounts: true });

        // A missing severity means the seed never ran against this database,
        // and a pruner that silently skips a severity keeps INFO rows forever
        // while the operator believes they expire.
        const covered = new Set(plan.map((policy) => policy.severity));
        const missing = Object.values(AuditSeverity).filter((s) => !covered.has(s));
        if (missing.length > 0) {
            throw AppError.notFound(
                `No retention policy for ${missing.join(', ')}. Run the audit seed before pruning.`,
                AUDIT_ERROR_CODES.RETENTION_POLICY_MISSING,
            );
        }

        return plan;
    }

    /** Fills in any missing policy row. Never overwrites an existing one. */
    seedDefaults(): Promise<{ created: number }> {
        return this.deps.policies.seedDefaults();
    }

    /** The raw rows, for callers that want the table and not the view. */
    findAll(): Promise<AuditRetentionPolicy[]> {
        return this.deps.policies.findAll();
    }
}

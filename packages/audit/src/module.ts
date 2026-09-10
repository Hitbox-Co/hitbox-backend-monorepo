import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { AUDIT_CAPABILITIES, AUDIT_MODULE } from './constants/audit.constant';
import { AuditController } from './controller/audit.controller';
import type { AuditReaderResolver } from './controller/audit.controller';
import type { IAuditRecorder } from './domain/interfaces/audit-recorder.interface';
import { AuditEventRepository } from './repository/audit-event.repository';
import { AuditEventTypeRepository } from './repository/audit-event-type.repository';
import { AuditRetentionPolicyRepository } from './repository/audit-retention-policy.repository';
import { AuditQueryService } from './service/audit-query.service';
import { AuditRecorderService } from './service/audit-recorder.service';
import { AuditRetentionService } from './service/audit-retention.service';
import type { RetentionPolicyView } from './service/audit-retention.service';

/**
 * The subset of access-control's guard this module uses.
 *
 * Structural, not imported: audit is the one module that must keep working —
 * and keep old records readable — regardless of what happens to the modules it
 * describes, so it depends on the *shape* of a guard rather than on
 * @hitbox/access-control. Bootstrap passes the real one.
 */
export interface AuditPermissionGuard {
    requirePermission(
        capability: string,
        options?: {
            context?: (
                req: Request,
            ) =>
                | { organizationId?: string | null; ownerId?: string | null }
                | Promise<{ organizationId?: string | null; ownerId?: string | null }>;
        },
    ): RequestHandler;
}

export interface AuditModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: AuditPermissionGuard;
    /** Turns a request into an actor plus a read scope. See AuditReaderResolver. */
    resolveReader: AuditReaderResolver;
    /**
     * Enables bulk export. Omit and the export route is not mounted at all.
     *
     * Structured this way because export is the exfiltration path: it must be
     * step-up gated (docs/audit-logging.md §6), and a config flag that
     * defaults to "on, ungated" is how that requirement quietly stops being
     * true. Making the gate the thing that enables the route means an ungated
     * export cannot be reached by forgetting something.
     */
    export?: {
        /** Re-authentication / MFA challenge, mounted ahead of the route. */
        stepUp: RequestHandler;
    };
}

export interface AuditModule {
    /**
     * The port every other module writes the trail through. Hand this to a
     * business module as `IAuditRecorder` — nothing outside this package
     * should hold the concrete service.
     */
    recorder: IAuditRecorder;
    /** Audit administration and the read API, mounted under /admin/audit. */
    createAdminRouter(requireAuth: RequestHandler): Router;
    /** Mirrors the code event catalog into AuditEventType. */
    syncEventTypeCatalog(): Promise<{ created: number; updated: number }>;
    /** Fills in any missing retention policy row. Never overwrites one. */
    seedRetentionPolicies(): Promise<{ created: number }>;
    /**
     * One cutoff per severity plus the row count behind it, for the scheduled
     * pruning job. Reporting only — nothing in this module deletes a row.
     */
    prunePlan(): Promise<RetentionPolicyView[]>;
}

export function createAuditModule(deps: AuditModuleDeps): AuditModule {
    const logger = createModuleLogger(AUDIT_MODULE);

    const eventRepo = new AuditEventRepository(deps.prisma);
    const eventTypeRepo = new AuditEventTypeRepository(deps.prisma);
    const policyRepo = new AuditRetentionPolicyRepository(deps.prisma);

    const recorder = new AuditRecorderService({
        events: eventRepo,
        eventTypes: eventTypeRepo,
        eventBus: deps.eventBus,
        logger,
    });

    const queryService = new AuditQueryService({ events: eventRepo, recorder, logger });
    const retentionService = new AuditRetentionService({
        policies: policyRepo,
        events: eventRepo,
        recorder,
        eventBus: deps.eventBus,
        logger,
        prisma: deps.prisma,
    });

    const controller = new AuditController(
        queryService,
        retentionService,
        eventTypeRepo,
        deps.resolveReader,
    );

    const { requirePermission } = deps.guard;

    /**
     * An ORG-scoped grant only reaches records in its own organization, so the
     * engine needs to know which organization the request is about before it
     * can allow it. Reading it from the query string means an org reader must
     * name their own org id — and naming someone else's is refused twice: here
     * by the engine, and again in AuditQueryService for a global-looking
     * request that turns out to be org-scoped.
     */
    const organizationContext = (req: Request) => ({
        // Express parses a repeated query parameter into an array. Anything
        // that is not a single string is treated as absent rather than
        // coerced, so a malformed request lands on the default-deny path
        // instead of being compared against a stringified array.
        organizationId:
            typeof req.query.organizationId === 'string' ? req.query.organizationId : null,
    });

    return {
        recorder,

        createAdminRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            router.get(
                '/events',
                requirePermission(AUDIT_CAPABILITIES.READ, { context: organizationContext }),
                controller.listEvents,
            );

            // Before /events/:something would shadow it — this path is a
            // sibling of the collection, not an event id.
            router.get(
                '/events/correlation/:correlationId',
                requirePermission(AUDIT_CAPABILITIES.READ, { context: organizationContext }),
                controller.getCorrelation,
            );

            if (deps.export) {
                router.get(
                    '/export',
                    requirePermission(AUDIT_CAPABILITIES.EXPORT, {
                        context: organizationContext,
                    }),
                    deps.export.stepUp,
                    controller.exportEvents,
                );
            } else {
                logger.info(
                    'audit export route not mounted — no step-up gate was supplied',
                );
            }

            router.get(
                '/event-types',
                requirePermission(AUDIT_CAPABILITIES.READ, { context: organizationContext }),
                controller.listEventTypes,
            );

            // Retention is platform policy, not tenant data: reading or
            // changing a window is global by nature, so these take the
            // capability without an organization context and an ORG-scoped
            // reader cannot reach them.
            router.get(
                '/retention',
                requirePermission(AUDIT_CAPABILITIES.READ),
                controller.listRetentionPolicies,
            );
            router.get(
                '/retention/prune-plan',
                requirePermission(AUDIT_CAPABILITIES.READ),
                controller.getPrunePlan,
            );
            // Changing a window is how evidence gets destroyed, so it takes
            // MANAGE rather than READ — and MANAGE rather than EXPORT, since
            // a reviewer who may copy the trail out is not thereby someone
            // who may decide how long it exists.
            router.patch(
                '/retention/:severity',
                requirePermission(AUDIT_CAPABILITIES.MANAGE),
                controller.updateRetentionPolicy,
            );

            return router;
        },

        syncEventTypeCatalog() {
            return eventTypeRepo.syncCatalog();
        },

        seedRetentionPolicies() {
            return retentionService.seedDefaults();
        },

        prunePlan() {
            return retentionService.prunePlan();
        },
    };
}

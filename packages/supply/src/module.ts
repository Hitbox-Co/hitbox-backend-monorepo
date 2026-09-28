import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    SUPPLY_METRICS_CAPABILITY,
    SUPPLY_MODULE,
    SUPPLY_READ_CAPABILITY,
    SUPPLY_TAG_READ_CAPABILITY,
    SUPPLY_WRITE_CAPABILITY,
} from './constants/supply.constant';
import { SupplyController } from './controller/supply.controller';
import type { SupplyPrincipalResolver } from './controller/supply.controller';
import { NOOP_SUPPLY_AUDIT } from './domain/interfaces/supply-audit.interface';
import type { ISupplyAudit } from './domain/interfaces/supply-audit.interface';
import type { ITagCipher } from './domain/interfaces/tag-cipher.interface';
import { SupplyRepository } from './repository/supply.repository';
import { SupplyService } from './service/supply.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface SupplyPermissionGuard {
    requirePermission(
        capability: string,
        options?: {
            context?: (req: Request) => unknown | Promise<unknown>;
            globalOnly?: boolean;
        },
    ): RequestHandler;
}

export interface SupplyModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: SupplyPermissionGuard;
    resolvePrincipal: SupplyPrincipalResolver;
    /**
     * The chain-of-custody trail. Optional so a test harness can build the
     * module without one; a server must pass the real recorder, or a
     * consignment is accepted with nothing to show for it.
     */
    audit?: ISupplyAudit;
    /**
     * The chip-UID cipher. Absent on a deployment with no key configured —
     * reads still work and the manifest route answers 503, which says "this
     * deployment cannot register chips" rather than writing rows under an
     * improvised key that no real tap will ever match.
     */
    tagCipher?: ITagCipher | undefined;
}

export interface SupplyModule {
    /** Mounted at /api/v1/admin/supply. */
    createRouter(requireAuth: RequestHandler): Router;
}

/**
 * The physical supply chain: who manufactures chips and merchandise, what
 * arrived, which chips exist, and how much of it is left.
 *
 * Three capabilities, three audiences — see constants/supply.constant.ts. The
 * split that matters: consignment *headers* are planning data gated on
 * `drop:read`, while the chip inventory is anti-counterfeiting material gated
 * on `nfc-tag-claim:read`. A Drop Manager sees every carton and not one chip.
 *
 * Writes are `globalOnly` throughout. Supply intake is a platform custody
 * function: a brand does not take delivery of the platform's chip stock, and an
 * organization-scoped grant on these routes would let one brand register chips
 * against another's consignment.
 */
export function createSupplyModule(deps: SupplyModuleDeps): SupplyModule {
    const logger = createModuleLogger(SUPPLY_MODULE);
    const supply = new SupplyRepository(deps.prisma);
    const service = new SupplyService({
        supply,
        eventBus: deps.eventBus,
        audit: deps.audit ?? NOOP_SUPPLY_AUDIT,
        logger,
        tagCipher: deps.tagCipher,
    });
    const controller = new SupplyController(service, deps.resolvePrincipal);

    return {
        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            // ── Metrics ─────────────────────────────────────────────────────
            //
            // Registered first, and this is load-bearing: `/metrics` would
            // otherwise never be reached if a future `/:something` route were
            // added above it. Literal paths before parameterised ones is the
            // rule for every router here.
            router.get(
                '/metrics',
                deps.guard.requirePermission(SUPPLY_METRICS_CAPABILITY),
                controller.metrics,
            );

            // ── Vendors ─────────────────────────────────────────────────────
            router.get(
                '/vendors',
                deps.guard.requirePermission(SUPPLY_READ_CAPABILITY),
                controller.listVendors,
            );
            router.post(
                '/vendors',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.createVendor,
            );
            router.get(
                '/vendors/:vendorId',
                deps.guard.requirePermission(SUPPLY_READ_CAPABILITY),
                controller.getVendor,
            );
            router.patch(
                '/vendors/:vendorId',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.updateVendor,
            );

            // ── Consignments ────────────────────────────────────────────────
            router.get(
                '/batches',
                deps.guard.requirePermission(SUPPLY_READ_CAPABILITY),
                controller.listBatches,
            );
            router.post(
                '/batches',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.createBatch,
            );
            router.get(
                '/batches/:batchId',
                deps.guard.requirePermission(SUPPLY_READ_CAPABILITY),
                controller.getBatch,
            );
            router.post(
                '/batches/:batchId/decision',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.decideBatch,
            );
            // Registering a manifest is gated on tag custody, not on the
            // consignment: whoever books the carton in and whoever writes the
            // chip records are different jobs, and this route is the second one.
            router.post(
                '/batches/:batchId/tags',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.registerTags,
            );

            // ── Chip inventory ──────────────────────────────────────────────
            router.get(
                '/tags',
                deps.guard.requirePermission(SUPPLY_TAG_READ_CAPABILITY),
                controller.listTags,
            );
            router.get(
                '/tags/:tagId',
                deps.guard.requirePermission(SUPPLY_TAG_READ_CAPABILITY),
                controller.getTag,
            );
            router.patch(
                '/tags/:tagId/qc',
                deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, { globalOnly: true }),
                controller.recordQc,
            );

            return router;
        },
    };
}

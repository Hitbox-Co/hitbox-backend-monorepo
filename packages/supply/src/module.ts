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
    VENDOR_PORTAL_READ_CAPABILITY,
    VENDOR_PORTAL_WRITE_CAPABILITY,
} from './constants/supply.constant';
import { SupplyController } from './controller/supply.controller';
import { VendorAdminController, VendorPortalController } from './controller/vendor.controller';
import type { VendorUserIdResolver } from './controller/vendor.controller';
import type {
    IVendorInvitations,
    StaffInvitationAcceptedEvent,
} from './domain/interfaces/vendor-invitations.interface';
import { VendorPortalRepository } from './repository/vendor-portal.repository';
import { VendorAdminService } from './service/vendor-admin.service';
import { VendorPortalService } from './service/vendor-portal.service';
import { AllotmentGate } from './service/allotment';
import type { SupplyPrincipalResolver } from './controller/supply.controller';
import { NOOP_SUPPLY_AUDIT } from './domain/interfaces/supply-audit.interface';
import type { ISupplyAudit } from './domain/interfaces/supply-audit.interface';
import type { ITagCipher } from './domain/interfaces/tag-cipher.interface';
import type { ISupplyStockMinter } from './domain/interfaces/stock-minter.interface';
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
    /**
     * Sends vendor invitations through the staff-invitation flow. Absent in a
     * test harness; the invite route then answers 503.
     */
    vendorInvitations?: IVendorInvitations | undefined;
    /**
     * Mints accepted chips into sellable units of the drop (skus' minting
     * core). Without it an ACCEPTED decision changes the status only.
     */
    stockMinter?: ISupplyStockMinter | undefined;
    /** The caller's own account id — what the vendor portal resolves "me" from. */
    resolveUserId?: VendorUserIdResolver | undefined;
}

export interface SupplyModule {
    /** Mounted at /api/v1/admin/supply. */
    createRouter(requireAuth: RequestHandler): Router;
    /** The vendor portal, mounted at /api/v1/vendor. docs/vendor/vendor-portal-api.md. */
    createVendorRouter(requireAuth: RequestHandler): Router;
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
    const portal = new VendorPortalRepository(deps.prisma, supply);
    const allotmentGate = new AllotmentGate(portal);
    const service = new SupplyService({
        allotmentGate,
        stockMinter: deps.stockMinter,
        supply,
        eventBus: deps.eventBus,
        audit: deps.audit ?? NOOP_SUPPLY_AUDIT,
        logger,
        tagCipher: deps.tagCipher,
    });
    const controller = new SupplyController(service, deps.resolvePrincipal);

    const vendorAdmin = new VendorAdminService({
        supply,
        portal,
        invitations: deps.vendorInvitations,
        eventBus: deps.eventBus,
        audit: deps.audit ?? NOOP_SUPPLY_AUDIT,
        logger,
    });
    const vendorPortal = new VendorPortalService({
        supply,
        portal,
        supplyService: service,
        allotmentGate,
    });
    const vendorAdminController = new VendorAdminController(vendorAdmin, deps.resolvePrincipal);

    /**
     * A vendor's invitation was accepted → its VendorMember becomes ACTIVE.
     * Subscribed by event name, structurally, so supply never imports
     * access-control; every other accepted invitation is ignored by the lookup.
     */
    deps.eventBus.subscribe<StaffInvitationAcceptedEvent>(
        'access-control.staff.invitation-accepted',
        async (event) => {
            try {
                await vendorAdmin.onInvitationAccepted(event);
            } catch (error) {
                logger.error(
                    { err: error, invitationId: event?.invitationId },
                    'could not activate the vendor membership for an accepted invitation',
                );
            }
        },
    );

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

            // ── Vendor portal administration ────────────────────────────────
            //
            // Who may sign in for a vendor, and which drops it may supply. All
            // gated on the supply write capability, platform-wide: reading the
            // member list exposes invitees' email addresses, and both writes
            // are access decisions. docs/vendor/vendor-admin-api.md.
            const vendorAdminGate = deps.guard.requirePermission(SUPPLY_WRITE_CAPABILITY, {
                globalOnly: true,
            });
            router.get('/vendors/:vendorId/members', vendorAdminGate, vendorAdminController.listMembers);
            router.post('/vendors/:vendorId/members', vendorAdminGate, vendorAdminController.inviteMember);
            router.post(
                '/vendors/:vendorId/members/:memberId/revoke',
                vendorAdminGate,
                vendorAdminController.revokeMember,
            );
            router.get('/vendors/:vendorId/drops', vendorAdminGate, vendorAdminController.listDrops);
            router.post('/vendors/:vendorId/drops', vendorAdminGate, vendorAdminController.assignDrop);
            router.put(
                '/vendors/:vendorId/drops/:dropId/allotment',
                vendorAdminGate,
                vendorAdminController.updateAllotment,
            );
            router.patch(
                '/vendors/:vendorId/drops/:dropId/allotment',
                vendorAdminGate,
                vendorAdminController.patchAllotment,
            );
            router.delete(
                '/vendors/:vendorId/drops/:dropId',
                vendorAdminGate,
                vendorAdminController.unassignDrop,
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

        createVendorRouter(requireAuth) {
            const resolveUserId = deps.resolveUserId;
            if (!resolveUserId) {
                throw new Error(
                    'createSupplyModule({ resolveUserId }) is required to build the vendor portal router.',
                );
            }
            const portalController = new VendorPortalController(vendorPortal, resolveUserId);

            // `own` scope, checked against the caller's own id: only a holder of
            // vendor-supply:*:own (the VENDOR role) passes. The vendor and its
            // drops are then resolved by the service from the database.
            const mine = (req: Request) => ({ ownerId: resolveUserId(req) ?? null });
            const read = deps.guard.requirePermission(VENDOR_PORTAL_READ_CAPABILITY, { context: mine });
            const write = deps.guard.requirePermission(VENDOR_PORTAL_WRITE_CAPABILITY, { context: mine });

            const router = Router();
            router.use(requireAuth);

            router.get('/me', read, portalController.me);
            router.get('/drops', read, portalController.listDrops);
            router.get('/batches', read, portalController.listBatches);
            router.post('/batches', write, portalController.createBatch);
            router.get('/batches/:batchId', read, portalController.getBatch);
            router.post('/batches/:batchId/tags', write, portalController.registerTags);

            return router;
        },
    };
}

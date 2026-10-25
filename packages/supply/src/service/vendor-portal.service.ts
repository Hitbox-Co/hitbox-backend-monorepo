import { AppError } from '@hitbox/shared';
import { SupplyBatchStatus, VendorMemberStatus } from '@hitbox/database';
import { SUPPLY_ERROR_CODES } from '../constants/supply.constant';
import type {
    RegisterTagsDto,
    RegisterTagsResult,
    SupplyBatchResponse,
    VendorCreateBatchDto,
    VendorDropAssignmentResponse,
    VendorListBatchesQuery,
    VendorProfileResponse,
} from '../dto/supply.dto';
import type { SupplyRepository, VendorRow } from '../repository/supply.repository';
import type {
    VendorMemberRow,
    VendorPortalRepository,
} from '../repository/vendor-portal.repository';
import { toBatchResponse } from './supply.service';
import type { SupplyService } from './supply.service';
import { toMemberResponse } from './vendor-admin.service';
import { AllotmentGate, assertAllotmentShape, presentAssignment } from './allotment';

interface VendorPortalServiceDeps {
    supply: SupplyRepository;
    portal: VendorPortalRepository;
    /** For the shared consignment and manifest writes. */
    supplyService: SupplyService;
    allotmentGate: AllotmentGate;
}

/** The caller's membership and vendor, resolved once per request. */
interface VendorContext {
    member: VendorMemberRow;
    vendor: VendorRow;
}

/**
 * The vendor portal: a supplier's own staff booking consignments and
 * registering chip manifests.
 *
 * ## Where the boundary is drawn
 *
 * The route guard proves the caller holds `vendor-supply:*:own` (the VENDOR
 * role). Everything narrower is resolved here, from the database, on every
 * request:
 *
 *   - **which vendor** — the caller's ACTIVE VendorMember row. No route takes a
 *     vendor id, so there is nothing to tamper with.
 *   - **which drops** — the vendor's VendorDropAssignments. A consignment can be
 *     booked, and a manifest registered, only against an assigned drop.
 *   - **which consignments** — the vendor's own, by `vendorId` in the WHERE
 *     clause. Another vendor's batch is a 404, not a 403.
 *
 * What a vendor never does: decide a consignment (accept/reject is HitBox's
 * custody call), record a QC verdict after the fact, or read the chip
 * inventory. Those stay on the staff routes.
 */
export class VendorPortalService {
    constructor(private readonly deps: VendorPortalServiceDeps) { }

    async me(userId: string): Promise<VendorProfileResponse> {
        const { member, vendor } = await this.resolve(userId);
        return {
            member: toMemberResponse(member),
            vendor: {
                id: vendor.id,
                name: vendor.name,
                legalName: vendor.legalName,
                country: vendor.country,
                vendorType: vendor.vendorType,
                contactName: vendor.contactName,
                contactEmail: vendor.contactEmail,
                contactPhone: vendor.contactPhone,
                isActive: vendor.isActive && !vendor.archivedAt,
            },
        };
    }

    async listDrops(userId: string): Promise<{ data: VendorDropAssignmentResponse[] }> {
        const { vendor } = await this.resolve(userId);
        const rows = await this.deps.portal.listAssignments(vendor.id);
        return {
            data: await Promise.all(rows.map((row) => presentAssignment(this.deps.portal, row))),
        };
    }

    async listBatches(
        userId: string,
        query: VendorListBatchesQuery,
    ): Promise<{
        data: SupplyBatchResponse[];
        meta: { page: number; limit: number; total: number; totalPages: number };
    }> {
        const { vendor } = await this.resolve(userId);
        const { total, items } = await this.deps.portal.listVendorBatches(vendor.id, query);
        return {
            data: items.map((row) => toBatchResponse(row, true)),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.ceil(total / query.limit),
            },
        };
    }

    async getBatch(userId: string, batchId: string): Promise<SupplyBatchResponse> {
        const { vendor } = await this.resolve(userId);
        const row = await this.loadOwnBatch(vendor.id, batchId);
        return { ...toBatchResponse(row, true), allotment: await this.deps.allotmentGate.check(row) };
    }

    async createBatch(
        userId: string,
        correlationId: string,
        dto: VendorCreateBatchDto,
    ): Promise<SupplyBatchResponse> {
        const { vendor } = await this.resolveForWrite(userId);
        const assignment = await this.requireAssigned(vendor.id, dto.dropId);
        if (dto.lines) {
            await this.deps.supplyService.assertLinesBelongToDrop(dto.dropId, dto.lines);
        }
        // Shape only: a vendor may book beyond its allotment and the response
        // says so (`allotment.covered`); HitBox cannot ACCEPT it until the
        // allotment is raised.
        assertAllotmentShape(assignment, dto);

        const organizationId = await this.deps.supply.findDropOrganization(dto.dropId);
        const row = await this.deps.supplyService.bookConsignment({
            actorId: userId,
            actorType: 'VENDOR',
            correlationId,
            organizationId: organizationId ?? null,
            dto: { ...dto, vendorId: vendor.id },
        });
        return { ...toBatchResponse(row, true), allotment: await this.deps.allotmentGate.check(row) };
    }

    async registerTags(
        userId: string,
        correlationId: string,
        batchId: string,
        dto: RegisterTagsDto,
    ): Promise<RegisterTagsResult> {
        const { vendor } = await this.resolveForWrite(userId);
        const batch = await this.loadOwnBatch(vendor.id, batchId);

        // The flow is booked → HitBox VALIDATES → vendor uploads the chip UIDs
        // → HitBox accepts. A dry run is allowed earlier, so the vendor can
        // check a file while waiting for validation.
        if (!dto.dryRun && batch.status !== SupplyBatchStatus.VALIDATED) {
            throw AppError.conflict(
                batch.status === SupplyBatchStatus.UPLOADED
                    ? 'HitBox has not validated this consignment yet. You can dry-run the file now ' +
                      'and upload it once the consignment is VALIDATED.'
                    : `A consignment in ${batch.status} no longer accepts chips.`,
                batch.status === SupplyBatchStatus.UPLOADED
                    ? SUPPLY_ERROR_CODES.BATCH_NOT_VALIDATED
                    : SUPPLY_ERROR_CODES.BATCH_STATE_INVALID,
            );
        }

        // Checked against the assignment as it stands now, not as it stood when
        // the consignment was booked: withdrawing a vendor from a drop stops
        // further manifests against it immediately.
        if (!batch.dropId) {
            throw AppError.forbidden(
                'This consignment is not booked against a drop.',
                SUPPLY_ERROR_CODES.DROP_NOT_ASSIGNED,
            );
        }
        await this.requireAssigned(vendor.id, batch.dropId);

        return this.deps.supplyService.applyManifest({
            actorId: userId,
            actorType: 'VENDOR',
            correlationId,
            batch,
            dto,
        });
    }

    /**
     * The caller's ACTIVE membership. Any other state — never invited, still
     * INVITED, REVOKED — is the same 403, so the portal says nothing about
     * which vendors exist.
     */
    private async resolve(userId: string): Promise<VendorContext> {
        const member = await this.deps.portal.findByUserId(userId);
        if (!member || member.status !== VendorMemberStatus.ACTIVE) {
            throw AppError.forbidden(
                'Your account is not an active member of any vendor.',
                SUPPLY_ERROR_CODES.VENDOR_MEMBERSHIP_REQUIRED,
            );
        }
        const vendor = await this.deps.supply.findVendorById(member.vendorId);
        if (!vendor) {
            throw AppError.forbidden(
                'Your account is not an active member of any vendor.',
                SUPPLY_ERROR_CODES.VENDOR_MEMBERSHIP_REQUIRED,
            );
        }
        return { member, vendor };
    }

    /** Reads stay open on an inactive vendor; new intake does not. */
    private async resolveForWrite(userId: string): Promise<VendorContext> {
        const context = await this.resolve(userId);
        if (context.vendor.archivedAt || !context.vendor.isActive) {
            throw AppError.forbidden(
                'This vendor is inactive and cannot book new supply.',
                SUPPLY_ERROR_CODES.VENDOR_INACTIVE,
            );
        }
        return context;
    }

    private async requireAssigned(vendorId: string, dropId: string) {
        const assignment = await this.deps.portal.findAssignment(vendorId, dropId);
        if (!assignment) {
            throw AppError.forbidden(
                'Your vendor is not assigned to supply this drop.',
                SUPPLY_ERROR_CODES.DROP_NOT_ASSIGNED,
            );
        }
        return assignment;
    }

    private async loadOwnBatch(vendorId: string, batchId: string) {
        const row = await this.deps.portal.findVendorBatch(vendorId, batchId);
        if (!row) {
            throw AppError.notFound('Supply batch not found', SUPPLY_ERROR_CODES.BATCH_NOT_FOUND);
        }
        return row;
    }
}

import { randomUUID } from 'node:crypto';
import { Prisma, SupplyBatchStatus, VendorMemberStatus } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { VariantQuantity, VendorListBatchesQuery } from '../dto/supply.dto';
import type { BatchRow, SupplyRepository } from './supply.repository';

const memberSelect = {
    id: true,
    vendorId: true,
    email: true,
    status: true,
    userId: true,
    invitationId: true,
    invitedById: true,
    invitedAt: true,
    acceptedAt: true,
    revokedAt: true,
    revokeReason: true,
} satisfies Prisma.VendorMemberSelect;

export type VendorMemberRow = Prisma.VendorMemberGetPayload<{ select: typeof memberSelect }>;

const assignmentSelect = {
    id: true,
    vendorId: true,
    dropId: true,
    drop: { select: { id: true, groupCode: true, name: true, status: true } },
    assignedById: true,
    assignedAt: true,
    quantity: true,
    allotments: {
        select: {
            variantId: true,
            quantity: true,
            variant: {
                select: { variantCode: true, label: true, optionsKey: true, position: true },
            },
        },
        orderBy: { variant: { position: 'asc' } },
    },
} satisfies Prisma.VendorDropAssignmentSelect;

export type VendorDropAssignmentRow = Prisma.VendorDropAssignmentGetPayload<{
    select: typeof assignmentSelect;
}>;

/** What a vendor has supplied against one drop so far. */
export interface SupplyTotals {
    booked: number;
    registered: number;
    accepted: number;
}

/**
 * Which consignments a total counts:
 *
 *   booked   — everything but REJECTED: goods HitBox refused were never taken
 *              into stock, so they do not use up the allotment;
 *   accepted — ACCEPTED only: what HitBox has actually taken delivery of, and
 *              what the allotment must cover.
 *
 * `excludeBatchId` leaves one consignment out — the one being decided.
 */
export interface TotalsFilter {
    acceptedOnly?: boolean;
    excludeBatchId?: string;
}

function batchFilter(vendorId: string, dropId: string, filter: TotalsFilter = {}) {
    return {
        vendorId,
        dropId,
        status: filter.acceptedOnly
            ? SupplyBatchStatus.ACCEPTED
            : { not: SupplyBatchStatus.REJECTED },
        ...(filter.excludeBatchId ? { id: { not: filter.excludeBatchId } } : {}),
    };
}

/** Members that still hold (or are about to hold) portal access. */
const LIVE_STATUSES = [VendorMemberStatus.INVITED, VendorMemberStatus.ACTIVE];

/**
 * Vendor memberships and drop assignments — the two tables that turn the
 * staff-only supply module into something a vendor can sign in to.
 */
export class VendorPortalRepository {
    constructor(
        private readonly prisma: PrismaClient,
        private readonly supply: SupplyRepository,
    ) { }

    // ── Members ─────────────────────────────────────────────────────────────

    listMembers(vendorId: string, status?: VendorMemberStatus): Promise<VendorMemberRow[]> {
        return this.prisma.vendorMember.findMany({
            where: { vendorId, ...(status ? { status } : {}) },
            select: memberSelect,
            orderBy: { invitedAt: 'desc' },
        });
    }

    findMember(vendorId: string, memberId: string): Promise<VendorMemberRow | null> {
        return this.prisma.vendorMember.findFirst({
            where: { id: memberId, vendorId },
            select: memberSelect,
        });
    }

    /**
     * An INVITED or ACTIVE membership for this address at ANY vendor — one
     * person acts for one vendor, so a live membership elsewhere blocks too.
     */
    findLiveByEmail(email: string): Promise<VendorMemberRow | null> {
        return this.prisma.vendorMember.findFirst({
            where: { email, status: { in: LIVE_STATUSES } },
            select: memberSelect,
        });
    }

    findByUserId(userId: string): Promise<VendorMemberRow | null> {
        return this.prisma.vendorMember.findUnique({ where: { userId }, select: memberSelect });
    }

    findByInvitationId(invitationId: string): Promise<VendorMemberRow | null> {
        return this.prisma.vendorMember.findUnique({
            where: { invitationId },
            select: memberSelect,
        });
    }

    createMember(data: {
        vendorId: string;
        email: string;
        invitationId: string;
        invitedById: string;
        userId: string | null;
    }): Promise<VendorMemberRow> {
        const now = new Date();
        return this.prisma.vendorMember.create({
            data: {
                id: randomUUID(),
                vendorId: data.vendorId,
                email: data.email,
                invitationId: data.invitationId,
                invitedById: data.invitedById,
                invitedAt: now,
                ...(data.userId
                    ? { userId: data.userId, status: VendorMemberStatus.ACTIVE, acceptedAt: now }
                    : { status: VendorMemberStatus.INVITED }),
            },
            select: memberSelect,
        });
    }

    /** INVITED → ACTIVE with the account that accepted. */
    activate(id: string, userId: string): Promise<VendorMemberRow> {
        return this.prisma.vendorMember.update({
            where: { id },
            data: { userId, status: VendorMemberStatus.ACTIVE, acceptedAt: new Date() },
            select: memberSelect,
        });
    }

    /**
     * Revoking releases `userId` as well, so the same account can later be
     * invited again — to this vendor or another — without tripping the unique
     * constraint. Who it was stays readable from the audit trail.
     */
    revoke(input: { id: string; revokedById: string; reason: string }): Promise<VendorMemberRow> {
        return this.prisma.vendorMember.update({
            where: { id: input.id },
            data: {
                status: VendorMemberStatus.REVOKED,
                revokedAt: new Date(),
                revokedById: input.revokedById,
                revokeReason: input.reason,
                userId: null,
            },
            select: memberSelect,
        });
    }

    // ── Drop assignments ────────────────────────────────────────────────────

    listAssignments(vendorId: string): Promise<VendorDropAssignmentRow[]> {
        return this.prisma.vendorDropAssignment.findMany({
            where: { vendorId },
            select: assignmentSelect,
            orderBy: { assignedAt: 'desc' },
        });
    }

    findAssignment(vendorId: string, dropId: string): Promise<VendorDropAssignmentRow | null> {
        return this.prisma.vendorDropAssignment.findUnique({
            where: { vendorId_dropId: { vendorId, dropId } },
            select: assignmentSelect,
        });
    }

    createAssignment(data: {
        vendorId: string;
        dropId: string;
        assignedById: string;
        quantity: number | null;
        variants: VariantQuantity[];
    }): Promise<VendorDropAssignmentRow> {
        const { variants, ...rest } = data;
        return this.prisma.vendorDropAssignment.create({
            data: {
                id: randomUUID(),
                assignedAt: new Date(),
                ...rest,
                ...(variants.length
                    ? {
                        allotments: {
                            create: variants.map((v) => ({
                                id: randomUUID(),
                                variantId: v.variantId,
                                quantity: v.quantity,
                            })),
                        },
                    }
                    : {}),
            },
            select: assignmentSelect,
        });
    }

    /**
     * Replaces an assignment's allotment in one transaction: variants left out
     * are removed, the rest are upserted. The service has already refused any
     * change that would fall below what is booked.
     */
    replaceAllotment(input: {
        assignmentId: string;
        quantity: number | null;
        variants: VariantQuantity[];
    }): Promise<VendorDropAssignmentRow> {
        return this.prisma.$transaction(async (tx) => {
            await tx.vendorVariantAllotment.deleteMany({
                where: {
                    assignmentId: input.assignmentId,
                    variantId: { notIn: input.variants.map((v) => v.variantId) },
                },
            });
            for (const v of input.variants) {
                await tx.vendorVariantAllotment.upsert({
                    where: {
                        assignmentId_variantId: {
                            assignmentId: input.assignmentId,
                            variantId: v.variantId,
                        },
                    },
                    create: {
                        id: randomUUID(),
                        assignmentId: input.assignmentId,
                        variantId: v.variantId,
                        quantity: v.quantity,
                    },
                    update: { quantity: v.quantity },
                });
            }
            return tx.vendorDropAssignment.update({
                where: { id: input.assignmentId },
                data: { quantity: input.quantity },
                select: assignmentSelect,
            });
        });
    }

    // ── Supply progress ─────────────────────────────────────────────────────

    /** Booked / registered / accepted per variant, from consignment lines. */
    async totalsByVariant(
        vendorId: string,
        dropId: string,
        filter?: TotalsFilter,
    ): Promise<Map<string, SupplyTotals>> {
        const rows = await this.prisma.supplyBatchLine.groupBy({
            by: ['variantId'],
            where: { batch: batchFilter(vendorId, dropId, filter) },
            _sum: { quantity: true, rowsReceived: true, rowsAccepted: true },
        });
        return new Map(
            rows.map((row) => [
                row.variantId,
                {
                    booked: row._sum.quantity ?? 0,
                    registered: row._sum.rowsReceived ?? 0,
                    accepted: row._sum.rowsAccepted ?? 0,
                },
            ]),
        );
    }

    /** The same, for the drop as a whole (any consignment, lines or not). */
    async totalsForDrop(
        vendorId: string,
        dropId: string,
        filter?: TotalsFilter,
    ): Promise<SupplyTotals> {
        const row = await this.prisma.supplyBatch.aggregate({
            where: batchFilter(vendorId, dropId, filter),
            _sum: { quantity: true, rowsReceived: true, rowsAccepted: true },
        });
        return {
            booked: row._sum.quantity ?? 0,
            registered: row._sum.rowsReceived ?? 0,
            accepted: row._sum.rowsAccepted ?? 0,
        };
    }

    async deleteAssignment(id: string): Promise<void> {
        await this.prisma.vendorDropAssignment.delete({ where: { id } });
    }

    // ── A vendor's own consignments ─────────────────────────────────────────

    /**
     * Confined to the vendor in the WHERE clause, so another vendor's batch id
     * is a 404 indistinguishable from a missing one.
     */
    async listVendorBatches(
        vendorId: string,
        query: VendorListBatchesQuery,
    ): Promise<{ total: number; items: BatchRow[] }> {
        return this.supply.listBatches({ ...query, vendorId }, null);
    }

    async findVendorBatch(vendorId: string, batchId: string): Promise<BatchRow | null> {
        const row = await this.supply.findBatchById(batchId, null);
        return row && row.vendorId === vendorId ? row : null;
    }
}

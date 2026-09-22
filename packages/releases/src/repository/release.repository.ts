import { randomUUID } from 'node:crypto';
import { ApprovalAuthority, ApprovalStatus, ComplianceStatus, DropStatus, Prisma } from '@hitbox/database';
import type { OrganizationType, PrismaClient } from '@hitbox/database';
import type { ListReleaseApprovalsQuery } from '../dto/release.dto';

const approvalSelect = {
    id: true,
    productId: true,
    approverId: true,
    status: true,
    comment: true,
    version: true,
    decidedAt: true,
    complianceStatus: true,
    oddsDisclosureRef: true,
    checkedById: true,
    checkedAt: true,
    createdAt: true,
    updatedAt: true,
    authority: true,
    requiredArtistId: true,
    requiredOrganizationId: true,
    legalComplianceAccepted: true,
    legalComplianceAcceptedAt: true,
    legalComplianceVersion: true,
    reopenedFromVersion: true,
    reopenedById: true,
    reopenedAt: true,
    reopenReason: true,
    approver: { select: { email: true, fullName: true } },
    requiredArtist: { select: { name: true } },
    requiredOrganization: { select: { name: true } },
    product: {
        select: {
            id: true, groupCode: true, name: true, status: true,
            complianceStatus: true, isAgeSpecific: true, minimumAge: true,
            oddsDisclosureRef: true, totalSupply: true,
            organizationId: true, artistId: true,
            // Read through the relations rather than through a port: the
            // authority rule needs the owner's *type* and the artist's linked
            // account, and both are one join away on a row this module already
            // loads. Same precedent as products reading MediaAsset.storageRef.
            organization: { select: { type: true } },
            artist: { select: { userId: true } },
        },
    },
} satisfies Prisma.ReleaseApprovalSelect;

export type ReleaseApprovalRow = Prisma.ReleaseApprovalGetPayload<{
    select: typeof approvalSelect;
}>;

/** The only place in this module that touches Prisma. */
export class ReleaseRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async list(
        query: ListReleaseApprovalsQuery & {
            organizationIds: string[] | null;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: ReleaseApprovalRow[] }> {
        const where: Prisma.ReleaseApprovalWhereInput = {
            ...(query.organizationIds === null
                ? {}
                : { product: { organizationId: { in: query.organizationIds } } }),
            ...(query.status ? { status: query.status } : {}),
            ...(query.complianceStatus ? { complianceStatus: query.complianceStatus } : {}),
            ...(query.productId ? { productId: query.productId } : {}),
            ...(query.approverId ? { approverId: query.approverId } : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.releaseApproval.count({ where }),
            this.prisma.releaseApproval.findMany({
                where,
                select: approvalSelect,
                // Pending first, then newest — the queue an approver works
                // through, not a chronological archive.
                orderBy: [{ decidedAt: 'asc' }, { createdAt: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    findById(id: string): Promise<ReleaseApprovalRow | null> {
        return this.prisma.releaseApproval.findUnique({ where: { id }, select: approvalSelect });
    }

    /** Every decision on one product, newest version first. */
    findHistoryForProduct(productId: string): Promise<ReleaseApprovalRow[]> {
        return this.prisma.releaseApproval.findMany({
            where: { productId },
            select: approvalSelect,
            orderBy: { version: 'desc' },
        });
    }

    /** The drop's owner, for the authority rule. */
    async findOwnership(productId: string): Promise<{
        organizationId: string | null;
        organizationType: OrganizationType | null;
        artistId: string | null;
        artistUserId: string | null;
    } | null> {
        const product = await this.prisma.product.findUnique({
            where: { id: productId },
            select: {
                organizationId: true,
                artistId: true,
                organization: { select: { type: true } },
                artist: { select: { userId: true } },
            },
        });
        if (!product) return null;
        return {
            organizationId: product.organizationId,
            organizationType: product.organization?.type ?? null,
            artistId: product.artistId,
            artistUserId: product.artist?.userId ?? null,
        };
    }

    async findLatestVersion(productId: string): Promise<number> {
        const latest = await this.prisma.releaseApproval.findFirst({
            where: { productId },
            select: { version: true },
            orderBy: { version: 'desc' },
        });
        return latest?.version ?? 0;
    }

    findOpenForProduct(productId: string): Promise<ReleaseApprovalRow | null> {
        return this.prisma.releaseApproval.findFirst({
            where: { productId, decidedAt: null },
            select: approvalSelect,
        });
    }

    /**
     * Opens a review at version N+1 and moves the drop to SUBMITTED in the
     * same transaction — a product sitting in DRAFT with an open approval row
     * against it is a state no screen can explain.
     */
    async submit(input: {
        productId: string;
        approverId: string;
        version: number;
        comment: string | undefined;
        complianceStatus: ComplianceStatus;
        oddsDisclosureRef: string | null;
        authority: ApprovalAuthority;
        requiredArtistId: string | null;
        requiredOrganizationId: string | null;
        reopenedFromVersion?: number | null;
        reopenedById?: string | null;
        reopenReason?: string | null;
    }): Promise<ReleaseApprovalRow> {
        const id = randomUUID();
        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            await tx.releaseApproval.create({
                data: {
                    id,
                    productId: input.productId,
                    approverId: input.approverId,
                    status: ApprovalStatus.PENDING,
                    ...(input.comment !== undefined ? { comment: input.comment } : {}),
                    version: input.version,
                    complianceStatus: input.complianceStatus,
                    ...(input.oddsDisclosureRef !== null
                        ? { oddsDisclosureRef: input.oddsDisclosureRef }
                        : {}),
                    authority: input.authority,
                    requiredArtistId: input.requiredArtistId,
                    requiredOrganizationId: input.requiredOrganizationId,
                    // Never pre-ticked. The acceptance is recorded at the
                    // moment of approval, by the person approving.
                    legalComplianceAccepted: false,
                    ...(input.reopenedFromVersion != null
                        ? {
                            reopenedFromVersion: input.reopenedFromVersion,
                            reopenedById: input.reopenedById ?? null,
                            reopenedAt: now,
                            reopenReason: input.reopenReason ?? null,
                        }
                        : {}),
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await tx.product.update({
                where: { id: input.productId },
                data: { status: DropStatus.SUBMITTED, updatedAt: now },
            });
        });

        return (await this.findById(id))!;
    }

    /** Amend an undecided approval. Guarded on `decidedAt: null`. */
    async update(
        id: string,
        input: {
            comment?: string | null | undefined;
            complianceStatus?: ComplianceStatus | undefined;
            oddsDisclosureRef?: string | null | undefined;
        },
    ): Promise<number> {
        const result = await this.prisma.releaseApproval.updateMany({
            where: { id, decidedAt: null },
            data: {
                ...(input.comment !== undefined ? { comment: input.comment } : {}),
                ...(input.complianceStatus !== undefined
                    ? { complianceStatus: input.complianceStatus }
                    : {}),
                ...(input.oddsDisclosureRef !== undefined
                    ? { oddsDisclosureRef: input.oddsDisclosureRef }
                    : {}),
                updatedAt: new Date(),
            },
        });
        return result.count;
    }

    /**
     * Record the decision and mirror it onto the product.
     *
     * One transaction, three writes, because the three are one fact: the
     * approval row is the evidence, `Product.complianceStatus` is what the
     * catalog reads, and `Product.status` is what the storefront reads. A
     * partial apply leaves a drop that reviewers believe is approved and
     * buyers cannot see.
     *
     * `allowDecided` is the override path — reversing a recorded decision.
     */
    async decide(input: {
        id: string;
        productId: string;
        status: ApprovalStatus;
        comment: string | undefined;
        complianceStatus: ComplianceStatus;
        oddsDisclosureRef: string | undefined;
        checkedById: string;
        allowDecided: boolean;
        legalComplianceAccepted: boolean;
        legalComplianceVersion: string | null;
    }): Promise<number> {
        const now = new Date();

        return this.prisma.$transaction(async (tx) => {
            const result = await tx.releaseApproval.updateMany({
                where: {
                    id: input.id,
                    ...(input.allowDecided ? {} : { decidedAt: null }),
                },
                data: {
                    status: input.status,
                    ...(input.comment !== undefined ? { comment: input.comment } : {}),
                    complianceStatus: input.complianceStatus,
                    ...(input.oddsDisclosureRef !== undefined
                        ? { oddsDisclosureRef: input.oddsDisclosureRef }
                        : {}),
                    checkedById: input.checkedById,
                    checkedAt: now,
                    decidedAt: now,
                    legalComplianceAccepted: input.legalComplianceAccepted,
                    legalComplianceAcceptedAt: input.legalComplianceAccepted ? now : null,
                    legalComplianceVersion: input.legalComplianceVersion,
                    updatedAt: now,
                },
            });
            if (result.count === 0) return 0;

            await tx.product.update({
                where: { id: input.productId },
                data: {
                    complianceStatus: input.complianceStatus,
                    // APPROVED clears the drop for release; the publish step
                    // is separate and moves it to PUBLISHED/ACTIVE.
                    status:
                        input.status === ApprovalStatus.APPROVED
                            ? DropStatus.APPROVED
                            : DropStatus.REJECTED,
                    ...(input.oddsDisclosureRef !== undefined
                        ? { oddsDisclosureRef: input.oddsDisclosureRef }
                        : {}),
                    updatedAt: now,
                },
            });
            return result.count;
        });
    }
}

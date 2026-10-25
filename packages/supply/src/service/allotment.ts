import { AppError } from '@hitbox/shared';
import { SUPPLY_ERROR_CODES } from '../constants/supply.constant';
import type {
    AllotmentCheck,
    AllotmentProgress,
    PatchVendorAllotmentDto,
    UpdateVendorAllotmentDto,
    VariantQuantity,
    VendorDropAssignmentResponse,
} from '../dto/supply.dto';
import type { BatchRow, SupplyRepository } from '../repository/supply.repository';
import type {
    SupplyTotals,
    VendorDropAssignmentRow,
    VendorPortalRepository,
} from '../repository/vendor-portal.repository';

/**
 * Vendor allotments — what a vendor is to supply for a drop — shared by the
 * admin side (which sets them), the portal (which books against them) and the
 * intake decision (which enforces them).
 *
 * The shape follows the drop:
 *
 *   drop WITH live variants → allotted per variant ("Red/S 100, Red/M 100,
 *                             Red/L 100"); the drop total is their sum
 *   drop WITHOUT variants   → one optional drop-level quantity (null = no cap)
 *
 * ## Where the allotment bites
 *
 * Not at booking. A vendor may book MORE than its allotment — a factory that
 * over-produced still has to declare what it shipped, and refusing the booking
 * would only push the overage off the books. It bites at **acceptance**: HitBox
 * cannot accept a consignment while the vendor's accepted units for a variant,
 * this consignment included, would exceed that variant's allotment. To accept
 * an over-allotment carton the admin raises the allotment first (PATCH
 * …/allotment) — a deliberate, audited decision to take the extra stock.
 */

export interface ResolvedAllotment {
    quantity: number | null;
    variants: VariantQuantity[];
}

/** Checks an allotment body against the drop's live variants. */
export async function resolveAllotment(
    supply: SupplyRepository,
    dropId: string,
    dto: UpdateVendorAllotmentDto,
): Promise<ResolvedAllotment> {
    const live = (await supply.findDropVariants(dropId)).filter(
        (variant) => variant.isActive && !variant.archivedAt,
    );

    if (live.length === 0) {
        if (dto.variants) {
            throw AppError.badRequest(
                'This drop has no variants — allot a quantity instead.',
                SUPPLY_ERROR_CODES.ALLOTMENT_SHAPE_INVALID,
            );
        }
        return { quantity: dto.quantity ?? null, variants: [] };
    }

    if (!dto.variants) {
        throw AppError.badRequest(
            'This drop has variants — allot a quantity per variant.',
            SUPPLY_ERROR_CODES.ALLOTMENT_SHAPE_INVALID,
            { variants: live.map((v) => ({ variantId: v.id, variantCode: v.variantCode, label: v.label })) },
        );
    }
    const liveIds = new Set(live.map((variant) => variant.id));
    const invalid = dto.variants.filter((v) => !liveIds.has(v.variantId)).map((v) => v.variantId);
    if (invalid.length > 0) {
        throw AppError.badRequest(
            'An allotment names a variant that is not a live variant of this drop.',
            SUPPLY_ERROR_CODES.VARIANT_INVALID,
            { invalid },
        );
    }
    return { quantity: null, variants: dto.variants };
}

/**
 * PATCH semantics: the variants sent are set (added if new), every other
 * variant keeps its allotment. For a drop without variants, `quantity` is set.
 */
export function mergeAllotment(
    existing: VendorDropAssignmentRow,
    dto: PatchVendorAllotmentDto,
): UpdateVendorAllotmentDto {
    if (dto.variants) {
        const merged = new Map(existing.allotments.map((a) => [a.variantId, a.quantity]));
        for (const v of dto.variants) merged.set(v.variantId, v.quantity);
        return {
            variants: [...merged].map(([variantId, quantity]) => ({ variantId, quantity })),
        };
    }
    return { quantity: dto.quantity === undefined ? existing.quantity : dto.quantity };
}

function progress(
    allotted: number | null,
    booked: SupplyTotals,
    approved: number,
): AllotmentProgress {
    return {
        allotted,
        ...booked,
        approved,
        remaining: allotted === null ? null : Math.max(0, allotted - booked.booked),
        overBooked: allotted === null ? 0 : Math.max(0, booked.booked - allotted),
    };
}

const ZERO: SupplyTotals = { booked: 0, registered: 0, accepted: 0 };

/** The assignment with its allotment and live progress, per variant and in total. */
export async function presentAssignment(
    portal: VendorPortalRepository,
    row: VendorDropAssignmentRow,
): Promise<VendorDropAssignmentResponse> {
    const byVariant = row.allotments.length > 0;
    const [dropTotals, dropApproved] = await Promise.all([
        portal.totalsForDrop(row.vendorId, row.dropId),
        portal.totalsForDrop(row.vendorId, row.dropId, { acceptedOnly: true }),
    ]);
    const [variantTotals, variantApproved] = byVariant
        ? await Promise.all([
            portal.totalsByVariant(row.vendorId, row.dropId),
            portal.totalsByVariant(row.vendorId, row.dropId, { acceptedOnly: true }),
        ])
        : [new Map<string, SupplyTotals>(), new Map<string, SupplyTotals>()];

    // A variant the vendor booked without an allotment (allowed — see above)
    // is listed too, at allotted 0, so the overage is visible on the screen
    // that is used to fix it.
    const variantIds = [
        ...row.allotments.map((a) => a.variantId),
        ...[...variantTotals.keys()].filter(
            (id) => !row.allotments.some((a) => a.variantId === id),
        ),
    ];
    const meta = new Map(row.allotments.map((a) => [a.variantId, a]));
    const variants = variantIds.map((variantId) => {
        const allotment = meta.get(variantId);
        return {
            variantId,
            variantCode: allotment?.variant.variantCode ?? null,
            label: allotment?.variant.label ?? null,
            options: allotment?.variant.optionsKey ?? null,
            ...progress(
                allotment?.quantity ?? 0,
                variantTotals.get(variantId) ?? ZERO,
                variantApproved.get(variantId)?.booked ?? 0,
            ),
        };
    });
    const allotted = byVariant
        ? row.allotments.reduce((sum, allotment) => sum + allotment.quantity, 0)
        : row.quantity;

    return {
        id: row.id,
        vendorId: row.vendorId,
        dropId: row.dropId,
        drop: {
            id: row.drop.id,
            groupCode: row.drop.groupCode,
            name: row.drop.name,
            status: row.drop.status,
        },
        assignedById: row.assignedById,
        assignedAt: row.assignedAt.toISOString(),
        byVariant,
        progress: progress(allotted, dropTotals, dropApproved.booked),
        variants,
    };
}

/**
 * A vendor booking must match the SHAPE of its allotment — per-variant lines
 * for a drop allotted by variant, a plain quantity otherwise. Quantities are
 * not capped here; see the module comment.
 */
export function assertAllotmentShape(
    assignment: VendorDropAssignmentRow,
    booking: { lines?: VariantQuantity[] | undefined },
): void {
    if (assignment.allotments.length === 0 && booking.lines) {
        throw AppError.badRequest(
            'Your allotment for this drop is not split by variant — send quantity, not lines.',
            SUPPLY_ERROR_CODES.ALLOTMENT_SHAPE_INVALID,
        );
    }
    if (assignment.allotments.length > 0 && !booking.lines) {
        throw AppError.badRequest(
            'This drop has variants — say how many of each you are supplying: ' +
            'lines: [{ variantId, quantity }].',
            SUPPLY_ERROR_CODES.ALLOTMENT_SHAPE_INVALID,
        );
    }
}

/**
 * Would accepting this consignment stay within the vendor's allotment?
 *
 * Compares, per variant, the units in the vendor's OTHER accepted consignments
 * for the drop plus this one against the allotment. A consignment for a drop
 * the vendor is not assigned to — staff can book those — has no allotment to
 * check and returns null.
 */
export class AllotmentGate {
    constructor(private readonly portal: VendorPortalRepository) { }

    async check(batch: BatchRow): Promise<AllotmentCheck | null> {
        if (!batch.dropId) return null;
        const assignment = await this.portal.findAssignment(batch.vendorId, batch.dropId);
        if (!assignment) return null;

        const exclude = { acceptedOnly: true, excludeBatchId: batch.id };

        // Per variant: the allotment is by variant AND the batch says what it holds.
        if (assignment.allotments.length > 0 && batch.lines.length > 0) {
            const accepted = await this.portal.totalsByVariant(
                batch.vendorId,
                batch.dropId,
                exclude,
            );
            const allotted = new Map(assignment.allotments.map((a) => [a.variantId, a.quantity]));
            const variants = batch.lines.map((line) => {
                const allot = allotted.get(line.variantId) ?? 0;
                const acceptedElsewhere = accepted.get(line.variantId)?.booked ?? 0;
                const required = acceptedElsewhere + line.quantity;
                return {
                    variantId: line.variantId,
                    variantCode: line.variant.variantCode,
                    label: line.variant.label,
                    allotted: allot,
                    acceptedElsewhere,
                    thisBatch: line.quantity,
                    required,
                    shortBy: Math.max(0, required - allot),
                };
            });
            const short = variants.filter((v) => v.shortBy > 0);
            return {
                covered: short.length === 0,
                byVariant: true,
                variants,
                total: null,
                suggestedPatch: short.length
                    ? { variants: short.map((v) => ({ variantId: v.variantId, quantity: v.required })) }
                    : null,
            };
        }

        // Drop level: no variants, or a staff-booked carton without lines.
        const allot = assignment.allotments.length > 0
            ? assignment.allotments.reduce((sum, a) => sum + a.quantity, 0)
            : assignment.quantity;
        const acceptedElsewhere = (
            await this.portal.totalsForDrop(batch.vendorId, batch.dropId, exclude)
        ).booked;
        const required = acceptedElsewhere + batch.quantity;
        const shortBy = allot === null ? 0 : Math.max(0, required - allot);
        return {
            covered: shortBy === 0,
            byVariant: false,
            variants: [],
            total: { allotted: allot, acceptedElsewhere, thisBatch: batch.quantity, required, shortBy },
            // A by-variant allotment with an unsplit carton cannot be fixed by
            // one number; the admin has to raise specific variants.
            suggestedPatch:
                shortBy > 0 && assignment.allotments.length === 0 ? { quantity: required } : null,
        };
    }
}

/**
 * An allotment change may not fall below what HitBox has already ACCEPTED
 * from this vendor: those units are in stock and the allotment is the record
 * that they were wanted. Booked-but-undecided units may exceed it freely.
 */
export async function assertNotBelowAccepted(
    portal: VendorPortalRepository,
    assignment: VendorDropAssignmentRow,
    next: ResolvedAllotment,
): Promise<void> {
    const filter = { acceptedOnly: true };
    if (next.variants.length === 0) {
        if (next.quantity === null) return;
        const { booked: accepted } = await portal.totalsForDrop(
            assignment.vendorId,
            assignment.dropId,
            filter,
        );
        if (next.quantity < accepted) {
            throw AppError.conflict(
                `${accepted} units are already accepted; the allotment cannot go below that.`,
                SUPPLY_ERROR_CODES.ALLOTMENT_BELOW_ACCEPTED,
                { accepted },
            );
        }
        return;
    }

    const totals = await portal.totalsByVariant(assignment.vendorId, assignment.dropId, filter);
    const wanted = new Map(next.variants.map((v) => [v.variantId, v.quantity]));
    const below = [...totals]
        .filter(([, t]) => t.booked > 0)
        .flatMap(([variantId, t]) => {
            const quantity = wanted.get(variantId) ?? 0;
            return quantity < t.booked ? [{ variantId, accepted: t.booked, requested: quantity }] : [];
        });
    if (below.length > 0) {
        throw AppError.conflict(
            'A variant would be allotted less than HitBox has already accepted.',
            SUPPLY_ERROR_CODES.ALLOTMENT_BELOW_ACCEPTED,
            { variants: below },
        );
    }
}

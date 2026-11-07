import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import {
    CONTENT_AUDIT_EVENTS,
    DROP_CONTENT_ERROR_CODES,
    MAX_SERIALS_PER_TIER,
} from '../constants/content.constant';
import type { IContentAuditRecorder } from '../domain/content-audit.port';
import { serialsOf, tierOf } from '../repository/drop-content.repository';
import type {
    AdminUnitRow,
    DropContentRepository,
    DropContentRow,
    LockedUnit,
} from '../repository/drop-content.repository';

interface AdminDropContentServiceDeps {
    drops: DropContentRepository;
    audit: IContentAuditRecorder;
    logger: Logger;
}

export interface AdminActor {
    userId: string;
    roleName: string | null;
}

export interface AdminDropUnitView {
    skuId: string;
    publicCode: string | null;
    skuCode: string;
    serialNumber: number;
    variantId: string | null;
    variant: { variantCode: string; label: string } | null;
    claimedStatus: string;
    owned: boolean;
    /**
     * False once the unit is claimed or has an owner: its exclusivity is
     * then settled and can't be changed from here.
     */
    selectable: boolean;
    /** The exclusive tiers this unit opens, by its serial number. */
    exclusiveTiers: { bundleId: string; name: string }[];
}

export interface ExclusiveUnitsResult {
    bundleId: string;
    name: string;
    /** The tier's full serial list after the change. */
    serialNumbers: number[];
    /** How many serials were actually added or removed (already-listed ones are skipped). */
    changed: number;
}

/**
 * HitBox staff choosing **which specific SKUs** open a drop's exclusive
 * content — "out of 100 units, #042 is the one with the exclusive video".
 *
 * ## The one rule: only while the unit is unclaimed
 *
 * A unit's exclusivity is part of what its buyer gets. Once a unit is claimed
 * (or has an owner at all — sold, awaiting its tap), adding it would hand an
 * owner content nobody sold them, and removing it would take away something
 * they may have bought it for. So a unit can be put on, or taken off, an
 * exclusive tier only while it is UNCLAIMED with no owner — checked on the
 * locked row inside the write, so a claim racing the change cannot slip
 * between the check and the write.
 *
 * Tiers are still created and filled by the artist (artist drop-content API);
 * this surface edits an existing EXCLUSIVE tier's unit list, unit by unit.
 * The tier stores serial numbers, so selecting a SKU adds its serial.
 */
export class AdminDropContentService {
    constructor(private readonly deps: AdminDropContentServiceDeps) { }

    /** The drop's content tiers — so the console can offer the exclusive ones. */
    async tiers(dropId: string): Promise<{
        drop: { id: string; name: string; totalSupply: number };
        tiers: {
            bundleId: string;
            name: string;
            tier: 'REGULAR' | 'EXCLUSIVE';
            isActive: boolean;
            removed: boolean;
            serialNumbers: number[];
        }[];
    }> {
        const drop = await this.requireDrop(dropId);
        const rows = await this.deps.drops.listForDrop(dropId);
        return {
            drop: { id: drop.id, name: drop.name, totalSupply: drop.totalSupply },
            tiers: rows.map((row) => ({
                bundleId: row.id,
                name: row.name,
                tier: tierOf(row),
                isActive: row.isActive,
                removed: row.archivedAt !== null,
                serialNumbers: serialsOf(row),
            })),
        };
    }

    /** The drop's minted units: claim state, and which exclusive tiers each opens. */
    async units(
        dropId: string,
        query: {
            claimed?: boolean | undefined;
            variantId?: string | undefined;
            serialFrom?: number | undefined;
            serialTo?: number | undefined;
            page: number;
            limit: number;
        },
    ): Promise<{
        data: AdminDropUnitView[];
        meta: { page: number; limit: number; total: number; totalPages: number };
    }> {
        await this.requireDrop(dropId);
        const [{ total, items }, rows] = await Promise.all([
            this.deps.drops.listDropUnits(dropId, query),
            this.deps.drops.listForDrop(dropId),
        ]);
        const exclusive = rows.filter((row) => tierOf(row) === 'EXCLUSIVE' && row.archivedAt === null);
        return {
            data: items.map((unit) => toUnitView(unit, exclusive)),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages: Math.ceil(total / query.limit),
            },
        };
    }

    /** Puts specific unclaimed SKUs on an exclusive tier. Idempotent per unit. */
    addUnits(actor: AdminActor, dropId: string, bundleId: string, skuIds: string[]): Promise<ExclusiveUnitsResult> {
        return this.change(actor, dropId, bundleId, skuIds, 'add');
    }

    /** Takes specific unclaimed SKUs off an exclusive tier. Idempotent per unit. */
    removeUnits(actor: AdminActor, dropId: string, bundleId: string, skuIds: string[]): Promise<ExclusiveUnitsResult> {
        return this.change(actor, dropId, bundleId, skuIds, 'remove');
    }

    private async change(
        actor: AdminActor,
        dropId: string,
        bundleId: string,
        skuIds: string[],
        mode: 'add' | 'remove',
    ): Promise<ExclusiveUnitsResult> {
        await this.requireDrop(dropId);
        const before = await this.requireExclusiveTier(dropId, bundleId);
        const ids = [...new Set(skuIds)];

        const { changed, serials } = await this.deps.drops.changeExclusiveUnits({
            bundleId,
            dropId,
            skuIds: ids,
            mode,
            check: (units) => {
                assertUnitsSelectable(units, ids, dropId);
                if (mode === 'add') {
                    const next = new Set([...serialsOf(before), ...units.map((u) => u.serialNumber)]);
                    if (next.size > MAX_SERIALS_PER_TIER) {
                        throw AppError.badRequest(
                            `An exclusive tier can list at most ${MAX_SERIALS_PER_TIER} units.`,
                            DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
                        );
                    }
                } else {
                    // An exclusive tier always names at least one unit — the
                    // artist's own rule for the tier. Removing the last one is
                    // a removal of the tier, which is the artist's (or the
                    // moderation) call, not a unit edit.
                    const remaining = serialsOf(before).filter(
                        (n) => !units.some((u) => u.serialNumber === n),
                    );
                    if (remaining.length === 0) {
                        throw AppError.badRequest(
                            'That would leave the exclusive tier with no units. Keep at least one, ' +
                            'or switch the tier off instead.',
                            DROP_CONTENT_ERROR_CODES.SERIALS_INVALID,
                        );
                    }
                }
            },
        });

        const after = await this.requireExclusiveTier(dropId, bundleId);
        await this.deps.audit.record({
            eventType: mode === 'add'
                ? CONTENT_AUDIT_EVENTS.EXCLUSIVE_UNITS_ADD
                : CONTENT_AUDIT_EVENTS.EXCLUSIVE_UNITS_REMOVE,
            actor: { type: 'HITBOX_ADMIN', id: actor.userId, roleSnapshot: actor.roleName },
            result: 'SUCCESS',
            resource: { type: 'ContentBundle', id: bundleId },
            beforeState: { serialNumbers: serialsOf(before) },
            afterState: { serialNumbers: serialsOf(after) },
            correlationId: randomUUID(),
            metadata: { dropId, skuIds: ids, serialNumbers: serials, changed },
        });
        this.deps.logger.info(
            { dropId, bundleId, mode, skuIds: ids, changed, actorId: actor.userId },
            'exclusive tier units changed by HitBox',
        );

        return { bundleId, name: after.name, serialNumbers: serialsOf(after), changed };
    }

    private async requireDrop(dropId: string) {
        const drop = await this.deps.drops.findDrop(dropId);
        if (!drop) {
            throw AppError.notFound('Drop not found.', DROP_CONTENT_ERROR_CODES.DROP_NOT_FOUND);
        }
        return drop;
    }

    private async requireExclusiveTier(dropId: string, bundleId: string): Promise<DropContentRow> {
        const row = await this.deps.drops.findForDrop(dropId, bundleId);
        if (!row) {
            throw AppError.notFound('No such content on this drop.', DROP_CONTENT_ERROR_CODES.NOT_FOUND);
        }
        if (tierOf(row) !== 'EXCLUSIVE') {
            throw AppError.badRequest(
                'This is the regular tier — every owner of the drop opens it. Pick an exclusive tier.',
                DROP_CONTENT_ERROR_CODES.NOT_EXCLUSIVE,
            );
        }
        if (row.archivedAt) {
            throw AppError.conflict(
                'This tier is removed. Restore it first.',
                DROP_CONTENT_ERROR_CODES.ARCHIVED,
            );
        }
        return row;
    }
}

/**
 * Every requested SKU must exist, belong to this drop, and be unclaimed with
 * no owner. All problems are reported at once, by SKU.
 */
export function assertUnitsSelectable(units: LockedUnit[], requested: string[], dropId: string): void {
    const found = new Map(units.map((unit) => [unit.id, unit]));
    const notInDrop = requested.filter((id) => found.get(id)?.productId !== dropId);
    if (notInDrop.length > 0) {
        throw AppError.badRequest(
            'Some SKUs are not units of this drop.',
            DROP_CONTENT_ERROR_CODES.UNIT_NOT_IN_DROP,
            { skuIds: notInDrop },
        );
    }
    const claimed = units.filter((unit) => !isSelectable(unit.claimedStatus, unit.owned));
    if (claimed.length > 0) {
        throw AppError.conflict(
            'Some SKUs are already claimed or owned, so their exclusive content can no longer change.',
            DROP_CONTENT_ERROR_CODES.UNIT_CLAIMED,
            {
                units: claimed.map((unit) => ({
                    skuId: unit.id,
                    serialNumber: unit.serialNumber,
                    claimedStatus: unit.claimedStatus,
                    owned: unit.owned,
                })),
            },
        );
    }
}

/**
 * The artist panel's form of the same rule: a serial list may not add or
 * remove a unit that is already claimed or owned. Reported by serial number,
 * which is how the artist names units.
 */
export function assertNoSettledUnits(units: LockedUnit[]): void {
    const settled = units.filter((unit) => !isSelectable(unit.claimedStatus, unit.owned));
    if (settled.length === 0) return;
    const serials = settled.map((unit) => unit.serialNumber).sort((a, b) => a - b);
    throw AppError.conflict(
        `Unit${serials.length > 1 ? 's' : ''} ${serials.map((n) => `#${n}`).join(', ')} ` +
        `${serials.length > 1 ? 'are' : 'is'} already claimed or owned, so ` +
        `${serials.length > 1 ? 'they' : 'it'} can't be added to or taken off exclusive content any more.`,
        DROP_CONTENT_ERROR_CODES.UNIT_CLAIMED,
        {
            units: settled.map((unit) => ({
                skuId: unit.id,
                serialNumber: unit.serialNumber,
                claimedStatus: unit.claimedStatus,
                owned: unit.owned,
            })),
        },
    );
}

function isSelectable(claimedStatus: string, owned: boolean): boolean {
    return claimedStatus === 'UNCLAIMED' && !owned;
}

function toUnitView(unit: AdminUnitRow, exclusive: DropContentRow[]): AdminDropUnitView {
    return {
        skuId: unit.id,
        publicCode: unit.publicCode,
        skuCode: unit.skuCode,
        serialNumber: unit.serialNumber,
        variantId: unit.variantId,
        variant: unit.variant ? { variantCode: unit.variant.variantCode, label: unit.variant.label } : null,
        claimedStatus: unit.claimedStatus,
        owned: unit.ownerId !== null,
        selectable: isSelectable(unit.claimedStatus, unit.ownerId !== null),
        exclusiveTiers: exclusive
            .filter((row) => serialsOf(row).includes(unit.serialNumber))
            .map((row) => ({ bundleId: row.id, name: row.name })),
    };
}

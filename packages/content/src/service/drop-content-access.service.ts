import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import { DROP_CONTENT_ERROR_CODES, DROP_CONTENT_EVENTS } from '../constants/content.constant';
import type { IRewardMedia } from '../domain/reward-media.port';
import type { BuyerDropContent, BuyerDropContentTier, BuyerUnitRef } from '../dto/drop-content.views';
import { serialsOf, tierOf } from '../repository/drop-content.repository';
import type { DropContentRepository, DropContentRow, DropRef, OwnedUnit } from '../repository/drop-content.repository';
import { itemCounts, itemViews } from './reward-mapping';

interface DropContentAccessServiceDeps {
    drops: DropContentRepository;
    media?: IRewardMedia | undefined;
    eventBus?: IEventBus | undefined;
    logger: Logger;
    now?: () => Date;
}

/**
 * The buyer's side of drop content. docs/content/drop-content.md.
 *
 * **Who opens what** — decided live, every time, from who owns the unit now
 * (`Sku.ownerId`, claimed):
 *   - REGULAR content: the owner of any unit of the drop;
 *   - EXCLUSIVE content: the owner of a unit whose serial number the tier
 *     lists. Everyone else sees a teaser (name, what kind of files, which
 *     serial numbers open it) and no links.
 *
 * Nothing is granted and nothing has to be revoked: sell the item and the new
 * owner opens it; a claim taken back (refund, lost dispute) and access ends.
 * Opening is recorded in ContentUnlock (with the unit's skuId) as telemetry
 * only.
 */
export class DropContentAccessService {
    constructor(private readonly deps: DropContentAccessServiceDeps) { }

    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /**
     * GET /rewards/drops/:dropId — the drop's content, worked out for every
     * unit of it the caller owns. Anyone signed in may look at a released
     * drop (locked tiers are teasers); an unreleased or removed drop is 404
     * unless the caller owns a unit of it.
     */
    async forDrop(userId: string, dropId: string): Promise<BuyerDropContent> {
        const [drop, units] = await Promise.all([
            this.deps.drops.findDrop(dropId),
            this.deps.drops.ownedUnits(userId, dropId),
        ]);
        if (!drop || (units.length === 0 && (!drop.released || drop.archived))) {
            throw AppError.notFound('Drop not found.', DROP_CONTENT_ERROR_CODES.DROP_NOT_FOUND);
        }
        return this.build(userId, drop, units);
    }

    /**
     * GET /rewards/units/:skuId — what this one unit of mine opens: the drop's
     * regular content, plus any exclusive tier that lists its serial number.
     */
    async forUnit(userId: string, skuId: string): Promise<BuyerDropContent> {
        const unit = await this.deps.drops.ownedUnit(userId, skuId);
        const drop = unit ? await this.deps.drops.findDrop(unit.productId) : null;
        if (!unit || !drop) {
            throw AppError.notFound(
                'That item is not in your collection. Claim it first.',
                DROP_CONTENT_ERROR_CODES.UNIT_NOT_FOUND,
            );
        }
        return this.build(userId, drop, [unit]);
    }

    private async build(userId: string, drop: DropRef, units: OwnedUnit[]): Promise<BuyerDropContent> {
        const rows = (await this.deps.drops.listForDrop(drop.id)).filter(isOpen);
        const now = this.now();
        const content: BuyerDropContentTier[] = [];
        for (const row of rows) {
            const eligible = serialsOf(row);
            const opening = tierOf(row) === 'REGULAR'
                ? units
                : units.filter((unit) => eligible.includes(unit.serialNumber));
            const unlocked = opening.length > 0;
            if (unlocked) await this.recordOpen(userId, row, opening[0]!, now);
            content.push({
                id: row.id,
                publicCode: row.publicCode,
                tier: tierOf(row),
                name: row.name,
                description: row.description,
                itemCounts: itemCounts(row.contentBundleItems),
                itemTotal: row.contentBundleItems.length,
                eligibleSerials: eligible,
                unlocked,
                unlockedBy: opening.map(unitRef),
                items: unlocked ? await itemViews(row.contentBundleItems, this.deps.media, true) : [],
            });
        }
        return {
            drop: { id: drop.id, publicCode: drop.publicCode, name: drop.name, totalSupply: drop.totalSupply },
            myUnits: units.map(unitRef),
            content,
        };
    }

    /** Telemetry, never access control: a failure here must not stop the buyer opening their content. */
    private async recordOpen(userId: string, row: DropContentRow, unit: OwnedUnit, now: Date): Promise<void> {
        try {
            const first = await this.deps.drops.recordOpen(userId, row.id, unit.skuId, now);
            if (first) {
                await this.deps.eventBus?.publish(DROP_CONTENT_EVENTS.OPENED, {
                    bundleId: row.id,
                    dropId: row.productId,
                    tier: tierOf(row),
                    userId,
                    skuId: unit.skuId,
                    serialNumber: unit.serialNumber,
                });
            }
        } catch (error) {
            this.deps.logger.warn({ err: error, bundleId: row.id, userId }, 'could not record a drop content open');
        }
    }
}

/** Content a buyer can open: switched on and not removed. */
function isOpen(row: DropContentRow): boolean {
    return row.isActive && row.archivedAt === null;
}

function unitRef(unit: OwnedUnit): BuyerUnitRef {
    return { skuId: unit.skuId, publicCode: unit.publicCode, serialNumber: unit.serialNumber };
}

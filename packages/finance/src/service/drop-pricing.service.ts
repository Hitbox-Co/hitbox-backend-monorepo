import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { DropPricing, PrismaClient } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    FINANCE_DECISION_AUDIT_EVENTS,
    FINANCE_DECISION_ERROR_CODES,
    FINANCE_DECISION_EVENTS,
    FINANCE_ERROR_CODES,
} from '../constants/finance.constant';
import type { FinanceAccess } from '../domain/finance-access';
import { requireConfigureDropPricing } from '../domain/finance-access';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type { CreateDropPricingDto, DropPricingView } from '../dto/cogs-royalty-payout.dto';
import type { DropPricingRepository } from '../repository/drop-pricing.repository';

export interface DropPricingServiceDeps {
    prisma: PrismaClient;
    pricing: DropPricingRepository;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/** Entries may not be dated this far ahead: only the active version drives orders. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * COGS and sales price, entered together and versioned.
 *
 * Three rules shape this class:
 *
 *  1. **One write path.** COGS, USD price and INR price are a single input.
 *     There is no way to change one without the others, and no update — a
 *     change is a successor version with a stated reason.
 *  2. **Only the active version affects new orders.** Creating a version closes
 *     the previous one and projects the new figures onto the per-market
 *     `DropPrice` rows orders already read. Orders and ledger rows that were
 *     already snapshotted are never rewritten.
 *  3. **Gross profit is the database's job.** `grossProfitUsd/Inr` are
 *     generated columns; this class reads them back and never computes them.
 */
export class DropPricingService {
    constructor(private readonly deps: DropPricingServiceDeps) { }

    async list(dropId: string): Promise<DropPricingView[]> {
        await this.requireDrop(dropId);
        const now = new Date();
        return (await this.deps.pricing.list(dropId)).map((row) => this.toView(row, now));
    }

    async getActive(dropId: string): Promise<DropPricingView> {
        await this.requireDrop(dropId);
        const now = new Date();
        const active = await this.deps.pricing.findActive(dropId, now);
        if (!active) {
            throw AppError.notFound(
                'No pricing is in force for this drop.',
                FINANCE_ERROR_CODES.NOT_FOUND,
            );
        }
        return this.toView(active, now);
    }

    async create(
        dropId: string,
        dto: CreateDropPricingDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<DropPricingView> {
        requireConfigureDropPricing(access, 'enter cost of goods and sales prices');
        await this.requireDrop(dropId);

        const now = new Date();
        const effectiveFrom = dto.effectiveFrom ?? now;
        if (effectiveFrom.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
            throw AppError.badRequest(
                'Pricing cannot be dated in the future.',
                FINANCE_ERROR_CODES.INVALID_RULE,
            );
        }

        const costOfGoods = new Prisma.Decimal(dto.costOfGoods);
        const salesPriceUsd = new Prisma.Decimal(dto.salesPriceUsd);
        const salesPriceInr = new Prisma.Decimal(dto.salesPriceInr);
        if (salesPriceUsd.lessThanOrEqualTo(0) || salesPriceInr.lessThanOrEqualTo(0)) {
            throw AppError.badRequest(
                'Sales prices must be above zero.',
                FINANCE_ERROR_CODES.INVALID_RULE,
            );
        }

        const id = randomUUID();
        const correlationId = randomUUID();

        const created = await this.deps.prisma.$transaction(async (tx) => {
            const active = await this.deps.pricing.findOpen(dropId, tx);
            if (active) {
                if (!dto.varianceReason) {
                    throw AppError.badRequest(
                        'This drop already has pricing in force — a varianceReason is required to supersede it.',
                        FINANCE_DECISION_ERROR_CODES.REASON_REQUIRED,
                        { activeVersion: active.version },
                    );
                }
                if (effectiveFrom.getTime() <= active.effectiveFrom.getTime()) {
                    throw AppError.badRequest(
                        'A new version must start after the one it replaces.',
                        FINANCE_ERROR_CODES.INVALID_TRANSITION,
                    );
                }
                const closed = await this.deps.pricing.closeVersion(active.id, effectiveFrom, tx);
                if (closed === 0) {
                    throw AppError.conflict(
                        'The pricing changed while you were editing it. Reload and try again.',
                        FINANCE_ERROR_CODES.INVALID_TRANSITION,
                    );
                }
            }

            const version = (await this.deps.pricing.latestVersion(dropId, tx)) + 1;
            const row = await this.deps.pricing.create(
                {
                    id,
                    dropId,
                    version,
                    costOfGoods,
                    salesPriceUsd,
                    salesPriceInr,
                    status: 'ACTIVE',
                    effectiveFrom,
                    costSource: dto.costSource ?? null,
                    varianceReason: dto.varianceReason ?? null,
                    createdById: actorId,
                    approvedById: actorId,
                    approvedAt: now,
                },
                tx,
            );

            // Project onto the per-market rows orders read. One market per
            // currency (the default one first); a currency with no active
            // market is simply not projected.
            const markets = await this.deps.pricing.marketsByCurrency(tx);
            const seen = new Set<string>();
            for (const market of markets) {
                if (seen.has(market.currency)) continue;
                seen.add(market.currency);
                await this.deps.pricing.projectToMarket(
                    {
                        id: randomUUID(),
                        dropId,
                        marketId: market.id,
                        amount: market.currency === 'USD' ? salesPriceUsd : salesPriceInr,
                        costOfGoods,
                        effectiveFrom,
                        approvedById: actorId,
                    },
                    tx,
                );
            }

            await this.deps.audit.record(
                {
                    eventType: FINANCE_DECISION_AUDIT_EVENTS.DROP_PRICING_CREATE,
                    actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
                    result: 'SUCCESS',
                    resource: { type: 'DropPricing', id },
                    beforeState: active
                        ? {
                            version: active.version,
                            costOfGoods: active.costOfGoods.toFixed(2),
                            salesPriceUsd: active.salesPriceUsd.toFixed(2),
                            salesPriceInr: active.salesPriceInr.toFixed(2),
                        }
                        : null,
                    afterState: {
                        dropId,
                        version,
                        costOfGoods: costOfGoods.toFixed(2),
                        salesPriceUsd: salesPriceUsd.toFixed(2),
                        salesPriceInr: salesPriceInr.toFixed(2),
                        varianceReason: dto.varianceReason ?? null,
                        costSource: dto.costSource ?? null,
                    },
                    correlationId,
                },
                { tx },
            );
            return row;
        });

        this.deps.logger.info(
            { dropId, version: created.version, actorId },
            'drop pricing version created',
        );
        await this.deps.eventBus.publish(FINANCE_DECISION_EVENTS.DROP_PRICING_CREATED, {
            dropId,
            pricingId: created.id,
            version: created.version,
        });
        return this.toView(created, now);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private async requireDrop(dropId: string): Promise<void> {
        if (!(await this.deps.pricing.dropExists(dropId))) {
            throw AppError.notFound(
                'Drop not found.',
                FINANCE_DECISION_ERROR_CODES.DROP_NOT_FOUND,
            );
        }
    }

    private toView(row: DropPricing, now: Date): DropPricingView {
        return {
            id: row.id,
            publicCode: row.publicCode,
            dropId: row.dropId,
            version: row.version,
            costOfGoods: row.costOfGoods.toFixed(2),
            salesPriceUsd: row.salesPriceUsd.toFixed(2),
            salesPriceInr: row.salesPriceInr.toFixed(2),
            grossProfitUsd: row.grossProfitUsd?.toFixed(2) ?? null,
            grossProfitInr: row.grossProfitInr?.toFixed(2) ?? null,
            status: row.status,
            isActive:
                row.effectiveFrom.getTime() <= now.getTime() &&
                (row.effectiveTo === null || row.effectiveTo.getTime() > now.getTime()),
            effectiveFrom: row.effectiveFrom.toISOString(),
            effectiveTo: row.effectiveTo?.toISOString() ?? null,
            costSource: row.costSource,
            varianceReason: row.varianceReason,
            approvedById: row.approvedById,
            approvedAt: row.approvedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        };
    }
}

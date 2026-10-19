import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { PrismaClient, RoyaltyRule } from '@hitbox/database';
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
import { requireSetRoyaltyRate } from '../domain/finance-access';
import type { PublicCodeResolver } from '../domain/public-codes';
import type { IFinanceAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type {
    ArtistRoyaltyRateView,
    SetArtistRoyaltyRateDto,
} from '../dto/cogs-royalty-payout.dto';
import type { RoyaltyRuleRepository } from '../repository/royalty-rule.repository';

export interface ArtistRoyaltyRateServiceDeps {
    prisma: PrismaClient;
    codes: PublicCodeResolver;
    rules: RoyaltyRuleRepository;
    eventBus: IEventBus;
    audit: IFinanceAuditRecorder;
    logger: Logger;
}

/**
 * The artist-level royalty rate: one flat percentage of net profit that applies
 * to everything the artist sells.
 *
 * It lives in `RoyaltyRule.percentage` (there is no rate column on `Artist`)
 * and is created through this path only: `artistId` set, collection / product /
 * organization null, basis NET_PROFIT. The generic `POST /royalty-rules` and
 * the most-specific-first resolver are untouched, so rules written some other
 * way keep resolving exactly as before; this service only guarantees that the
 * rows *it* writes have the artist-only shape.
 *
 * Immutable for the MVP: once an artist has a rate in force, a second one is
 * refused. Changing it is the explicit two-step the rules module already has —
 * close the current rule, then set a new one — so every figure an accrual was
 * priced with stays explainable.
 */
export class ArtistRoyaltyRateService {
    constructor(private readonly deps: ArtistRoyaltyRateServiceDeps) { }

    async getCurrent(artistId: string): Promise<ArtistRoyaltyRateView | null> {
        const rule = await this.findArtistRule(artistId, new Date());
        return rule ? this.toView(rule, new Date(), await this.artistCode(artistId)) : null;
    }

    async set(
        artistId: string,
        dto: SetArtistRoyaltyRateDto,
        access: FinanceAccess,
        actorId: string,
    ): Promise<ArtistRoyaltyRateView> {
        requireSetRoyaltyRate(access, "set an artist's royalty rate");

        const exists = await this.deps.prisma.artist.count({ where: { id: artistId } });
        if (exists === 0) {
            throw AppError.notFound(
                'Artist not found.',
                FINANCE_DECISION_ERROR_CODES.ARTIST_NOT_FOUND,
            );
        }

        const now = new Date();
        const effectiveFrom = dto.effectiveFrom ?? now;

        const inForce = await this.findArtistRule(artistId, effectiveFrom);
        if (inForce) {
            throw AppError.conflict(
                'This artist already has a royalty rate in force. Close it before setting a new one.',
                FINANCE_DECISION_ERROR_CODES.RATE_OVERLAP,
                { ruleId: inForce.id, percentage: inForce.percentage?.toString() ?? null },
            );
        }

        const percentage = new Prisma.Decimal(dto.percentage);
        if (percentage.lessThanOrEqualTo(0) || percentage.greaterThan(100)) {
            throw AppError.badRequest(
                'The royalty rate must be above 0 and at most 100.',
                FINANCE_ERROR_CODES.INVALID_RULE,
            );
        }

        const correlationId = randomUUID();
        const created = await this.deps.rules.create({
            id: randomUUID(),
            artistId,
            organizationId: null,
            collectionId: null,
            productId: null,
            basis: 'NET_PROFIT',
            splitType: 'SINGLE',
            splitConfig: {} as Prisma.InputJsonValue,
            percentage,
            payoutThreshold: dto.payoutThreshold ? new Prisma.Decimal(dto.payoutThreshold) : null,
            payoutFrequency: 'QUARTERLY',
            effectiveFrom,
            effectiveTo: null,
            createdAt: now,
        });

        await this.deps.audit.record({
            eventType: FINANCE_DECISION_AUDIT_EVENTS.ARTIST_RATE_SET,
            actor: { type: 'HITBOX_EMPLOYEE', id: actorId },
            result: 'SUCCESS',
            resource: { type: 'RoyaltyRule', id: created.id },
            beforeState: null,
            afterState: {
                artistId,
                basis: 'NET_PROFIT',
                percentage: percentage.toString(),
                effectiveFrom: effectiveFrom.toISOString(),
            },
            correlationId,
        });

        this.deps.logger.info(
            { ruleId: created.id, artistId, actorId },
            'artist royalty rate set',
        );
        await this.deps.eventBus.publish(FINANCE_DECISION_EVENTS.ARTIST_ROYALTY_RATE_SET, {
            artistId,
            ruleId: created.id,
            percentage: percentage.toString(),
        });
        return this.toView(created, now, await this.artistCode(artistId));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** The artist-only rule in force at `at`, ignoring rules scoped any other way. */
    private async findArtistRule(artistId: string, at: Date): Promise<RoyaltyRule | null> {
        const { items } = await this.deps.rules.list({
            page: 1,
            limit: 50,
            organizationIds: null,
            skip: 0,
            take: 50,
            artistId,
            activeAt: at,
        });
        return (
            items.find(
                (rule) =>
                    rule.artistId === artistId &&
                    rule.collectionId === null &&
                    rule.productId === null &&
                    rule.organizationId === null,
            ) ?? null
        );
    }

    private async artistCode(artistId: string): Promise<string | null> {
        return (await this.deps.codes.resolve({ artist: [artistId] })).get('artist', artistId);
    }

    private toView(
        rule: RoyaltyRule,
        now: Date,
        artistPublicCode: string | null,
    ): ArtistRoyaltyRateView {
        return {
            ruleId: rule.id,
            artistId: rule.artistId as string,
            artistPublicCode,
            basis: rule.basis,
            percentage: rule.percentage?.toString() ?? null,
            effectiveFrom: rule.effectiveFrom.toISOString(),
            effectiveTo: rule.effectiveTo?.toISOString() ?? null,
            isInForce:
                rule.effectiveFrom.getTime() <= now.getTime() &&
                (rule.effectiveTo === null || rule.effectiveTo.getTime() > now.getTime()),
        };
    }
}

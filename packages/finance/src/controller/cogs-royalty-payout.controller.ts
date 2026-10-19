import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import {
    approveWithReasonSchema,
    createDropPricingSchema,
    quarterlySweepSchema,
    rejectPayoutSchema,
    setArtistRoyaltyRateSchema,
    transferPayoutSchema,
} from '../dto/cogs-royalty-payout.dto';
import type { FinanceAccessResolver } from './finance.controller';
import type { ArtistRoyaltyRateService } from '../service/artist-royalty-rate.service';
import type { DropPricingService } from '../service/drop-pricing.service';
import type { PayoutDecisionService } from '../service/payout-decision.service';
import type { QuarterlyPayoutService } from '../service/quarterly-payout.service';

export interface CogsRoyaltyPayoutControllerDeps {
    dropPricing: DropPricingService;
    artistRates: ArtistRoyaltyRateService;
    decisions: PayoutDecisionService;
    quarterly: QuarterlyPayoutService;
    resolveAccess: FinanceAccessResolver;
}

/** HTTP glue for the COGS / royalty-rate / quarterly-payout features. */
export class CogsRoyaltyPayoutController {
    constructor(private readonly deps: CogsRoyaltyPayoutControllerDeps) { }

    // ── Drop pricing ────────────────────────────────────────────────────────

    listDropPricing: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.deps.dropPricing.list(req.params.dropId as string) });
    });

    getActiveDropPricing: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.deps.dropPricing.getActive(req.params.dropId as string) });
    });

    createDropPricing: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createDropPricingSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({
            data: await this.deps.dropPricing.create(
                req.params.dropId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    // ── Artist royalty rate ─────────────────────────────────────────────────

    getArtistRoyaltyRate: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.deps.artistRates.getCurrent(req.params.artistId as string) });
    });

    setArtistRoyaltyRate: RequestHandler = asyncHandler(async (req, res) => {
        const dto = setArtistRoyaltyRateSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({
            data: await this.deps.artistRates.set(
                req.params.artistId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    // ── Payout decisions ────────────────────────────────────────────────────

    approvePayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = approveWithReasonSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.decisions.approve(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    rejectPayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = rejectPayoutSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.decisions.reject(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    transferPayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = transferPayoutSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.decisions.transfer(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    quarterlySweep: RequestHandler = asyncHandler(async (req, res) => {
        const dto = quarterlySweepSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.quarterly.sweepAs(dto, access, access.userId) });
    });
}

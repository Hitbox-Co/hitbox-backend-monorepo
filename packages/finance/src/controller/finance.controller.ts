import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import type { FinanceAccess } from '../domain/finance-access';
import { requireOverride } from '../domain/finance-access';
import {
    approvePayoutSchema,
    closeRoyaltyRuleSchema,
    createAdjustmentSchema,
    createRoyaltyRuleSchema,
    executePayoutSchema,
    failPayoutSchema,
    listAdjustmentsQuerySchema,
    listFinanceEntriesQuerySchema,
    listPayoutsQuerySchema,
    listRoyaltyEntriesQuerySchema,
    listRoyaltyRulesQuerySchema,
    revenueSummaryQuerySchema,
    reverseRoyaltyEntrySchema,
    schedulePayoutsSchema,
} from '../dto/finance.dto';
import type { FinanceLedgerService } from '../service/finance-ledger.service';
import type { RoyaltyAccrualService } from '../service/royalty-accrual.service';
import type { RoyaltyPayoutService } from '../service/royalty-payout.service';
import type { RoyaltyRuleService } from '../service/royalty-rule.service';

/**
 * Resolves the caller's identity and what they may see. Supplied by bootstrap,
 * so this module never imports the authorization one.
 */
export type FinanceAccessResolver = (req: Request) => Promise<FinanceAccess>;

export interface FinanceControllerDeps {
    rules: RoyaltyRuleService;
    accrual: RoyaltyAccrualService;
    payouts: RoyaltyPayoutService;
    ledger: FinanceLedgerService;
    resolveAccess: FinanceAccessResolver;
}

/** HTTP glue only: parse, resolve the caller, call a service, shape JSON. */
export class FinanceController {
    constructor(private readonly deps: FinanceControllerDeps) { }

    // ── Royalty rules ───────────────────────────────────────────────────────

    listRules: RequestHandler = asyncHandler(async (req, res) => {
        const query = listRoyaltyRulesQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.rules.list(query, access));
    });

    getRule: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.rules.getById(req.params.ruleId as string, access) });
    });

    createRule: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createRoyaltyRuleSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({
            data: await this.deps.rules.create(dto, access, access.userId),
        });
    });

    closeRule: RequestHandler = asyncHandler(async (req, res) => {
        const dto = closeRoyaltyRuleSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.rules.close(
                req.params.ruleId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    // ── Royalty ledger ──────────────────────────────────────────────────────

    listEntries: RequestHandler = asyncHandler(async (req, res) => {
        const query = listRoyaltyEntriesQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.ledger.listRoyaltyEntries(query, access));
    });

    getEntry: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.ledger.getRoyaltyEntry(req.params.entryId as string, access),
        });
    });

    /**
     * A manual reversal. Gated on `payment-royalty:override` rather than
     * `manage`: cancelling an accrual that the calculation says is owed is a
     * different power from running the calculation, and the catalog already
     * separates them.
     */
    reverseEntry: RequestHandler = asyncHandler(async (req, res) => {
        const dto = reverseRoyaltyEntrySchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        requireOverride(access, 'reverse a royalty posting');

        const entry = await this.deps.ledger.requireEntryInScope(
            req.params.entryId as string,
            access,
        );
        res.json({
            data: await this.deps.accrual.reverseEntry({
                entry,
                reason: dto.reason,
                reasonCode: dto.reasonCode,
                actorId: access.userId,
            }),
        });
    });

    // ── Balances & payouts ──────────────────────────────────────────────────

    balances: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        const currency =
            typeof req.query.currency === 'string' ? req.query.currency : undefined;
        res.json({ data: await this.deps.payouts.balances(access, { currency }) });
    });

    listPayouts: RequestHandler = asyncHandler(async (req, res) => {
        const query = listPayoutsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.payouts.list(query, access));
    });

    getPayout: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payouts.getById(req.params.payoutId as string, access),
        });
    });

    schedulePayouts: RequestHandler = asyncHandler(async (req, res) => {
        const dto = schedulePayoutsSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.payouts.schedule(dto, access, access.userId) });
    });

    approvePayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = approvePayoutSchema.parse(req.body ?? {});
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payouts.approve(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    executePayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = executePayoutSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payouts.execute(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    failPayout: RequestHandler = asyncHandler(async (req, res) => {
        const dto = failPayoutSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.payouts.fail(
                req.params.payoutId as string,
                dto,
                access,
                access.userId,
            ),
        });
    });

    // ── Adjustments & platform ledger ───────────────────────────────────────

    listAdjustments: RequestHandler = asyncHandler(async (req, res) => {
        const query = listAdjustmentsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.ledger.listAdjustments(query, access));
    });

    createAdjustment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createAdjustmentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({
            data: await this.deps.ledger.createAdjustment(dto, access, access.userId),
        });
    });

    listLedger: RequestHandler = asyncHandler(async (req, res) => {
        const query = listFinanceEntriesQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.ledger.listFinanceEntries(query, access));
    });

    revenueSummary: RequestHandler = asyncHandler(async (req, res) => {
        const query = revenueSummaryQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.ledger.revenueSummary(query, access) });
    });
}

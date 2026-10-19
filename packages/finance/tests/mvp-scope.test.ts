import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { PublicCodeResolver } from '../src/domain/public-codes';
import { RoyaltyLedgerRepository } from '../src/repository/royalty-ledger.repository';
import { PayoutRepository } from '../src/repository/payout.repository';
import { FinanceLedgerRepository } from '../src/repository/finance-ledger.repository';
import { RoyaltyRuleService } from '../src/service/royalty-rule.service';
import { FinanceLedgerService } from '../src/service/finance-ledger.service';
import { QuarterlyPayoutService } from '../src/service/quarterly-payout.service';
import {
    createAdjustmentSchema,
    listFinanceEntriesQuerySchema,
    listPayoutsQuerySchema,
    listRoyaltyEntriesQuerySchema,
    revenueSummaryQuerySchema,
    schedulePayoutsSchema,
} from '../src/dto/finance.dto';
import {
    accessFor,
    ADMIN_PERMISSIONS,
    makeAudit,
    makeBus,
    makeCodes,
    makePrisma,
    silentLogger,
} from './cogs-royalty-payout.helpers';

const D = (v: string) => new Prisma.Decimal(v);
const admin = accessFor(ADMIN_PERMISSIONS);
const MVP = { in: ['USD', 'INR'] };

/** A prisma stand-in that records the `where` of every query on the models given. */
function spyPrisma(models: string[]) {
    const calls: Record<string, { op: string; where: unknown }[]> = {};
    const client: Record<string, unknown> = {};
    for (const model of models) {
        calls[model] = [];
        const op = (name: string, result: unknown) =>
            jest.fn(async (args: { where?: unknown } = {}) => {
                calls[model]!.push({ op: name, where: args.where });
                return result;
            });
        client[model] = {
            count: op('count', 0),
            findMany: op('findMany', []),
            groupBy: op('groupBy', []),
        };
    }
    return { calls, client: client as never };
}

describe('public codes', () => {
    it('resolves each model in one query, de-duplicated, and reads missing as null', async () => {
        const findMany = jest.fn(async () => [
            { id: 'a1', publicCode: 'art0001' },
            { id: 'a2', publicCode: null },
        ]);
        const resolver = new PublicCodeResolver({
            artist: { findMany },
            order: { findMany: jest.fn(async () => []) },
        } as never);
        const codes = await resolver.resolve({
            artist: ['a1', 'a1', 'a2', null, undefined, 'a3'],
            order: [],
        });

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith({
            where: { id: { in: ['a1', 'a2', 'a3'] } },
            select: { id: true, publicCode: true },
        });
        expect(codes.get('artist', 'a1')).toBe('art0001');
        expect(codes.get('artist', 'a2')).toBeNull();
        expect(codes.get('artist', 'a3')).toBeNull();
        expect(codes.get('artist', null)).toBeNull();
    });

    const entryRow = {
        id: 'e1',
        publicCode: 'rle0001',
        orderId: 'o1',
        ruleId: 'r1',
        skuId: null,
        claimId: null,
        accrualKey: 'k',
        payeeType: 'ARTIST',
        payeeArtistId: 'a1',
        payeeOrganizationId: null,
        basis: 'NET_PROFIT',
        percentage: D('10'),
        grossRevenue: D('25'),
        costOfGoods: D('9'),
        netProfit: D('16'),
        amount: D('1.60'),
        currency: 'USD',
        entryType: 'ADJUSTMENT',
        status: 'ACCRUED',
        adjustsEntryId: 'e0',
        payoutId: 'p1',
        accruedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        payeeArtist: { id: 'a1', name: 'QA Artist' },
        payeeOrganization: null,
    };

    function ledgerService(
        financeLedger: Record<string, unknown>,
        row: Record<string, unknown> = entryRow,
        codes: Record<string, string> = {
            'order:o1': 'odr0001',
            'royaltyPayout:p1': 'pyo0001',
            'royaltyLedgerEntry:e0': 'rle0000',
            'artist:a1': 'art0001',
            'royaltyRule:r1': 'ryr0001',
            'financeLedgerEntry:f1': 'fle0001',
        },
    ) {
        return new FinanceLedgerService({
            codes: makeCodes(codes),
            financeLedger: financeLedger as never,
            ledger: {
                artistIdForUser: jest.fn(async () => null),
                list: jest.fn(async () => ({ total: 1, items: [row] })),
            } as never,
            eventBus: makeBus(),
            audit: makeAudit(),
            logger: silentLogger,
        });
    }

    it('puts codes on royalty entry views, keeping the ids', async () => {
        const { items } = await ledgerService({}).listRoyaltyEntries(
            listRoyaltyEntriesQuerySchema.parse({}),
            admin,
        );
        expect(items[0]).toMatchObject({
            id: 'e1',
            publicCode: 'rle0001',
            orderId: 'o1',
            orderPublicCode: 'odr0001',
            ruleId: 'r1',
            rulePublicCode: 'ryr0001',
            payoutId: 'p1',
            payoutPublicCode: 'pyo0001',
            adjustsEntryId: 'e0',
            adjustsEntryPublicCode: 'rle0000',
            payee: { artistId: 'a1', publicCode: 'art0001' },
        });
    });

    it('returns null codes for rows without one or without a link', async () => {
        const service = ledgerService(
            {},
            { ...entryRow, publicCode: null, payoutId: null, adjustsEntryId: null },
            {},
        );
        const { items } = await service.listRoyaltyEntries(
            listRoyaltyEntriesQuerySchema.parse({}),
            admin,
        );
        expect(items[0]).toMatchObject({
            publicCode: null,
            payoutPublicCode: null,
            adjustsEntryPublicCode: null,
            orderPublicCode: null,
            rulePublicCode: null,
        });
    });

    it('puts codes on adjustments, resolving the polymorphic target by its type', async () => {
        const service = ledgerService({
            listAdjustments: jest.fn(async () => ({
                total: 1,
                items: [
                    {
                        id: 'adj1',
                        publicCode: 'adj0001',
                        targetType: 'FINANCE_LEDGER_ENTRY',
                        targetId: 'f1',
                        orderId: 'o1',
                        amountAdjustment: D('-1.00'),
                        currency: 'USD',
                        reasonCode: 'GOODWILL',
                        reason: 'x',
                        actorId: null,
                        refundRequestId: null,
                        disputeCaseId: null,
                        resultingEntryId: null,
                        createdAt: new Date(),
                    },
                ],
            })),
        });
        const { items } = await service.listAdjustments({ page: 1, limit: 20 } as never, admin);
        expect(items[0]).toMatchObject({
            publicCode: 'adj0001',
            targetId: 'f1',
            targetPublicCode: 'fle0001',
            orderPublicCode: 'odr0001',
        });
    });

    it('puts codes on platform ledger entries', async () => {
        const service = ledgerService({
            listEntries: jest.fn(async () => ({
                total: 1,
                items: [
                    {
                        id: 'f1',
                        publicCode: 'fle0001',
                        orderId: 'o1',
                        entryType: 'ORIGINAL',
                        direction: 'CREDIT',
                        category: 'SALE_REVENUE',
                        amount: D('25'),
                        currency: 'USD',
                        costOfGoods: null,
                        gatewayFee: null,
                        description: null,
                        createdAt: new Date(),
                    },
                ],
            })),
        });
        const { items } = await service.listFinanceEntries(
            listFinanceEntriesQuerySchema.parse({}),
            admin,
        );
        expect(items[0]).toMatchObject({ publicCode: 'fle0001', orderPublicCode: 'odr0001' });
    });
});

describe('USD/INR and artist-payee defaults', () => {
    it('royalty entries: lists USD/INR artist rows by default and ignores organization filters', async () => {
        const { calls, client } = spyPrisma(['royaltyLedgerEntry']);
        await new RoyaltyLedgerRepository(client).list({
            ...listRoyaltyEntriesQuerySchema.parse({
                organizationId: '8a1c5b86-0000-4000-8000-000000000001',
            }),
            scopeFilter: {},
            skip: 0,
            take: 20,
        });
        expect(calls.royaltyLedgerEntry).toHaveLength(2); // count and page share the filter
        for (const call of calls.royaltyLedgerEntry!) {
            expect(call.where).toMatchObject({ currency: MVP, payeeType: 'ARTIST' });
            expect(call.where).not.toHaveProperty('payeeOrganizationId');
        }
    });

    it('royalty entries: an explicit currency narrows within the MVP set', async () => {
        const { calls, client } = spyPrisma(['royaltyLedgerEntry']);
        await new RoyaltyLedgerRepository(client).list({
            ...listRoyaltyEntriesQuerySchema.parse({ currency: 'INR' }),
            scopeFilter: {},
            skip: 0,
            take: 20,
        });
        expect(calls.royaltyLedgerEntry![0]!.where).toMatchObject({ currency: 'INR' });
    });

    it('balances (and so the older /payouts/schedule sweep): USD/INR artists only', async () => {
        const { calls, client } = spyPrisma(['royaltyLedgerEntry']);
        await new RoyaltyLedgerRepository(client).balances({ status: 'ACCRUED' });
        const where = JSON.stringify(calls.royaltyLedgerEntry![0]!.where);
        expect(where).toContain('"USD","INR"');
        expect(where).toContain('"payeeType":"ARTIST"');
    });

    it('payouts: USD/INR artist batches by default', async () => {
        const { calls, client } = spyPrisma(['royaltyPayout']);
        await new PayoutRepository(client).list({
            ...listPayoutsQuerySchema.parse({}),
            scopeFilter: {},
            skip: 0,
            take: 20,
        });
        expect(calls.royaltyPayout!.length).toBe(2);
        for (const call of calls.royaltyPayout!) {
            expect(call.where).toMatchObject({ currency: MVP, payeeType: 'ARTIST' });
        }
    });

    it('platform ledger, adjustments and revenue summary: USD/INR by default', async () => {
        const { calls, client } = spyPrisma(['financeLedgerEntry', 'adjustmentEntry']);
        const repo = new FinanceLedgerRepository(client);
        await repo.listEntries({
            ...listFinanceEntriesQuerySchema.parse({}),
            scopeFilter: {},
            skip: 0,
            take: 20,
        });
        await repo.listAdjustments({
            page: 1,
            limit: 20,
            scopeFilter: {},
            skip: 0,
            take: 20,
        } as never);
        await repo.revenueByCategory({ ...revenueSummaryQuerySchema.parse({}), scopeFilter: {} });
        const all = [...calls.financeLedgerEntry!, ...calls.adjustmentEntry!];
        expect(all.length).toBeGreaterThanOrEqual(5);
        for (const call of all) expect(call.where).toMatchObject({ currency: MVP });
    });

    it('rejects GBP on list queries and on every finance write path that takes a currency', () => {
        expect(listPayoutsQuerySchema.safeParse({ currency: 'GBP' }).success).toBe(false);
        expect(listRoyaltyEntriesQuerySchema.safeParse({ currency: 'GBP' }).success).toBe(false);
        expect(listFinanceEntriesQuerySchema.safeParse({ currency: 'GBP' }).success).toBe(false);
        expect(revenueSummaryQuerySchema.safeParse({ currency: 'GBP' }).success).toBe(false);
        expect(schedulePayoutsSchema.safeParse({ currency: 'GBP' }).success).toBe(false);
        const adjustment = {
            targetType: 'ORDER',
            targetId: '8a1c5b86-0000-4000-8000-000000000001',
            amountAdjustment: '-1.00',
            reasonCode: 'GOODWILL',
            reason: 'x',
        };
        expect(createAdjustmentSchema.safeParse({ ...adjustment, currency: 'GBP' }).success).toBe(
            false,
        );
        expect(createAdjustmentSchema.safeParse({ ...adjustment, currency: 'USD' }).success).toBe(
            true,
        );
    });
});

describe('quarterly sweep scope', () => {
    const entry = (id: string, artist: string | null, currency: string, amount: string) => ({
        id,
        payeeType: artist ? 'ARTIST' : 'ORGANIZATION',
        payeeArtistId: artist,
        payeeOrganizationId: artist ? null : 'org-1',
        currency,
        amount: D(amount),
    });

    function sweepWith(rows: ReturnType<typeof entry>[]) {
        const payoutRows: Record<string, unknown>[] = [];
        const ledger = {
            accruedBefore: jest.fn(async () => rows),
            attachToPayout: jest.fn(async (ids: string[]) => ids.length),
        };
        const { client } = makePrisma();
        const service = new QuarterlyPayoutService({
            prisma: client,
            payouts: {
                create: jest.fn(async (d: Record<string, unknown>) => {
                    payoutRows.push(d);
                    return { id: d.id as string };
                }),
            } as never,
            ledger: ledger as never,
            eventBus: makeBus(),
            audit: makeAudit(),
            logger: silentLogger,
        });
        return { service, payoutRows, ledger };
    }

    const asOf = new Date('2026-10-01T00:01:00Z');

    it('skips GBP and reports it; creates no GBP batch', async () => {
        const { service, payoutRows, ledger } = sweepWith([
            entry('e1', 'artist-1', 'GBP', '10.00'),
            entry('e2', 'artist-1', 'USD', '5.00'),
        ]);
        const result = await service.sweep({ asOf, dryRun: false });
        expect(payoutRows).toHaveLength(1);
        expect(payoutRows[0]).toMatchObject({ currency: 'USD' });
        expect(result.created.every((c) => c.currency !== 'GBP')).toBe(true);
        expect(result.skipped).toEqual([
            expect.objectContaining({ currency: 'GBP', reason: 'GBP payouts are not in MVP scope' }),
        ]);
        expect(ledger.attachToPayout).toHaveBeenCalledTimes(1);
    });

    it('skips organization payees with the stated reason, touching nothing', async () => {
        const { service, payoutRows, ledger } = sweepWith([entry('e1', null, 'USD', '10.00')]);
        const result = await service.sweep({ asOf, dryRun: false });
        expect(payoutRows).toHaveLength(0);
        expect(ledger.attachToPayout).not.toHaveBeenCalled();
        expect(result.skipped).toEqual([
            expect.objectContaining({ reason: 'Organization payouts are not in MVP scope' }),
        ]);
    });
});

describe('RoyaltyRuleService.create scope', () => {
    const ids = {
        artist: '8a1c5b86-0000-4000-8000-0000000000a1',
        product: '8a1c5b86-0000-4000-8000-0000000000b1',
        collection: '8a1c5b86-0000-4000-8000-0000000000c1',
        org: '8a1c5b86-0000-4000-8000-0000000000d1',
    };
    function service() {
        const create = jest.fn(async (data: Record<string, unknown>) => ({
            ...data,
            publicCode: 'ryr0001',
            createdAt: new Date(),
            effectiveTo: null,
        }));
        return {
            create,
            svc: new RoyaltyRuleService({
                rules: { create } as never,
                codes: makeCodes({ [`artist:${ids.artist}`]: 'art0001' }),
                logger: silentLogger,
            }),
        };
    }
    const base = { basis: 'NET_PROFIT', splitType: 'SINGLE', percentage: '10' } as const;

    it('rejects GROSS_REVENUE with a clear code', async () => {
        const { svc, create } = service();
        await expect(
            svc.create(
                { ...base, basis: 'GROSS_REVENUE', artistId: ids.artist } as never,
                admin,
                'u',
            ),
        ).rejects.toMatchObject({ statusCode: 400, code: 'FINANCE_BASIS_NOT_SUPPORTED' });
        expect(create).not.toHaveBeenCalled();
    });

    it.each([
        ['productId', ids.product],
        ['collectionId', ids.collection],
        ['organizationId', ids.org],
    ])('rejects a rule that also sets %s', async (field, value) => {
        const { svc, create } = service();
        await expect(
            svc.create({ ...base, artistId: ids.artist, [field]: value } as never, admin, 'u'),
        ).rejects.toMatchObject({ statusCode: 400, code: 'FINANCE_RULE_SCOPE_NOT_SUPPORTED' });
        expect(create).not.toHaveBeenCalled();
    });

    it('rejects a rule with no artist at all', async () => {
        const { svc } = service();
        await expect(
            svc.create({ ...base, productId: ids.product } as never, admin, 'u'),
        ).rejects.toMatchObject({ code: 'FINANCE_RULE_SCOPE_NOT_SUPPORTED' });
    });

    it('still creates an artist-only NET_PROFIT rule, with public codes on the view', async () => {
        const { svc, create } = service();
        const view = await svc.create({ ...base, artistId: ids.artist } as never, admin, 'u');
        expect(create).toHaveBeenCalledTimes(1);
        expect(view).toMatchObject({
            publicCode: 'ryr0001',
            scope: { artistId: ids.artist, artistPublicCode: 'art0001', productPublicCode: null },
        });
    });
});

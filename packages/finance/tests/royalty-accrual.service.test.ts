import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { NOOP_FINANCE_AUDIT } from '../src/domain/interfaces/audit-recorder.port';
import { RoyaltyAccrualService } from '../src/service/royalty-accrual.service';

const D = (value: string | number) => new Prisma.Decimal(value);

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as never;

/**
 * A fake royalty ledger that behaves like the real one in the only way these
 * tests care about: `accrualKey` is UNIQUE, and a collision returns null
 * rather than throwing. That is the idempotency contract the design document
 * asks for, so the fake enforces it rather than assuming it.
 */
function makeLedger() {
    const rows = new Map<string, Record<string, unknown>>();
    const byKey = new Map<string, string>();

    return {
        rows,
        createEntry: jest.fn(async (data: Record<string, unknown>) => {
            const key = data.accrualKey as string;
            if (byKey.has(key)) return null;
            byKey.set(key, data.id as string);
            rows.set(data.id as string, data);
            return data as never;
        }),
        findByAccrualKey: jest.fn(async (key: string) => {
            const id = byKey.get(key);
            return id ? (rows.get(id) as never) : null;
        }),
        findByOrder: jest.fn(async () => [] as never[]),
        markReversed: jest.fn(async () => 1),
        artistIdForUser: jest.fn(async () => null),
    };
}

function makeFinanceLedger() {
    return {
        post: jest.fn(async (data: Record<string, unknown>) => data as never),
        createAdjustment: jest.fn(async (data: Record<string, unknown>) => ({
            ...data,
            id: (data.id as string) ?? 'adj-1',
        }) as never),
    };
}

const ORDER = {
    orderId: 'order-1',
    status: 'PAID',
    buyerId: 'buyer-1',
    organizationId: 'org-1',
    productId: 'product-456',
    collectionId: null,
    artistId: 'artist-123',
    marketId: 'market-us',
    grossRevenue: '100.00',
    costOfGoods: '25.00',
    currency: 'USD',
    quantity: 1,
};

const RULE = {
    id: 'rule-1',
    organizationId: null,
    artistId: 'artist-123',
    collectionId: null,
    productId: null,
    basis: 'NET_PROFIT' as const,
    splitType: 'SINGLE',
    splitConfig: {},
    percentage: D('15'),
    payoutThreshold: null,
    payoutFrequency: null,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    createdAt: new Date('2026-01-01'),
};

function build(overrides: {
    order?: typeof ORDER | null;
    rules?: (typeof RULE)[];
} = {}) {
    const ledger = makeLedger();
    const financeLedger = makeFinanceLedger();
    const publish = jest.fn(async () => undefined);

    const service = new RoyaltyAccrualService({
        prisma: {
            // Every reversal runs in a transaction; the fake just runs the
            // callback, which is enough for assertions about what was written.
            $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => fn({})) as never,
        } as never,
        rules: {
            findCandidates: jest.fn(async () =>
                (overrides.rules ?? [RULE]) as never,
            ),
        } as never,
        ledger: ledger as never,
        financeLedger: financeLedger as never,
        orderRevenue: {
            findAccruableOrderForSku: jest.fn(async () =>
                (overrides.order === undefined ? ORDER : overrides.order) as never,
            ),
            findOrderRevenue: jest.fn(async () => null),
        },
        eventBus: { publish, subscribe: jest.fn() } as never,
        audit: NOOP_FINANCE_AUDIT,
        logger: silentLogger,
    });

    return { service, ledger, financeLedger, publish };
}

describe('accrueForClaim', () => {
    const CLAIM = {
        claimId: 'claim-1',
        skuId: 'sku-1',
        productId: 'product-456',
        userId: 'buyer-1',
        claimedAt: new Date('2026-06-06T15:15:00Z'),
    };

    it('accrues the design document’s $11.25 when the tag is tapped', async () => {
        const { service, ledger } = build();

        const result = await service.accrueForClaim(CLAIM);

        expect(result.accrued).toBe(true);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.amount).toBe('11.25');

        const written = [...ledger.rows.values()][0];
        expect(written?.status).toBe('ACCRUED');
        expect(written?.claimId).toBe('claim-1');
        expect((written?.grossRevenue as Prisma.Decimal).toFixed(2)).toBe('100.00');
        expect((written?.netProfit as Prisma.Decimal).toFixed(2)).toBe('75.00');
    });

    /**
     * The document's idempotency requirement, at the level it actually has to
     * hold: the *same claim* processed twice — a redelivered event, a retried
     * job — must not credit the artist twice.
     */
    it('is idempotent: the same claim accrues once, however many times it arrives', async () => {
        const { service, ledger } = build();

        const first = await service.accrueForClaim(CLAIM);
        const second = await service.accrueForClaim(CLAIM);

        expect(first.accrued).toBe(true);
        expect(second.accrued).toBe(false);
        expect(second.reason).toBe('ALREADY_ACCRUED');
        expect(ledger.rows.size).toBe(1);
    });

    /**
     * A claim with no order behind it — a giveaway, a promotional send, a
     * support replacement — owes nobody anything, and must not fail the claim.
     */
    it('accrues nothing, without throwing, when no settled order exists', async () => {
        const { service, ledger } = build({ order: null });

        const result = await service.accrueForClaim(CLAIM);

        expect(result.accrued).toBe(false);
        expect(result.reason).toBe('NO_ORDER');
        expect(ledger.rows.size).toBe(0);
    });

    it('accrues nothing when no royalty rule is in force', async () => {
        const { service, ledger } = build({ rules: [] });

        const result = await service.accrueForClaim(CLAIM);

        expect(result.reason).toBe('NO_RULE');
        expect(ledger.rows.size).toBe(0);
    });

    it('books the royalty as an expense on the platform ledger', async () => {
        const { service, financeLedger } = build();

        await service.accrueForClaim(CLAIM);

        expect(financeLedger.post).toHaveBeenCalledTimes(1);
        const posted = financeLedger.post.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(posted.category).toBe('ROYALTY_EXPENSE');
        expect(posted.direction).toBe('DEBIT');
        // Keyed, so a retry cannot post the expense twice.
        expect(String(posted.postingKey)).toMatch(/^royalty-expense:/);
    });

    it('writes one entry per payee on a multi-party split', async () => {
        const { service, ledger } = build({
            rules: [
                {
                    ...RULE,
                    percentage: null as never,
                    splitConfig: {
                        splits: [
                            { payeeType: 'ARTIST', artistId: 'artist-123', percentage: 10 },
                            { payeeType: 'ORGANIZATION', organizationId: 'org-1', percentage: 5 },
                        ],
                    },
                },
            ],
        });

        const result = await service.accrueForClaim(CLAIM);

        expect(result.entries).toHaveLength(2);
        expect(result.entries.map((entry) => entry.amount)).toEqual(['7.50', '3.75']);
    });
});

describe('reverseForOrder', () => {
    const ACCRUED_ENTRY = {
        id: 'entry-1',
        orderId: 'order-1',
        ruleId: 'rule-1',
        skuId: 'sku-1',
        claimId: 'claim-1',
        accrualKey: 'claim:claim-1:rule:rule-1:payee:artist-123',
        payeeType: 'ARTIST' as const,
        payeeArtistId: 'artist-123',
        payeeOrganizationId: null,
        basis: 'NET_PROFIT' as const,
        percentage: D('15'),
        grossRevenue: D('100'),
        costOfGoods: D('25'),
        netProfit: D('75'),
        amount: D('11.25'),
        currency: 'USD' as const,
        entryType: 'ORIGINAL' as const,
        status: 'ACCRUED' as const,
        adjustsEntryId: null,
        payoutId: null,
        accruedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        payeeArtist: null,
        payeeOrganization: null,
    };

    const REVERSAL = {
        orderId: 'order-1',
        reason: 'NFC tag not responding (defective)',
        reasonCode: 'REFUND_REVERSAL' as const,
        actorId: 'admin-1',
        refundRequestId: 'refund-1',
    };

    /**
     * The document's day-21 step: the original royalty entry is NEVER deleted;
     * the refund creates an adjustment entry linking back to it.
     */
    it('marks an unpaid accrual REVERSED and writes an adjustment pointing at it', async () => {
        const { service, ledger, financeLedger } = build();
        ledger.findByOrder.mockResolvedValue([ACCRUED_ENTRY] as never);

        const result = await service.reverseForOrder(REVERSAL);

        expect(result.reversedEntryIds).toEqual(['entry-1']);
        expect(result.clawbackEntryIds).toHaveLength(0);
        expect(ledger.markReversed).toHaveBeenCalledWith('entry-1', expect.anything());

        const adjustment = financeLedger.createAdjustment.mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(adjustment.targetType).toBe('ROYALTY_LEDGER_ENTRY');
        expect(adjustment.targetId).toBe('entry-1');
        expect((adjustment.amountAdjustment as Prisma.Decimal).toFixed(2)).toBe('-11.25');
        expect(adjustment.refundRequestId).toBe('refund-1');
    });

    /**
     * Money already in the artist's bank account cannot be un-sent, so the
     * reversal becomes a debt against future earnings rather than a status
     * change on a settled entry.
     */
    it('posts a negative clawback entry when the royalty was already paid', async () => {
        const { service, ledger } = build();
        ledger.findByOrder.mockResolvedValue([
            { ...ACCRUED_ENTRY, status: 'PAID' },
        ] as never);

        const result = await service.reverseForOrder(REVERSAL);

        expect(result.reversedEntryIds).toHaveLength(0);
        expect(result.clawbackEntryIds).toHaveLength(1);
        expect(ledger.markReversed).not.toHaveBeenCalled();

        const clawback = [...ledger.rows.values()][0];
        expect(clawback?.entryType).toBe('ADJUSTMENT');
        expect(clawback?.adjustsEntryId).toBe('entry-1');
        expect((clawback?.amount as Prisma.Decimal).toFixed(2)).toBe('-11.25');
        // ACCRUED, so it nets off the payee's next batch.
        expect(clawback?.status).toBe('ACCRUED');
    });

    it('skips an entry that was already reversed', async () => {
        const { service, ledger } = build();
        ledger.findByOrder.mockResolvedValue([
            { ...ACCRUED_ENTRY, status: 'REVERSED' },
        ] as never);

        const result = await service.reverseForOrder(REVERSAL);

        expect(result.reversedEntryIds).toHaveLength(0);
        expect(result.clawbackEntryIds).toHaveLength(0);
    });

    it('credits the royalty expense back so margin stops counting it', async () => {
        const { service, ledger, financeLedger } = build();
        ledger.findByOrder.mockResolvedValue([ACCRUED_ENTRY] as never);

        await service.reverseForOrder(REVERSAL);

        const posted = financeLedger.post.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(posted.category).toBe('ROYALTY_EXPENSE');
        expect(posted.direction).toBe('CREDIT');
        expect((posted.amount as Prisma.Decimal).toFixed(2)).toBe('-11.25');
    });
});

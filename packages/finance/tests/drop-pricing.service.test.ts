import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { DropPricingService } from '../src/service/drop-pricing.service';
import { createDropPricingSchema } from '../src/dto/cogs-royalty-payout.dto';
import {
    accessFor,
    ADMIN_PERMISSIONS,
    makeAudit,
    makeBus,
    makePrisma,
    silentLogger,
} from './cogs-royalty-payout.helpers';

const D = (v: string) => new Prisma.Decimal(v);

type Version = {
    id: string;
    dropId: string;
    version: number;
    costOfGoods: Prisma.Decimal;
    salesPriceUsd: Prisma.Decimal;
    salesPriceInr: Prisma.Decimal;
    grossProfitUsd: Prisma.Decimal | null;
    grossProfitInr: Prisma.Decimal | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    status: string;
    [key: string]: unknown;
};

/** In-memory stand-in that mimics what the DB does, including the generated columns. */
function setup(opts: { dropExists?: boolean } = {}) {
    const rows: Version[] = [];
    const projected: Record<string, unknown>[] = [];

    const pricing = {
        dropExists: jest.fn(async () => opts.dropExists ?? true),
        list: jest.fn(async () => [...rows].sort((a, b) => b.version - a.version)),
        findActive: jest.fn(async (_drop: string, at: Date) =>
            rows.find(
                (r) =>
                    r.effectiveFrom <= at && (r.effectiveTo === null || r.effectiveTo > at),
            ) ?? null,
        ),
        findOpen: jest.fn(async () => rows.find((r) => r.effectiveTo === null) ?? null),
        latestVersion: jest.fn(async () => rows.reduce((m, r) => Math.max(m, r.version), 0)),
        closeVersion: jest.fn(async (id: string, to: Date) => {
            const row = rows.find((r) => r.id === id && r.effectiveTo === null);
            if (!row) return 0;
            row.effectiveTo = to;
            row.status = 'DISABLED';
            return 1;
        }),
        create: jest.fn(async (data: Record<string, unknown>) => {
            const row = {
                ...data,
                // What the generated columns would compute.
                grossProfitUsd: (data.salesPriceUsd as Prisma.Decimal).minus(
                    data.costOfGoods as Prisma.Decimal,
                ),
                grossProfitInr: (data.salesPriceInr as Prisma.Decimal).minus(
                    data.costOfGoods as Prisma.Decimal,
                ),
                effectiveTo: null,
                publicCode: null,
                createdAt: new Date(),
            } as Version;
            rows.push(row);
            return row as never;
        }),
        marketsByCurrency: jest.fn(async () => [
            { id: 'market-usd', currency: 'USD', isDefault: true },
            { id: 'market-inr', currency: 'INR', isDefault: false },
            { id: 'market-usd-2', currency: 'USD', isDefault: false },
        ]),
        projectToMarket: jest.fn(async (input: Record<string, unknown>) => {
            projected.push(input);
        }),
    };
    const audit = makeAudit();
    const bus = makeBus();
    const { client } = makePrisma();
    const service = new DropPricingService({
        prisma: client,
        pricing: pricing as never,
        eventBus: bus,
        audit,
        logger: silentLogger,
    });
    return { service, rows, projected, pricing, audit, bus };
}

const admin = accessFor(ADMIN_PERMISSIONS);
const INPUT = {
    costOfGoods: '9.00',
    salesPriceUsd: '25.00',
    salesPriceInr: '2075.00',
};

describe('DropPricingService.create', () => {
    it('stores COGS and both prices as version 1 and reads back the generated profit', async () => {
        const { service, rows, audit } = setup();
        const view = await service.create('drop-1', INPUT, admin, 'admin-1');

        expect(rows).toHaveLength(1);
        expect(view).toMatchObject({
            version: 1,
            costOfGoods: '9.00',
            salesPriceUsd: '25.00',
            salesPriceInr: '2075.00',
            grossProfitUsd: '16.00',
            grossProfitInr: '2066.00',
            isActive: true,
            approvedById: 'admin-1',
        });
        // Gross profit is the database's: the service never sends it.
        expect(rows[0]).not.toHaveProperty('grossProfitUsd', undefined);
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'drop.pricing.create',
                afterState: expect.objectContaining({ version: 1, costOfGoods: '9.00' }),
            }),
            expect.anything(),
        );
    });

    it('never passes grossProfit columns to the insert', async () => {
        const { service, pricing } = setup();
        await service.create('drop-1', INPUT, admin, 'admin-1');
        const data = pricing.create.mock.calls[0]![0] as Record<string, unknown>;
        expect(data).not.toHaveProperty('grossProfitUsd');
        expect(data).not.toHaveProperty('grossProfitInr');
    });

    it('projects onto one USD and one INR market, with the right price each', async () => {
        const { service, projected } = setup();
        await service.create('drop-1', INPUT, admin, 'admin-1');

        expect(projected).toHaveLength(2);
        const usd = projected.find((p) => p.marketId === 'market-usd')!;
        const inr = projected.find((p) => p.marketId === 'market-inr')!;
        expect((usd.amount as Prisma.Decimal).toFixed(2)).toBe('25.00');
        expect((inr.amount as Prisma.Decimal).toFixed(2)).toBe('2075.00');
        expect((usd.costOfGoods as Prisma.Decimal).toFixed(2)).toBe('9.00');
        expect(projected.find((p) => p.marketId === 'market-usd-2')).toBeUndefined();
    });

    it('needs drop:configure — manage on finance is not enough', async () => {
        const { service, rows } = setup();
        const noConfigure = accessFor(['payment-royalty:read:global', 'payment-royalty:manage:global']);
        await expect(service.create('drop-1', INPUT, noConfigure, 'u')).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(rows).toHaveLength(0);
    });

    it('404s for a drop that does not exist', async () => {
        const { service } = setup({ dropExists: false });
        await expect(service.create('nope', INPUT, admin, 'u')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('refuses to date pricing in the future: only the active version drives orders', async () => {
        const { service } = setup();
        await expect(
            service.create(
                'drop-1',
                { ...INPUT, effectiveFrom: new Date(Date.now() + 3_600_000) },
                admin,
                'u',
            ),
        ).rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('versioning', () => {
    it('demands a reason to supersede, then closes the old version and opens the next', async () => {
        const { service, rows } = setup();
        await service.create('drop-1', INPUT, admin, 'admin-1');

        await expect(
            service.create('drop-1', { ...INPUT, costOfGoods: '10.00' }, admin, 'admin-1'),
        ).rejects.toMatchObject({ code: 'FINANCE_REASON_REQUIRED' });
        expect(rows).toHaveLength(1);

        // Move the first version into the past so the successor can start after it.
        rows[0]!.effectiveFrom = new Date(Date.now() - 60_000);
        const second = await service.create(
            'drop-1',
            { ...INPUT, costOfGoods: '10.00', varianceReason: 'Vendor raised unit cost' },
            admin,
            'admin-1',
        );

        expect(second.version).toBe(2);
        expect(second.grossProfitUsd).toBe('15.00');
        expect(rows[0]!.effectiveTo).not.toBeNull();
        expect(rows[0]!.status).toBe('DISABLED');
        // Version 1's own figures are untouched: history is never rewritten.
        expect(rows[0]!.costOfGoods.toFixed(2)).toBe('9.00');

        const all = await service.list('drop-1');
        expect(all.map((v) => [v.version, v.isActive])).toEqual([
            [2, true],
            [1, false],
        ]);
        expect((await service.getActive('drop-1')).version).toBe(2);
    });

    it('will not start a successor before the version it replaces', async () => {
        const { service, rows } = setup();
        await service.create('drop-1', INPUT, admin, 'admin-1');
        rows[0]!.effectiveFrom = new Date(Date.now() - 1_000);
        await expect(
            service.create(
                'drop-1',
                {
                    ...INPUT,
                    varianceReason: 'Backdated by mistake',
                    effectiveFrom: new Date(Date.now() - 5_000),
                },
                admin,
                'admin-1',
            ),
        ).rejects.toBeDefined();
    });
});

describe('createDropPricingSchema', () => {
    it('requires COGS and both prices together', () => {
        expect(createDropPricingSchema.safeParse({ costOfGoods: '9.00' }).success).toBe(false);
        expect(
            createDropPricingSchema.safeParse({ salesPriceUsd: '25.00', salesPriceInr: '2075' })
                .success,
        ).toBe(false);
        expect(createDropPricingSchema.safeParse(INPUT).success).toBe(true);
    });

    it('rejects a client-supplied gross profit — it is generated', () => {
        expect(
            createDropPricingSchema.safeParse({ ...INPUT, grossProfitUsd: '1.00' }).success,
        ).toBe(false);
    });

    it('rejects money that is not a plain 2-decimal amount', () => {
        expect(createDropPricingSchema.safeParse({ ...INPUT, costOfGoods: '9.999' }).success).toBe(
            false,
        );
        expect(createDropPricingSchema.safeParse({ ...INPUT, costOfGoods: '-1' }).success).toBe(
            false,
        );
        expect(createDropPricingSchema.safeParse({ ...INPUT, costOfGoods: 9 }).success).toBe(false);
    });
});

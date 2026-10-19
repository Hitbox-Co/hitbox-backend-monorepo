import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { QuarterlyPayoutService } from '../src/service/quarterly-payout.service';
import {
    accessFor,
    ADMIN_PERMISSIONS,
    makeAudit,
    makeBus,
    makePrisma,
    silentLogger,
} from './cogs-royalty-payout.helpers';

const D = (v: string) => new Prisma.Decimal(v);

type Entry = {
    id: string;
    payeeType: 'ARTIST' | 'ORGANIZATION';
    payeeArtistId: string | null;
    payeeOrganizationId: string | null;
    currency: 'USD' | 'INR';
    amount: Prisma.Decimal;
    accruedAt: Date;
    status: 'ACCRUED' | 'PENDING_PAYOUT';
    payoutId: string | null;
};

const entry = (
    id: string,
    artist: string | null,
    currency: 'USD' | 'INR',
    amount: string,
    accruedAt = '2026-08-15T10:00:00Z',
): Entry => ({
    id,
    payeeType: artist ? 'ARTIST' : 'ORGANIZATION',
    payeeArtistId: artist,
    payeeOrganizationId: artist ? null : 'org-1',
    currency,
    amount: D(amount),
    accruedAt: new Date(accruedAt),
    status: 'ACCRUED',
    payoutId: null,
});

function setup(entries: Entry[]) {
    const payoutRows: Record<string, unknown>[] = [];
    const ledger = {
        // Mirrors the real query: unbatched ACCRUED, accrued before the cutoff.
        accruedBefore: jest.fn(async (cutoff: Date) =>
            entries.filter(
                (e) => e.status === 'ACCRUED' && e.payoutId === null && e.accruedAt < cutoff,
            ),
        ),
        // Guarded like the real one.
        attachToPayout: jest.fn(async (ids: string[], payoutId: string) => {
            let n = 0;
            for (const e of entries) {
                if (ids.includes(e.id) && e.status === 'ACCRUED' && e.payoutId === null) {
                    e.status = 'PENDING_PAYOUT';
                    e.payoutId = payoutId;
                    n++;
                }
            }
            return n;
        }),
    };
    const payouts = {
        create: jest.fn(async (data: Record<string, unknown>) => {
            payoutRows.push(data);
            return { id: data.id as string };
        }),
    };
    const audit = makeAudit();
    const bus = makeBus();
    const { client } = makePrisma();
    const service = new QuarterlyPayoutService({
        prisma: client,
        payouts: payouts as never,
        ledger: ledger as never,
        eventBus: bus,
        audit,
        logger: silentLogger,
    });
    return { service, entries, payoutRows, ledger, audit, bus };
}

// A run on Oct 1 settles Q3 (Jul 1 – Sep 30).
const OCT_1 = new Date('2026-10-01T00:00:05Z');

describe('quarterly sweep', () => {
    it('makes one SCHEDULED payout per payee per currency with the right totals', async () => {
        const { service, payoutRows, entries } = setup([
            entry('e1', 'artist-1', 'USD', '10.00'),
            entry('e2', 'artist-1', 'USD', '5.25'),
            entry('e3', 'artist-1', 'INR', '800.00'),
            entry('e4', 'artist-2', 'USD', '7.00'),
            entry('e5', null, 'USD', '3.00'),
        ]);
        const result = await service.sweep({ asOf: OCT_1, dryRun: false });

        expect(result.quarter).toBe('2026-Q3');
        expect(result.created).toHaveLength(4);
        expect(payoutRows).toHaveLength(4);
        const a1usd = payoutRows.find(
            (p) => p.payeeArtistId === 'artist-1' && p.currency === 'USD',
        )!;
        expect((a1usd.amount as Prisma.Decimal).toFixed(2)).toBe('15.25');
        expect(a1usd.entryCount).toBe(2);
        // SCHEDULED is the pending-approval state; nothing is paid by the sweep.
        expect(payoutRows.every((p) => p.status === 'SCHEDULED')).toBe(true);
        expect(entries.every((e) => e.status === 'PENDING_PAYOUT')).toBe(true);
    });

    it('records the quarter it settled on each batch', async () => {
        const { service, payoutRows } = setup([entry('e1', 'artist-1', 'USD', '10.00')]);
        await service.sweep({ asOf: OCT_1, dryRun: false });
        expect((payoutRows[0]!.payoutPeriodStart as Date).toISOString().slice(0, 10)).toBe(
            '2026-07-01',
        );
        expect((payoutRows[0]!.payoutPeriodEnd as Date).toISOString().slice(0, 10)).toBe(
            '2026-09-30',
        );
    });

    it('leaves entries accrued after the boundary for the next run', async () => {
        const { service, entries, payoutRows } = setup([
            entry('old', 'artist-1', 'USD', '10.00', '2026-09-30T23:59:59Z'),
            entry('new', 'artist-1', 'USD', '4.00', '2026-10-01T00:00:01Z'),
        ]);
        await service.sweep({ asOf: OCT_1, dryRun: false });
        expect(payoutRows).toHaveLength(1);
        expect((payoutRows[0]!.amount as Prisma.Decimal).toFixed(2)).toBe('10.00');
        expect(entries.find((e) => e.id === 'new')!.status).toBe('ACCRUED');
    });

    it('sweeps older unswept entries too, e.g. ones returned by a rejection', async () => {
        const { service, payoutRows } = setup([
            entry('q1', 'artist-1', 'USD', '6.00', '2026-02-10T00:00:00Z'),
            entry('q3', 'artist-1', 'USD', '4.00'),
        ]);
        await service.sweep({ asOf: OCT_1, dryRun: false });
        expect((payoutRows[0]!.amount as Prisma.Decimal).toFixed(2)).toBe('10.00');
    });

    it('is idempotent: a second run creates nothing', async () => {
        const { service, payoutRows } = setup([entry('e1', 'artist-1', 'USD', '10.00')]);
        await service.sweep({ asOf: OCT_1, dryRun: false });
        const again = await service.sweep({ asOf: OCT_1, dryRun: false });
        expect(again.created).toHaveLength(0);
        expect(payoutRows).toHaveLength(1);
    });

    it('skips a payee whose net accrual is zero or negative and leaves entries ACCRUED', async () => {
        const { service, entries, payoutRows } = setup([
            entry('e1', 'artist-1', 'USD', '10.00'),
            entry('adj', 'artist-1', 'USD', '-12.00'),
        ]);
        const result = await service.sweep({ asOf: OCT_1, dryRun: false });
        expect(payoutRows).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
        expect(entries.every((e) => e.status === 'ACCRUED')).toBe(true);
    });

    it('writes nothing on a dry run', async () => {
        const { service, payoutRows, entries, audit } = setup([
            entry('e1', 'artist-1', 'USD', '10.00'),
        ]);
        const result = await service.sweep({ asOf: OCT_1, dryRun: true });
        expect(result.created).toHaveLength(1);
        expect(result.created[0]!.payoutId).toBeNull();
        expect(payoutRows).toHaveLength(0);
        expect(entries[0]!.status).toBe('ACCRUED');
        expect(audit.record).not.toHaveBeenCalled();
    });

    it('skips (does not pay) a payee whose entries changed mid-build', async () => {
        const { service, ledger, entries } = setup([
            entry('e1', 'artist-1', 'USD', '10.00'),
            entry('e2', 'artist-1', 'USD', '5.00'),
        ]);
        ledger.attachToPayout.mockImplementationOnce(async () => 1); // one row lost the race
        const result = await service.sweep({ asOf: OCT_1, dryRun: false });
        expect(result.created).toHaveLength(0);
        expect(result.skipped[0]!.reason).toMatch(/changed while/);
        expect(entries).toHaveLength(2);
    });

    it('audits each batch as a system-run schedule event', async () => {
        const { service, audit } = setup([entry('e1', 'artist-1', 'USD', '10.00')]);
        await service.sweep({ asOf: OCT_1, dryRun: false });
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'royalty.payout.schedule',
                actor: { type: 'SYSTEM' },
                afterState: expect.objectContaining({ quarter: '2026-Q3', status: 'SCHEDULED' }),
            }),
            expect.anything(),
        );
    });
});

describe('sweepAs (manual trigger)', () => {
    it('needs the global manage grant', async () => {
        const { service } = setup([]);
        const readOnly = accessFor(['payment-royalty:read:global']);
        await expect(
            service.sweepAs({ dryRun: true }, readOnly, 'u'),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            service.sweepAs({ dryRun: true }, accessFor(ADMIN_PERMISSIONS), 'u'),
        ).resolves.toMatchObject({ dryRun: true });
    });
});

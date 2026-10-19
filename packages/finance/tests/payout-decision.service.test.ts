import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { PayoutDecisionService } from '../src/service/payout-decision.service';
import {
    approveWithReasonSchema,
    transferPayoutSchema,
} from '../src/dto/cogs-royalty-payout.dto';
import {
    accessFor,
    ADMIN_PERMISSIONS,
    makeAudit,
    makeBus,
    makePrisma,
    silentLogger,
} from './cogs-royalty-payout.helpers';

type Row = Record<string, unknown> & { status: string };

function setup(initial: Partial<Row> = {}) {
    const payout: Row = {
        id: 'payout-1',
        status: 'SCHEDULED',
        entryCount: 3,
        amount: new Prisma.Decimal('120.50'),
        currency: 'USD',
        payeeType: 'ARTIST',
        payeeArtistId: 'artist-1',
        payeeOrganizationId: null,
        ...initial,
    };

    const payouts = {
        findById: jest.fn(async () => ({ ...payout })),
        // Guarded like the real one: only moves when the current status matches.
        transition: jest.fn(async (input: { from: string; data: Record<string, unknown> }) => {
            if (payout.status !== input.from) return 0;
            Object.assign(payout, input.data);
            return 1;
        }),
    };
    const ledger = {
        releaseBatch: jest.fn(async () => 3),
        markBatchPaid: jest.fn(async () => 3),
    };
    const financeLedger = { post: jest.fn(async () => undefined) };
    const audit = makeAudit();
    const { client } = makePrisma();
    const service = new PayoutDecisionService({
        prisma: client,
        payouts: payouts as never,
        ledger: ledger as never,
        financeLedger: financeLedger as never,
        payoutReads: { getById: jest.fn(async () => ({ id: 'payout-1' }) as never) },
        eventBus: makeBus(),
        audit,
        logger: silentLogger,
    });
    return { service, payout, payouts, ledger, financeLedger, audit };
}

const admin = accessFor(ADMIN_PERMISSIONS);
const approveOnly = accessFor(['payment-royalty:read:global', 'payment-royalty:approve:global']);
const transferOnly = accessFor(['payment-royalty:read:global', 'payment-royalty:transfer:global']);
const readOnly = accessFor(['payment-royalty:read:global']);

describe('approve', () => {
    it('moves SCHEDULED to APPROVED and stores approver, time and reason', async () => {
        const { service, payout, audit } = setup();
        await service.approve('payout-1', { reason: 'Q3 totals reconcile' }, admin, 'admin-1');

        expect(payout.status).toBe('APPROVED');
        expect(payout.approvedById).toBe('admin-1');
        expect(payout.approvedAt).toBeInstanceOf(Date);
        expect(payout.approvalReason).toBe('Q3 totals reconcile');
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'royalty.payout.approve',
                severity: 'CRITICAL',
                afterState: expect.objectContaining({ approvalReason: 'Q3 totals reconcile' }),
            }),
            expect.anything(),
        );
    });

    it('refuses a missing or trivial reason, in the service as well as the DTO', async () => {
        const { service, payout } = setup();
        await expect(
            service.approve('payout-1', { reason: '   ' }, admin, 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 400, code: 'FINANCE_REASON_REQUIRED' });
        await expect(
            service.approve('payout-1', { reason: 'ok' }, admin, 'admin-1'),
        ).rejects.toMatchObject({ code: 'FINANCE_REASON_REQUIRED' });
        expect(payout.status).toBe('SCHEDULED');
    });

    it('needs payment-royalty:approve — manage and transfer are not enough', async () => {
        const { service, payout } = setup();
        for (const access of [readOnly, transferOnly]) {
            await expect(
                service.approve('payout-1', { reason: 'Looks right to me' }, access, 'u'),
            ).rejects.toMatchObject({ statusCode: 403 });
        }
        expect(payout.status).toBe('SCHEDULED');
    });

    it.each(['APPROVED', 'PAID', 'CANCELLED', 'FAILED'])(
        'cannot approve a payout that is already %s',
        async (status) => {
            const { service } = setup({ status });
            await expect(
                service.approve('payout-1', { reason: 'Looks right to me' }, admin, 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 409, code: 'FINANCE_INVALID_TRANSITION' });
        },
    );
});

describe('reject', () => {
    it('cancels the batch, records the rejection and returns entries to ACCRUED', async () => {
        const { service, payout, ledger, audit } = setup();
        await service.reject('payout-1', { reason: 'Disputed COGS on two drops' }, admin, 'admin-1');

        expect(payout.status).toBe('CANCELLED');
        expect(payout.rejectedById).toBe('admin-1');
        expect(payout.rejectionReason).toBe('Disputed COGS on two drops');
        expect(payout.rejectedAt).toBeInstanceOf(Date);
        expect(ledger.releaseBatch).toHaveBeenCalledWith('payout-1', expect.anything());
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'royalty.payout.reject',
                afterState: expect.objectContaining({ entriesReleased: 3 }),
            }),
            expect.anything(),
        );
    });

    it('requires a reason and the approve permission', async () => {
        const { service, ledger } = setup();
        await expect(
            service.reject('payout-1', { reason: '' }, admin, 'admin-1'),
        ).rejects.toMatchObject({ code: 'FINANCE_REASON_REQUIRED' });
        await expect(
            service.reject('payout-1', { reason: 'Not this quarter' }, transferOnly, 'u'),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(ledger.releaseBatch).not.toHaveBeenCalled();
    });

    it('cannot reject an approved payout', async () => {
        const { service, ledger } = setup({ status: 'APPROVED' });
        await expect(
            service.reject('payout-1', { reason: 'Changed my mind' }, admin, 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(ledger.releaseBatch).not.toHaveBeenCalled();
    });
});

describe('transfer', () => {
    it('is a separate permission: an approver cannot move the money', async () => {
        const { service, payout, ledger } = setup({ status: 'APPROVED' });
        await expect(
            service.transfer('payout-1', { gatewayPayoutRef: 'po_123' }, approveOnly, 'approver'),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(payout.status).toBe('APPROVED');
        expect(ledger.markBatchPaid).not.toHaveBeenCalled();
    });

    it('records the transfer initiator apart from the approver', async () => {
        const { service, payout, ledger, financeLedger, audit } = setup({
            status: 'APPROVED',
            approvedById: 'approver-1',
        });
        await service.transfer('payout-1', { gatewayPayoutRef: 'po_123' }, transferOnly, 'xfer-1');

        expect(payout.status).toBe('PAID');
        expect(payout.approvedById).toBe('approver-1');
        expect(payout.transferInitiatedById).toBe('xfer-1');
        expect(payout.transferInitiatedAt).toBeInstanceOf(Date);
        expect(ledger.markBatchPaid).toHaveBeenCalled();
        expect(financeLedger.post).toHaveBeenCalledWith(
            expect.objectContaining({ category: 'ROYALTY_PAYOUT', postingKey: 'payout:payout-1' }),
            expect.anything(),
        );
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'royalty.payout.transfer' }),
            expect.anything(),
        );
    });

    it('will not transfer a payout that has not been approved', async () => {
        const { service, ledger } = setup({ status: 'SCHEDULED' });
        await expect(
            service.transfer('payout-1', { gatewayPayoutRef: 'po_123' }, transferOnly, 'x'),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(ledger.markBatchPaid).not.toHaveBeenCalled();
    });

    it('rolls back when the batch entries changed underneath it', async () => {
        const { service, ledger, financeLedger } = setup({ status: 'APPROVED' });
        ledger.markBatchPaid.mockResolvedValueOnce(2);
        await expect(
            service.transfer('payout-1', { gatewayPayoutRef: 'po_123' }, transferOnly, 'x'),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(financeLedger.post).not.toHaveBeenCalled();
    });
});

describe('request schemas', () => {
    it('require a reason and accept the spec name approvalReason as an alias', () => {
        expect(approveWithReasonSchema.safeParse({}).success).toBe(false);
        expect(approveWithReasonSchema.safeParse({ reason: 'abc' }).success).toBe(false);
        expect(approveWithReasonSchema.parse({ reason: 'Totals match' })).toEqual({
            reason: 'Totals match',
        });
        expect(approveWithReasonSchema.parse({ approvalReason: 'Totals match' })).toEqual({
            reason: 'Totals match',
        });
    });

    it('requires a gateway reference to transfer', () => {
        expect(transferPayoutSchema.safeParse({}).success).toBe(false);
        expect(transferPayoutSchema.safeParse({ gatewayPayoutRef: 'po_1' }).success).toBe(true);
    });
});

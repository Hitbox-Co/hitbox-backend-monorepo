import { describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@hitbox/shared';
import { PAYMENT_EVENTS } from '../src/constants/payments.constant';
import type { GatewayRefundUpdate } from '../src/service/refund.service';
import { RefundService } from '../src/service/refund.service';

/**
 * docs/finance/stripe-adapter.md §6 — what `refund.*` webhooks do.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const dec = (v: string) => ({ toFixed: () => v });

function refundRow(over: Record<string, unknown> = {}) {
    return {
        id: 'r1',
        orderId: 'o1',
        status: 'PROCESSED',
        amount: dec('2499.00'),
        currency: 'INR',
        gatewayRefundId: 're_1',
        gatewayStatus: 'PENDING',
        approvedById: 'admin-1',
        ...over,
    };
}

function build(opts: {
    byId?: unknown;
    byGatewayId?: unknown;
    payment?: unknown;
    candidate?: unknown;
    changed?: number;
} = {}) {
    const refunds = {
        findById: jest.fn(async () => opts.byId ?? null),
        findByGatewayRefundId: jest.fn(async () => opts.byGatewayId ?? null),
        findApprovedUnissuedForOrder: jest.fn(async () => opts.candidate ?? null),
        setGatewayStatus: jest.fn(async () => opts.changed ?? 1),
    };
    const payments = { findByGatewayRef: jest.fn(async () => opts.payment ?? null) };
    const audit = { record: jest.fn(async () => undefined), emit: jest.fn() };
    const eventBus = { publish: jest.fn(async () => undefined) };
    const service = new RefundService({
        refunds: refunds as never,
        payments: payments as never,
        gatewayConfigs: {} as never,
        orders: {} as never,
        finance: {} as never,
        royalties: {} as never,
        claims: {} as never,
        eventBus: eventBus as never,
        audit: audit as never,
        logger: silentLogger,
    });
    const process = jest.spyOn(service, 'process').mockResolvedValue({} as never);
    return { service, refunds, payments, audit, eventBus, process };
}

const update = (over: Partial<GatewayRefundUpdate> = {}): GatewayRefundUpdate => ({
    eventType: 'refund.updated',
    gatewayRefundId: 're_1',
    status: 'SUCCEEDED',
    failureReason: null,
    refundRequestId: 'r1',
    paymentRefs: ['pi_1'],
    amountMinor: 249900,
    occurredAt: new Date('2026-10-18T10:00:00Z'),
    correlationId: 'c1',
    ...over,
});

const published = (eventBus: { publish: jest.Mock }) => eventBus.publish.mock.calls.map((c) => c[0]);

describe('applyGatewayRefundUpdate — a refund this platform issued', () => {
    it('records the provider status, found by the metadata refundRequestId', async () => {
        const { service, refunds, eventBus } = build({ byId: refundRow() });
        await service.applyGatewayRefundUpdate(update());
        expect(refunds.setGatewayStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'r1', status: 'SUCCEEDED' }),
        );
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('a FAILED refund is flagged: audited as a failure and published', async () => {
        const { service, audit, eventBus } = build({ byId: refundRow() });
        await service.applyGatewayRefundUpdate(update({ status: 'FAILED', failureReason: 'expired_or_canceled_card' }));
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: 'FAILURE', actor: { type: 'SYSTEM', id: null } }));
        expect(eventBus.publish).toHaveBeenCalledWith(
            PAYMENT_EVENTS.REFUND_FAILED,
            expect.objectContaining({ refundRequestId: 'r1', failureReason: 'expired_or_canceled_card' }),
        );
    });

    it('a repeat of a status already recorded alerts nothing', async () => {
        const { service, audit, eventBus } = build({ byId: refundRow(), changed: 0 });
        await service.applyGatewayRefundUpdate(update({ status: 'FAILED' }));
        expect(audit.record).not.toHaveBeenCalled();
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('metadata pointing at a refund paid by a different provider refund is ignored', async () => {
        const other = refundRow({ id: 'r2' });
        const { service, refunds } = build({ byId: refundRow({ gatewayRefundId: 're_OTHER' }), byGatewayId: other });
        await service.applyGatewayRefundUpdate(update());
        expect(refunds.findByGatewayRefundId).toHaveBeenCalledWith('re_1');
        expect(refunds.setGatewayStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'r2' }));
    });
});

describe('applyGatewayRefundUpdate — a refund issued in the Stripe dashboard', () => {
    const approved = refundRow({ status: 'APPROVED', gatewayRefundId: null, gatewayStatus: null });

    it('matches the approved refund for the same amount and processes it as the approver', async () => {
        const { service, process, refunds } = build({ payment: { orderId: 'o1' }, candidate: approved });
        await service.applyGatewayRefundUpdate(update({ refundRequestId: null, eventType: 'refund.created', status: 'PENDING' }));

        expect(process).toHaveBeenCalledWith(
            'r1',
            { gatewayRefundId: 're_1', processedAt: new Date('2026-10-18T10:00:00Z') },
            expect.objectContaining({ userId: 'admin-1', canRefund: true, scope: 'GLOBAL' }),
            { issuedVia: 'PROVIDER_DASHBOARD' },
        );
        expect(refunds.setGatewayStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', status: 'PENDING' }));
    });

    it('an operator processing it at the same moment (409) is not an error', async () => {
        const { service, process } = build({ payment: { orderId: 'o1' }, candidate: approved });
        process.mockRejectedValueOnce(AppError.conflict('already', 'X'));
        await expect(service.applyGatewayRefundUpdate(update({ refundRequestId: null }))).resolves.toBeUndefined();
    });

    it('a different amount is not matched — it is reported once, on refund.created', async () => {
        const { service, process, audit, eventBus } = build({ payment: { orderId: 'o1' }, candidate: approved });
        await service.applyGatewayRefundUpdate(update({ refundRequestId: null, eventType: 'refund.created', amountMinor: 100000 }));
        expect(process).not.toHaveBeenCalled();
        expect(published(eventBus)).toEqual([PAYMENT_EVENTS.REFUND_UNMATCHED]);
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ afterState: expect.objectContaining({ reason: 'AMOUNT_MISMATCH' }) }));
    });

    it('…and not again on later refund.updated events', async () => {
        const { service, eventBus } = build({ payment: { orderId: 'o1' }, candidate: null });
        await service.applyGatewayRefundUpdate(update({ refundRequestId: null, eventType: 'refund.updated' }));
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('a refund on a charge this platform does not know is ignored', async () => {
        const { service, process, eventBus } = build({ payment: null });
        await service.applyGatewayRefundUpdate(update({ refundRequestId: null, eventType: 'refund.created' }));
        expect(process).not.toHaveBeenCalled();
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('a failed refund nobody here issued is only logged', async () => {
        const { service, payments } = build();
        await service.applyGatewayRefundUpdate(update({ refundRequestId: null, status: 'FAILED' }));
        expect(payments.findByGatewayRef).not.toHaveBeenCalled();
    });
});

import { buildMoneySummary } from '../src/domain/order-money';

/** docs/orders/order-payments-and-refunds-api.md §3 — the money summary. */

const base = {
    orderStatus: 'DELIVERED',
    orderAmount: '2499.00',
    currency: 'INR',
    payments: [{ status: 'SUCCEEDED', amount: '2499.00' }],
    refunds: [] as { id: string; status: string; amount: string | null }[],
    callerCanRefund: true,
};

describe('buildMoneySummary', () => {
    it('a paid, delivered order with no refunds is fully refundable', () => {
        expect(buildMoneySummary(base)).toEqual({
            currency: 'INR',
            charged: '2499.00',
            paid: '2499.00',
            refunded: '0.00',
            refundFailed: '0.00',
            refundInProgress: '0.00',
            refundable: '2499.00',
            canRequestRefund: true,
            refundBlockedReason: null,
            openRefundId: null,
        });
    });

    it('only SUCCEEDED payments count as paid', () => {
        const s = buildMoneySummary({
            ...base,
            payments: [{ status: 'FAILED', amount: '2499.00' }, { status: 'SUCCEEDED', amount: '2499.00' }],
        });
        expect(s.paid).toBe('2499.00');
    });

    it('only PROCESSED refunds reduce what is refundable', () => {
        const s = buildMoneySummary({
            ...base,
            refunds: [
                { id: 'r1', status: 'PROCESSED', amount: '500.00' },
                { id: 'r2', status: 'REJECTED', amount: '1999.00' },
            ],
        });
        expect(s).toMatchObject({ refunded: '500.00', refundable: '1999.00', canRequestRefund: true });
    });

    it('an open refund blocks a second one and is linked', () => {
        const s = buildMoneySummary({ ...base, refunds: [{ id: 'r1', status: 'AWAITING_RETURN', amount: '2499.00' }] });
        expect(s).toMatchObject({
            canRequestRefund: false,
            refundBlockedReason: 'REFUND_IN_PROGRESS',
            refundInProgress: '2499.00',
            openRefundId: 'r1',
        });
    });

    it('a fully refunded order cannot be refunded again', () => {
        const s = buildMoneySummary({
            ...base,
            orderStatus: 'DELIVERED',
            refunds: [{ id: 'r1', status: 'PROCESSED', amount: '2499.00' }],
        });
        expect(s).toMatchObject({ refundable: '0.00', canRequestRefund: false, refundBlockedReason: 'FULLY_REFUNDED' });
    });

    it.each(['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED'])('a %s order is not refundable', (orderStatus) => {
        expect(buildMoneySummary({ ...base, orderStatus }).refundBlockedReason).toBe('ORDER_NOT_REFUNDABLE');
    });

    it('a caller without the refund grant sees the numbers but no button', () => {
        const s = buildMoneySummary({ ...base, callerCanRefund: false });
        expect(s).toMatchObject({ refundable: '2499.00', canRequestRefund: false, refundBlockedReason: 'NO_PERMISSION' });
    });

    it('refundable never goes below zero', () => {
        const s = buildMoneySummary({ ...base, refunds: [{ id: 'r1', status: 'PROCESSED', amount: '3000.00' }] });
        expect(s.refundable).toBe('0.00');
    });
});

describe('buildMoneySummary — refunds the provider failed', () => {
    it('a PROCESSED refund Stripe then failed is not money given back', () => {
        const s = buildMoneySummary({
            ...base,
            orderStatus: 'REFUNDED',
            refunds: [{ id: 'r1', status: 'PROCESSED', amount: '2499.00', gatewayStatus: 'FAILED' }],
        });
        expect(s).toMatchObject({ refunded: '0.00', refundFailed: '2499.00', refundable: '0.00' });
    });

    it('a pending provider refund still counts as refunded', () => {
        const s = buildMoneySummary({
            ...base,
            refunds: [{ id: 'r1', status: 'PROCESSED', amount: '500.00', gatewayStatus: 'PENDING' }],
        });
        expect(s).toMatchObject({ refunded: '500.00', refundFailed: '0.00' });
    });
});

import { refundActions } from '../src/domain/refund-workflow';

/** docs/orders/order-payments-and-refunds-api.md §5 — what a refund screen may offer. */

const r = (status: string, physicalReturnRequired = true, confirmed = false) => ({
    status: status as never,
    physicalReturnRequired,
    physicalReturnConfirmedAt: confirmed ? new Date() : null,
});

describe('refundActions', () => {
    it('REQUESTED with the item still out: confirm the return, approve only by override, or reject', () => {
        expect(refundActions(r('REQUESTED'), true)).toEqual(['CONFIRM_RETURN', 'APPROVE_WITH_OVERRIDE', 'REJECT']);
    });

    it('AWAITING_RETURN once the return is confirmed: approve or reject', () => {
        expect(refundActions(r('AWAITING_RETURN', true, true), true)).toEqual(['APPROVE', 'REJECT']);
    });

    it('no physical return required: approve straight away', () => {
        expect(refundActions(r('REQUESTED', false), true)).toEqual(['APPROVE', 'REJECT']);
    });

    it('APPROVED: process or reject', () => {
        expect(refundActions(r('APPROVED', true, true), true)).toEqual(['PROCESS', 'REJECT']);
    });

    it.each(['PROCESSED', 'REJECTED'])('%s is terminal — nothing to do', (status) => {
        expect(refundActions(r(status, true, true), true)).toEqual([]);
    });

    it('a caller without the refund grant gets no actions', () => {
        expect(refundActions(r('REQUESTED'), false)).toEqual([]);
    });
});

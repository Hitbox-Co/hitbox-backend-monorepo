import { describe, expect, it, jest } from '@jest/globals';
import { RefundService } from '../src/service/refund.service';

/**
 * Executing a refund puts the unit back into stock once it is physically back
 * — docs/orders/order-payments-and-refunds-api.md. The tag is settled first
 * (claim revoked, damaged tags quarantined), then the order lets the unit go.
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const dec = (v: string) => ({ toFixed: () => v });
const ACCESS = { userId: 'admin-1', scope: 'GLOBAL', organizationIds: null, canManage: true, canConfigure: false, canRefund: true } as never;

function build(opts: { returned: boolean; condition?: string | null; revokeFails?: boolean; skuId?: string | null }) {
    const calls: string[] = [];
    const refund = {
        id: 'r1', orderId: 'o1', status: 'APPROVED', amount: dec('2499.00'), currency: 'INR',
        reason: 'Changed mind', reasonCode: 'BUYER_CHANGED_MIND',
        physicalReturnRequired: true,
        physicalReturnConfirmedAt: opts.returned ? new Date('2026-10-20T00:00:00Z') : null,
        nfcTagCondition: opts.condition === undefined ? 'INTACT' : opts.condition,
    };
    const refunds = {
        list: jest.fn(async () => ({ total: 1, items: [refund] })),
        transition: jest.fn(async () => 1),
        setGatewayStatus: jest.fn(async () => 1),
    };
    const orders = {
        findOrderSummary: jest.fn(async () => ({
            orderId: 'o1', organizationId: null, skuId: opts.skuId === undefined ? 'sku-5' : opts.skuId, claimId: null,
        })),
        markRefunded: jest.fn(async () => { calls.push('markRefunded'); return true; }),
    };
    const claims = {
        revokeClaim: jest.fn(async () => {
            calls.push('revokeClaim');
            if (opts.revokeFails) throw new Error('claims down');
            return { revoked: false, claimId: null, ledgerEntryId: null };
        }),
    };
    const service = new RefundService({
        refunds: refunds as never,
        payments: {} as never,
        gatewayConfigs: {} as never,
        orders: orders as never,
        finance: { postRefund: jest.fn(async () => undefined) } as never,
        royalties: { reverseForOrder: jest.fn(async () => undefined) } as never,
        claims: claims as never,
        returnWindowDays: 10,
        eventBus: { publish: jest.fn(async () => undefined) } as never,
        audit: { record: jest.fn(async () => undefined), emit: jest.fn() } as never,
        logger: silentLogger,
    });
    jest.spyOn(service, 'getById').mockResolvedValue({} as never);
    const run = () => service.process('r1', { gatewayRefundId: 're_1' } as never, ACCESS);
    return { run, orders, claims, calls };
}

const restockFlag = (orders: { markRefunded: jest.Mock }) =>
    (orders.markRefunded.mock.calls[0]![0] as { unitReturned: boolean }).unitReturned;

describe('refund execution — the unit back into stock', () => {
    it('a received return releases the unit, after the tag is settled', async () => {
        const { run, orders, calls } = build({ returned: true });
        await run();
        expect(restockFlag(orders)).toBe(true);
        expect(calls).toEqual(['revokeClaim', 'markRefunded']);
    });

    it('a damaged return is quarantined first, then released (claims keeps it off sale)', async () => {
        const { run, orders, claims } = build({ returned: true, condition: 'DAMAGED' });
        await run();
        expect((claims.revokeClaim.mock.calls[0]![0] as { resaleBlockedUntil: Date | null }).resaleBlockedUntil).toBeInstanceOf(Date);
        expect(restockFlag(orders)).toBe(true);
    });

    it('no confirmed return: the item is still with the buyer, so it stays on the order', async () => {
        const { run, orders } = build({ returned: false, condition: null });
        await run();
        expect(restockFlag(orders)).toBe(false);
    });

    it('if the tag step fails, the unit is not released', async () => {
        const { run, orders } = build({ returned: true, revokeFails: true });
        await run();
        expect(restockFlag(orders)).toBe(false);
    });
});

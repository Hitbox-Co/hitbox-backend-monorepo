import { describe, expect, it } from '@jest/globals';
import { buildPaymentAccess } from '../src/domain/payment-access';

/** Who resolves to which payment access — a buyer must be able to raise a refund on their own order. */

const principal = (permissions: string[]) => ({ userId: 'u1', permissions, roles: [] });

describe('buildPaymentAccess', () => {
    it('a buyer (order:*:own only) gets OWN scope and no staff powers', () => {
        expect(buildPaymentAccess(principal(['order:create:own', 'order:read:own']))).toEqual({
            userId: 'u1', scope: 'OWN', organizationIds: [], canManage: false, canConfigure: false, canRefund: false,
        });
    });

    it('someone with neither payment nor order grants is refused', () => {
        expect(() => buildPaymentAccess(principal(['drop:read:public']))).toThrow();
    });

    it('staff with payment-royalty:read:global keep GLOBAL scope', () => {
        expect(buildPaymentAccess(principal(['payment-royalty:read:global', 'order:refund:global']))).toMatchObject({
            scope: 'GLOBAL', canRefund: true,
        });
    });
});

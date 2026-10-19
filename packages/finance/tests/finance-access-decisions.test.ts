import { describe, expect, it } from '@jest/globals';
import { buildFinanceAccess } from '../src/domain/finance-access';

const access = (permissions: string[]) =>
    buildFinanceAccess({ userId: 'u', permissions, roles: [] });

describe('approve / transfer / update / configure are four independent grants', () => {
    it('gives each flag only to its own key', () => {
        const a = access(['payment-royalty:read:global', 'payment-royalty:approve:global']);
        expect([a.canApprove, a.canTransfer, a.canSetRoyaltyRate, a.canConfigureDropPricing]).toEqual(
            [true, false, false, false],
        );

        const t = access(['payment-royalty:read:global', 'payment-royalty:transfer:global']);
        expect([t.canApprove, t.canTransfer]).toEqual([false, true]);

        const u = access(['payment-royalty:read:global', 'payment-royalty:update:global']);
        expect(u.canSetRoyaltyRate).toBe(true);
        expect(u.canApprove).toBe(false);

        const d = access(['payment-royalty:read:global', 'drop:configure:global']);
        expect(d.canConfigureDropPricing).toBe(true);
        expect(d.canSetRoyaltyRate).toBe(false);
    });

    it('does not let manage or override stand in for any of them', () => {
        const a = access([
            'payment-royalty:read:global',
            'payment-royalty:manage:global',
            'payment-royalty:override:global',
        ]);
        expect(a.canManage).toBe(true);
        expect([a.canApprove, a.canTransfer, a.canSetRoyaltyRate, a.canConfigureDropPricing]).toEqual(
            [false, false, false, false],
        );
    });

    it('does not widen an organization-scoped grant to global', () => {
        const a = access(['payment-royalty:read:organization', 'payment-royalty:approve:organization']);
        expect(a.canApprove).toBe(false);
    });
});

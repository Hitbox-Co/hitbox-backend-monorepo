import { describe, expect, it } from '@jest/globals';
import {
    buildBuyerTaxAccess,
    buildTaxAccess,
    requireTaxExport,
    requireTaxManage,
    requireTaxOverride,
    TaxScope,
} from '../src/domain/tax-access';
import type { TaxPrincipal } from '../src/domain/tax-access';

const principal = (permissions: string[], organizationIds: (string | null)[] = []): TaxPrincipal => ({
    userId: 'user-1',
    permissions,
    roles: organizationIds.map((organizationId, index) => ({
        roleId: `role-${index}`,
        roleName: 'Role',
        organizationId,
    })),
});

describe('buildTaxAccess', () => {
    it('refuses a caller with no payment-royalty grant at all', () => {
        // Not an empty list: "you have no invoices" is a claim worth making
        // only when it is true, and a 403 and an empty page mean very
        // different things to whoever is reading the screen.
        expect(() => buildTaxAccess(principal(['order:read:own']))).toThrow(
            /do not have access to tax/i,
        );
    });

    it('reads :global as unrestricted', () => {
        const access = buildTaxAccess(principal(['payment-royalty:read:global']));
        expect(access.scope).toBe(TaxScope.GLOBAL);
        expect(access.organizationIds).toBeNull();
    });

    it('confines :organization to the caller’s own organizations', () => {
        const access = buildTaxAccess(
            principal(['payment-royalty:read:organization'], ['org-1', 'org-1', null, 'org-2']),
        );
        expect(access.scope).toBe(TaxScope.ORGANIZATION);
        expect(access.organizationIds).toEqual(['org-1', 'org-2']);
    });

    it('treats :own as the artist scope', () => {
        const access = buildTaxAccess(principal(['payment-royalty:read:own']));
        expect(access.scope).toBe(TaxScope.OWN);
    });

    it('takes the widest read grant when several are held', () => {
        const access = buildTaxAccess(
            principal(['payment-royalty:read:own', 'payment-royalty:read:global']),
        );
        expect(access.scope).toBe(TaxScope.GLOBAL);
    });

    it('lets manage imply read, so a manage-only grant is not locked out', () => {
        const access = buildTaxAccess(principal(['payment-royalty:manage:global']));
        expect(access.scope).toBe(TaxScope.GLOBAL);
        expect(access.canManage).toBe(true);
    });

    it('does not let read imply manage, override or export', () => {
        const access = buildTaxAccess(principal(['payment-royalty:read:global']));
        expect(access.canManage).toBe(false);
        expect(access.canOverride).toBe(false);
        expect(access.canExport).toBe(false);
    });

    it('treats override and export as separate powers from manage', () => {
        const access = buildTaxAccess(
            principal([
                'payment-royalty:manage:global',
                'payment-royalty:override:global',
                'reports-dashboards:export:global',
            ]),
        );
        expect(access.canManage).toBe(true);
        expect(access.canOverride).toBe(true);
        expect(access.canExport).toBe(true);
    });

    it('does not grant manage from an organization-scoped manage grant', () => {
        // Issuing an invoice and writing a tax rate are platform-level acts
        // against a government; an org-scoped holder of the same capability
        // must not qualify.
        const access = buildTaxAccess(principal(['payment-royalty:manage:organization']));
        expect(access.canManage).toBe(false);
    });
});

describe('buildBuyerTaxAccess', () => {
    it('is always BUYER scope, whatever else the caller holds', () => {
        const access = buildBuyerTaxAccess(
            principal([
                'payment-royalty:read:global',
                'payment-royalty:manage:global',
                'payment-royalty:override:global',
                'reports-dashboards:export:global',
            ]),
        );
        expect(access.scope).toBe(TaxScope.BUYER);
        expect(access.canManage).toBe(false);
        expect(access.canOverride).toBe(false);
        expect(access.canExport).toBe(false);
        expect(access.organizationIds).toEqual([]);
    });

    it('never refuses — a buyer always reaches their own receipts', () => {
        const access = buildBuyerTaxAccess(principal(['order:read:own']));
        expect(access.scope).toBe(TaxScope.BUYER);
        expect(access.userId).toBe('user-1');
    });
});

describe('the require* guards', () => {
    const readOnly = buildTaxAccess(principal(['payment-royalty:read:global']));

    it('refuse a caller without the specific power, naming the action', () => {
        expect(() => requireTaxManage(readOnly, 'issue an invoice')).toThrow(
            /permission to issue an invoice/,
        );
        expect(() => requireTaxOverride(readOnly, 'approve a correction')).toThrow(
            /permission to approve a correction/,
        );
        expect(() => requireTaxExport(readOnly, 'export tax return data')).toThrow(
            /permission to export tax return data/,
        );
    });
});

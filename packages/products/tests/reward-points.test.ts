import { decide, parseCapability, parsePermissionKeyOrThrow, ROLE_CATALOG } from '@hitbox/access-control';
import { AppError } from '@hitbox/shared';
import {
    DROP_POINTS_CAPABILITY,
    PRODUCT_AUDIT_EVENTS,
    PRODUCT_EVENTS,
    PRODUCTS_ERROR_CODES,
    REWARD_POINTS_MAX,
} from '../src/constants/products.constant';
import { setRewardPointsSchema, updateProductSchema } from '../src/dto/product.dto';
import { ProductService } from '../src/service/product.service';

/**
 * Reward points on a drop — docs/admin/drop-reward-points.md. Set by HitBox
 * System Admin only; everyone who can see a drop sees its points, nobody else
 * can change them.
 */

const ORG = 'org-1';

function allowed(roleName: string, assignment: 'ORGANIZATION' | 'GLOBAL'): boolean {
    const grants = (ROLE_CATALOG.find((role) => role.name === roleName)?.permissions ?? [])
        .map((key) => parsePermissionKeyOrThrow(key))
        .map((permission) => ({
            resource: permission.resource,
            action: permission.action,
            scope: permission.scope,
            domain: 'BUSINESS',
            roleId: 'role-1',
            roleName,
            roleDomain: 'BUSINESS',
            assignmentScopeType: assignment,
            assignmentScopeId: assignment === 'ORGANIZATION' ? ORG : null,
            fieldAllowlist: [],
        }));
    const decision = decide(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { userId: 'user-1', grants } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...parseCapability(DROP_POINTS_CAPABILITY)!, context: { organizationId: ORG } } as any,
    );
    // The route is globalOnly: only a platform-wide grant counts.
    return decision.allowed && decision.scope === 'GLOBAL';
}

describe('who may set reward points (PUT /admin/products/:id/reward-points)', () => {
    it('the System Admin may', () => {
        expect(allowed('HITBOX_SYSTEM_ADMIN', 'GLOBAL')).toBe(true);
    });

    it('a Drop Manager may not, although they edit every drop (drop:manage does not imply configure)', () => {
        expect(allowed('HITBOX_DROP_MANAGER', 'GLOBAL')).toBe(false);
    });

    it.each(['ARTIST', 'BRAND_ADMIN', 'BRAND_EMPLOYEE'])('%s may not, even on their own drop', (role) => {
        expect(allowed(role, 'ORGANIZATION')).toBe(false);
    });
});

describe('request schemas', () => {
    it('the drop edit (PATCH) refuses rewardPoints, so the drop form cannot set them', () => {
        const result = updateProductSchema.safeParse({ name: 'Tee', rewardPoints: 50 });
        expect(result.success).toBe(false);
    });

    it('takes a whole number from 0 to the maximum, and an optional reason', () => {
        expect(setRewardPointsSchema.parse({ rewardPoints: 120, reason: ' Launch promo ' })).toEqual({
            rewardPoints: 120,
            reason: 'Launch promo',
        });
        expect(setRewardPointsSchema.parse({ rewardPoints: 0 }).rewardPoints).toBe(0);
        for (const bad of [-1, 1.5, REWARD_POINTS_MAX + 1, 'lots']) {
            expect(setRewardPointsSchema.safeParse({ rewardPoints: bad }).success).toBe(false);
        }
        expect(setRewardPointsSchema.safeParse({}).success).toBe(false);
        expect(setRewardPointsSchema.safeParse({ rewardPoints: 5, name: 'x' }).success).toBe(false);
    });
});

describe('ProductService.setRewardPoints', () => {
    function build(current: { rewardPoints: number } | null) {
        const products = {
            findById: jest.fn(async () => (current ? { id: 'p1', organizationId: ORG, ...current } : null)),
            update: jest.fn(async (_id: string, data: { rewardPoints: number }) => ({
                id: 'p1', organizationId: ORG, rewardPoints: data.rewardPoints,
            })),
        };
        const audit = { record: jest.fn(async () => undefined) };
        const eventBus = { publish: jest.fn(async () => undefined), subscribe: jest.fn() };
        const service = new ProductService({ products, audit, eventBus } as never);
        jest.spyOn(service as unknown as { toResponse: (p: unknown) => unknown }, 'toResponse')
            .mockImplementation((p) => p);
        return { service, products, audit, eventBus };
    }
    const input = (rewardPoints: number, reason?: string) => ({
        id: 'p1',
        dto: { rewardPoints, ...(reason ? { reason } : {}) },
        actorId: 'admin-1',
        correlationId: 'c-1',
    });

    it('sets the points, audits before/after with the reason, and publishes the drop as updated', async () => {
        const { service, products, audit, eventBus } = build({ rewardPoints: 0 });
        const result = await service.setRewardPoints(input(150, 'Launch promo'));

        expect(products.update).toHaveBeenCalledWith('p1', { rewardPoints: 150 });
        expect(result).toMatchObject({ rewardPoints: 150 });
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
            eventType: PRODUCT_AUDIT_EVENTS.REWARD_POINTS_SET,
            actorId: 'admin-1',
            organizationId: ORG,
            productId: 'p1',
            before: { rewardPoints: 0 },
            after: { rewardPoints: 150 },
            metadata: { reason: 'Launch promo' },
        }));
        expect(eventBus.publish).toHaveBeenCalledWith(PRODUCT_EVENTS.PRODUCT_UPDATED, {
            productId: 'p1',
            fields: ['rewardPoints'],
        });
    });

    it('setting the value it already has writes, audits and publishes nothing', async () => {
        const { service, products, audit, eventBus } = build({ rewardPoints: 150 });
        await service.setRewardPoints(input(150));
        expect(products.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('404s an unknown drop', async () => {
        const { service } = build(null);
        await expect(service.setRewardPoints(input(10))).rejects.toBeInstanceOf(AppError);
        await expect(service.setRewardPoints(input(10))).rejects.toMatchObject({
            code: PRODUCTS_ERROR_CODES.PRODUCT_NOT_FOUND,
        });
    });
});

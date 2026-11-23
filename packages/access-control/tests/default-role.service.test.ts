import { describe, expect, it, jest } from '@jest/globals';
import { AppError } from '@hitbox/shared';
import { ACCESS_CONTROL_ERROR_CODES } from '../src/constants/access-control.constant';
import { DefaultRoleService } from '../src/service/default-role.service';

const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as never;
const BUYER = { id: 'role-buyer', name: 'BUYER_COLLECTOR', isActive: true };

function build(role: unknown = BUYER, assign?: () => Promise<unknown>) {
    const assignFn = jest.fn(assign ?? (async () => ({ id: 'a1' })));
    const service = new DefaultRoleService({
        roles: { findByName: jest.fn(async () => role) } as never,
        assignments: { assign: assignFn } as never,
        logger,
    });
    return { service, assignFn };
}

describe('DefaultRoleService', () => {
    it('grants BUYER_COLLECTOR at OWN scope, self-granted', async () => {
        const { service, assignFn } = build();
        expect(await service.grantTo('u1')).toBe(true);
        expect(assignFn).toHaveBeenCalledWith({
            userId: 'u1',
            dto: { roleId: 'role-buyer', scopeType: 'OWN' },
            grantedById: 'u1',
        });
    });

    it('does nothing when the user already holds it (replayed event)', async () => {
        const { service } = build(BUYER, async () => {
            throw AppError.conflict('exists', ACCESS_CONTROL_ERROR_CODES.ASSIGNMENT_EXISTS);
        });
        expect(await service.grantTo('u1')).toBe(false);
    });

    it('does not grant when the role is missing or inactive', async () => {
        for (const role of [null, { ...BUYER, isActive: false }]) {
            const { service, assignFn } = build(role);
            expect(await service.grantTo('u1')).toBe(false);
            expect(assignFn).not.toHaveBeenCalled();
        }
    });

    it('rethrows any other failure', async () => {
        const { service } = build(BUYER, async () => {
            throw new Error('db down');
        });
        await expect(service.grantTo('u1')).rejects.toThrow('db down');
    });
});

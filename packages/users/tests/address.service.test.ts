import { describe, expect, it, jest } from '@jest/globals';
import type { Address } from '@hitbox/database';
import { ZodError } from 'zod';
import { ADDRESS_LIMIT, USERS_ERROR_CODES } from '../src/constants/users.constant';
import { createAddressSchema } from '../src/dto/address.dto';
import { AddressService } from '../src/service/address.service';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;

function row(over: Partial<Address> = {}): Address {
    return {
        id: 'a1', publicCode: null, userId: 'u1', label: 'HOME', labelCustom: null,
        recipientName: 'Arjun Singh', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'KA',
        postalCode: '560001', countryCode: 'IN', phone: null, usage: 'BOTH', isDefault: false,
        isActive: true, archivedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
        ...over,
    } as Address;
}

function build(opts: { owned?: Address | null; active?: Address | null } = {}) {
    const repo = {
        listActive: jest.fn(async () => [row({ isDefault: true }), row({ id: 'a2' })]),
        findActive: jest.fn(async () => (opts.active === undefined ? row() : opts.active)),
        findOwned: jest.fn(async () => (opts.owned === undefined ? row() : opts.owned)),
        create: jest.fn(async (_u: string, f: Record<string, unknown>) => ({ kind: 'OK', address: row({ id: 'new', city: f.city as string }) })),
        update: jest.fn(async (_u: string, _id: string, f: Record<string, unknown>) => row({ city: f.city as string, countryCode: f.countryCode as string })),
        archive: jest.fn(async () => true),
        setDefault: jest.fn(async () => row({ isDefault: true })),
    };
    return { repo, service: new AddressService({ addresses: repo as never, logger }) };
}

const valid = createAddressSchema.parse({
    label: 'Home', recipientName: 'Arjun Singh', line1: '12 MG Road', city: 'Bengaluru', state: 'KA', postalCode: '560001', countryCode: 'IN',
});

describe('AddressService: the caller\'s own book', () => {
    it('lists as the app shape (label name, no internals)', async () => {
        const { service } = build();
        const [first] = await service.list('u1');
        expect(first).toEqual({
            id: 'a1', label: 'Home', recipientName: 'Arjun Singh', line1: '12 MG Road', line2: null, city: 'Bengaluru',
            state: 'KA', postalCode: '560001', countryCode: 'IN', phone: null, isDefault: true, usage: 'BOTH',
            createdAt: new Date('2026-10-01T00:00:00Z'),
        });
        expect(first).not.toHaveProperty('userId');
    });

    it("someone else's or an archived address is 404 USERS_ADDRESS_NOT_FOUND on get, patch, delete and default", async () => {
        const { service, repo } = build({ active: null });
        repo.archive.mockResolvedValue(false);
        repo.setDefault.mockResolvedValue(null as never);
        const expected = { statusCode: 404, code: USERS_ERROR_CODES.ADDRESS_NOT_FOUND };
        await expect(service.get('u1', 'x')).rejects.toMatchObject(expected);
        await expect(service.update('u1', 'x', { city: 'Mysuru' })).rejects.toMatchObject(expected);
        await expect(service.archive('u1', 'x')).rejects.toMatchObject(expected);
        await expect(service.setDefault('u1', 'x')).rejects.toMatchObject(expected);
        // every lookup is keyed on the caller
        expect(repo.findActive).toHaveBeenCalledWith('u1', 'x');
    });

    it('create: 409 USERS_ADDRESS_LIMIT_REACHED at the cap', async () => {
        const { service, repo } = build();
        repo.create.mockResolvedValueOnce({ kind: 'LIMIT_REACHED', limit: ADDRESS_LIMIT } as never);
        await expect(service.create('u1', valid)).rejects.toMatchObject({
            statusCode: 409, code: USERS_ERROR_CODES.ADDRESS_LIMIT_REACHED, details: { limit: 10 },
        });
        expect(repo.create).toHaveBeenCalledWith('u1', valid, 10);
    });

    it('patch re-validates the merged address: a country change alone must still fit', async () => {
        const { service } = build();
        // saved PIN 560001 and state KA do not fit the US
        await expect(service.update('u1', 'a1', { countryCode: 'US' })).rejects.toBeInstanceOf(ZodError);
        await expect(
            service.update('u1', 'a1', { countryCode: 'US', state: 'TX', postalCode: '78701' }),
        ).resolves.toMatchObject({ countryCode: 'US' });
    });

    it('patch merges over the saved address', async () => {
        const { service, repo } = build();
        await service.update('u1', 'a1', { city: 'Mysuru' });
        expect(repo.update).toHaveBeenCalledWith('u1', 'a1', expect.objectContaining({
            city: 'Mysuru', line1: '12 MG Road', postalCode: '560001', label: 'Home',
        }));
    });
});

describe('AddressService.resolveForCheckout: the shared ownership check', () => {
    it("ignores an id that is not the buyer's", async () => {
        const { service } = build({ owned: null });
        await expect(
            service.resolveForCheckout('u1', { shippingAddressId: 'x', billingAddressId: 'y' }),
        ).resolves.toEqual({ shipping: null, billing: null });
    });

    it('returns the country and state of the buyer\'s own addresses', async () => {
        const { service } = build();
        await expect(service.resolveForCheckout('u1', { billingAddressId: 'a1' })).resolves.toEqual({
            shipping: null, billing: { id: 'a1', countryCode: 'IN', state: 'KA' },
        });
    });

    it('rejects an archived address of the buyer', async () => {
        const { service } = build({ owned: row({ isActive: false, archivedAt: new Date() }) });
        await expect(service.resolveForCheckout('u1', { shippingAddressId: 'a1' })).rejects.toMatchObject({
            statusCode: 400, code: USERS_ERROR_CODES.ADDRESS_ARCHIVED,
        });
    });

    it('rejects an address saved for the other side', async () => {
        const { service } = build({ owned: row({ usage: 'SHIPPING' }) });
        await expect(service.resolveForCheckout('u1', { billingAddressId: 'a1' })).rejects.toMatchObject({
            statusCode: 400, code: USERS_ERROR_CODES.ADDRESS_USAGE_MISMATCH,
        });
        await expect(service.resolveForCheckout('u1', { shippingAddressId: 'a1' })).resolves.toMatchObject({
            shipping: { id: 'a1' },
        });
    });

    it('does nothing when no ids are sent', async () => {
        const { service, repo } = build();
        await expect(service.resolveForCheckout('u1', {})).resolves.toEqual({ shipping: null, billing: null });
        expect(repo.findOwned).not.toHaveBeenCalled();
    });
});

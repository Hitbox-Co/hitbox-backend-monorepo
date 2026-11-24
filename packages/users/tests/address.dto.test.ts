import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';
import { createAddressSchema, updateAddressSchema } from '../src/dto/address.dto';

const indian = {
    label: 'Home',
    recipientName: 'Arjun Singh',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'KA',
    postalCode: '560001',
    countryCode: 'IN',
};

const american = {
    label: 'Work',
    recipientName: 'Mia Lopez',
    line1: '500 Congress Ave',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    countryCode: 'US',
};

function issues(input: unknown): Record<string, string> {
    try {
        createAddressSchema.parse(input);
        return {};
    } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        return Object.fromEntries(error.issues.map((issue) => [issue.path.join('.'), issue.message]));
    }
}

describe('create address: shape', () => {
    it('accepts a valid Indian address and defaults usage to BOTH, nulls to null', () => {
        expect(createAddressSchema.parse(indian)).toEqual({
            ...indian, line2: null, phone: null, usage: 'BOTH',
        });
    });

    it('normalizes: upper-cases country and state, strips spaces from a PIN code', () => {
        const parsed = createAddressSchema.parse({
            ...indian, countryCode: 'in', state: 'ka', postalCode: '560 001', line2: '  ', phone: '+91 98000 00000',
        }) as Record<string, unknown>;
        expect(parsed).toMatchObject({
            countryCode: 'IN', state: 'KA', postalCode: '560001', line2: null, phone: '+91 98000 00000',
        });
    });

    it('rejects an unknown label, an unknown field and a bad phone', () => {
        expect(issues({ ...indian, label: 'Cabin' })).toHaveProperty('label');
        expect(issues({ ...indian, isDefault: true })['']).toMatch(/Unrecognized/);
        expect(issues({ ...indian, phone: 'call me' })).toHaveProperty('phone');
    });

    it('rejects a non-ISO country code', () => {
        expect(issues({ ...indian, countryCode: 'ZZ' })).toHaveProperty('countryCode');
    });
});

describe('create address: India', () => {
    it.each(['056001', '56001', '5600011', 'ABCDEF'])('rejects PIN code %s', (postalCode) => {
        expect(issues({ ...indian, postalCode })).toHaveProperty('postalCode');
    });

    it.each(['Karnataka', 'XX', ''])('rejects state %j (needs the ISO code)', (state) => {
        expect(issues({ ...indian, state })).toHaveProperty('state');
    });

    it('needs a state at all', () => {
        const { state: _state, ...withoutState } = indian;
        expect(issues(withoutState)).toHaveProperty('state');
    });
});

describe('create address: United States', () => {
    it.each(['78701', '78701-1234'])('accepts ZIP %s', (postalCode) => {
        expect(issues({ ...american, postalCode })).toEqual({});
    });

    it.each(['7870', '787011', 'ABCDE', '78701-12'])('rejects ZIP %s', (postalCode) => {
        expect(issues({ ...american, postalCode })).toHaveProperty('postalCode');
    });

    it.each(['Texas', 'ZZ'])('rejects state %s', (state) => {
        expect(issues({ ...american, state })).toHaveProperty('state');
    });

    it('accepts DC and territories', () => {
        expect(issues({ ...american, state: 'DC', postalCode: '20001' })).toEqual({});
        expect(issues({ ...american, state: 'PR', postalCode: '00901' })).toEqual({});
    });

    it('reports every problem at once', () => {
        expect(Object.keys(issues({ ...american, state: 'Texas', postalCode: '12' }))).toEqual(
            expect.arrayContaining(['state', 'postalCode']),
        );
    });
});

describe('create address: other countries are loose', () => {
    it('accepts a UK postcode with no state', () => {
        expect(
            issues({ label: 'Other', recipientName: 'A', line1: '1 Road', city: 'London', postalCode: 'ec1a 1bb', countryCode: 'GB' }),
        ).toEqual({});
        expect(
            createAddressSchema.parse({ label: 'Other', recipientName: 'A', line1: '1 Road', city: 'London', postalCode: 'ec1a 1bb', countryCode: 'GB' }),
        ).toMatchObject({ postalCode: 'EC1A 1BB', state: null });
    });

    it('still refuses junk postal codes', () => {
        expect(
            issues({ label: 'Other', recipientName: 'A', line1: '1 Road', city: 'London', postalCode: '!!', countryCode: 'GB' }),
        ).toHaveProperty('postalCode');
    });
});

describe('update address', () => {
    it('is partial and strict', () => {
        expect(updateAddressSchema.parse({ city: 'Mysuru' })).toEqual({ city: 'Mysuru' });
        expect(() => updateAddressSchema.parse({})).toThrow(ZodError);
        expect(() => updateAddressSchema.parse({ isDefault: true })).toThrow(ZodError);
    });

    it('lets optional fields be cleared with null', () => {
        const parsed = updateAddressSchema.parse({ line2: null, phone: null });
        expect(parsed).toEqual({ line2: null, phone: null });
    });
});

import {
    createProductSchema,
    setProductPricesSchema,
    updateProductPriceSchema,
    updateProductSchema,
} from '../src/dto/product.dto';

/**
 * Regression tests for the 422 storm.
 *
 * Every case in the first block is a payload a real client actually sends and
 * that the original schema rejected with `422 VALIDATION_ERROR`. They are
 * pinned here because "be lenient about the wire format" is the kind of
 * decision a later tightening silently undoes.
 */

/** The minimum a create needs: a name and one market price. */
const base = { name: 'T', prices: [{ marketCode: 'IN', amount: '1999.00' }] };

describe('createProductSchema — shapes real clients send', () => {
    it('accepts numbers as strings', () => {
        const parsed = createProductSchema.parse({
            ...base,
            totalSupply: '500',
            purchaseLimit: '2',
            minimumAge: '18',
        });
        expect(parsed.totalSupply).toBe(500);
        expect(parsed.purchaseLimit).toBe(2);
        expect(parsed.minimumAge).toBe(18);
    });

    it('reads "false" as false, not as a truthy string', () => {
        // The trap z.coerce.boolean() falls into: Boolean("false") === true,
        // which would silently flip every age-gated drop to age-gated.
        expect(createProductSchema.parse({ ...base, isAgeSpecific: 'false' }).isAgeSpecific)
            .toBe(false);
        expect(createProductSchema.parse({ ...base, isAgeSpecific: 'true' }).isAgeSpecific)
            .toBe(true);
        expect(createProductSchema.parse({ ...base, isAgeSpecific: 0 }).isAgeSpecific)
            .toBe(false);
    });

    it('treats blank optional text as absent rather than invalid', () => {
        const parsed = createProductSchema.parse({
            ...base,
            description: '',
            vertical: '',
            category: '   ',
            rarity: null,
        });
        expect(parsed.description).toBeNull();
        expect(parsed.vertical).toBeNull();
        expect(parsed.category).toBeNull();
        expect(parsed.rarity).toBeNull();
    });

    it('accepts null for optional relations and numbers', () => {
        const parsed = createProductSchema.parse({
            ...base,
            artistId: null,
            collectionId: '',
            purchaseLimit: null,
        });
        expect(parsed.artistId).toBeNull();
        expect(parsed.collectionId).toBeNull();
    });

    it('accepts the full 12-digit product code the API itself returns', () => {
        // The field takes a 4-digit suffix but the response carries 12 digits,
        // so a client round-tripping its own data sends 12.
        expect(createProductSchema.parse({ ...base, groupCode: '123456780042' }).groupCode)
            .toBe('0042');
        expect(createProductSchema.parse({ ...base, groupCode: '0042' }).groupCode)
            .toBe('0042');
    });

    it('accepts a lower-case status from a UI select', () => {
        expect(createProductSchema.parse({ ...base, status: 'draft' }).status).toBe('DRAFT');
    });

    it('trims the name', () => {
        expect(createProductSchema.parse({ ...base, name: '  Neon Drift  ' }).name)
            .toBe('Neon Drift');
    });

    it('defaults a bare payload', () => {
        expect(createProductSchema.parse(base)).toMatchObject({
            totalSupply: 0,
            status: 'DRAFT',
            isAgeSpecific: false,
            groupCode: '0000',
        });
    });
});

describe('createProductSchema — what is still rejected', () => {
    const rejected: [string, unknown][] = [
        ['a non-numeric number', { ...base, totalSupply: 'lots' }],
        ['a malformed uuid', { ...base, artistId: 'not-a-uuid' }],
        ['an unknown status', { ...base, status: 'LAUNCHED' }],
        ['a blank name', { ...base, name: '   ' }],
        ['a wrong-length group code', { ...base, groupCode: '123' }],
        ['a negative supply', { ...base, totalSupply: -1 }],
        ['an unknown key inside skus', { ...base, skus: { count: 1, tagIds: ['04A3'] } }],
    ];

    it.each(rejected)('rejects %s', (_label, body) => {
        expect(createProductSchema.safeParse(body).success).toBe(false);
    });
});

/**
 * Compulsory pricing. A drop with no price is not purchasable in any market —
 * the storefront reads `ProductPrice` for the buyer's market and finds
 * nothing — so the API refuses to create one.
 */
describe('createProductSchema — pricing is mandatory', () => {
    it('refuses a create with no prices key at all', () => {
        const result = createProductSchema.safeParse({ name: 'T' });
        expect(result.success).toBe(false);
    });

    it('refuses an empty price list, with a message that says why', () => {
        const result = createProductSchema.safeParse({ name: 'T', prices: [] });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => /at least one market price/i.test(i.message)))
                .toBe(true);
        }
    });

    it('accepts one price and that is enough', () => {
        expect(createProductSchema.safeParse(base).success).toBe(true);
    });

    it('accepts a price per market', () => {
        const parsed = createProductSchema.parse({
            name: 'T',
            prices: [
                { marketCode: 'IN', amount: '1999.00' },
                { marketCode: 'US', amount: '24.99', costOfGoods: '8.10' },
                { marketCode: 'GB', isFree: true },
            ],
        });
        expect(parsed.prices).toHaveLength(3);
        expect(parsed.prices[2]!.isFree).toBe(true);
    });
});

describe('price entries', () => {
    const price = (extra: Record<string, unknown>) =>
        setProductPricesSchema.safeParse({ prices: [{ marketCode: 'IN', ...extra }] });

    it('requires exactly one way of naming the market', () => {
        expect(
            setProductPricesSchema.safeParse({
                prices: [{ marketId: '11111111-2222-3333-4444-555555555555', marketCode: 'IN', amount: '1' }],
            }).success,
        ).toBe(false);
        expect(setProductPricesSchema.safeParse({ prices: [{ amount: '1' }] }).success).toBe(false);
    });

    it('requires an amount unless the price is free', () => {
        expect(price({}).success).toBe(false);
        expect(price({ isFree: true }).success).toBe(true);
        expect(price({ amount: '10.00' }).success).toBe(true);
    });

    it('refuses a free price that also carries an amount', () => {
        // Which of the two did the operator mean? Guessing gets it wrong half
        // the time, on the field that decides what a buyer is charged.
        expect(price({ isFree: true, amount: '10.00' }).success).toBe(false);
    });

    it('takes an amount as a number or a string and keeps it exact', () => {
        // Kept as a string end to end: a float round-trip can turn 1999.99
        // into 1999.9899999999998, and Decimal(12,2) would round it silently.
        expect(price({ amount: 1999.99 }).success).toBe(true);
        const parsed = setProductPricesSchema.parse({
            prices: [{ marketCode: 'IN', amount: '1999.99' }],
        });
        expect(parsed.prices[0]!.amount).toBe('1999.99');
    });

    it('rejects money that Decimal(12,2) cannot hold', () => {
        expect(price({ amount: '10.999' }).success).toBe(false);
        expect(price({ amount: '-5.00' }).success).toBe(false);
        expect(price({ amount: '99999999999.00' }).success).toBe(false);
    });

    it('has no currency field — the market decides', () => {
        expect(price({ amount: '10.00', currency: 'USD' }).success).toBe(false);
    });

    it('catches two prices for the same market and variant', () => {
        // The DB index cannot catch the base-price case: variantId is
        // nullable and Postgres never collides NULLs in a unique index.
        const result = setProductPricesSchema.safeParse({
            prices: [
                { marketCode: 'IN', amount: '10.00' },
                { marketCode: 'IN', amount: '20.00' },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('allows the same market twice for different variants', () => {
        expect(
            setProductPricesSchema.safeParse({
                prices: [
                    { marketCode: 'IN', amount: '10.00' },
                    {
                        marketCode: 'IN',
                        amount: '20.00',
                        variantId: '11111111-2222-3333-4444-555555555555',
                    },
                ],
            }).success,
        ).toBe(true);
    });

    it('defaults a price to ACTIVE and accepts a lower-case status', () => {
        const parsed = setProductPricesSchema.parse({
            prices: [
                { marketCode: 'IN', amount: '10.00' },
                { marketCode: 'US', amount: '1.00', status: 'disabled' },
            ],
        });
        expect(parsed.prices[0]!.status).toBe('ACTIVE');
        expect(parsed.prices[1]!.status).toBe('DISABLED');
    });

    it('refuses an empty replacement list, so a drop cannot be de-priced', () => {
        expect(setProductPricesSchema.safeParse({ prices: [] }).success).toBe(false);
    });
});

describe('updateProductPriceSchema', () => {
    it('allows a partial edit', () => {
        expect(updateProductPriceSchema.parse({ status: 'disabled' })).toEqual({
            status: 'DISABLED',
        });
    });

    it('still refuses free-plus-amount', () => {
        expect(updateProductPriceSchema.safeParse({ isFree: true, amount: '5.00' }).success)
            .toBe(false);
    });

    it('lets costOfGoods be cleared with null', () => {
        expect(updateProductPriceSchema.parse({ costOfGoods: null })).toEqual({
            costOfGoods: null,
        });
    });
});

describe('updateProductSchema', () => {
    it('does not apply create-time defaults to a partial edit', () => {
        // If .partial() left the defaults live, an empty PATCH would reset a
        // live drop's status to DRAFT.
        expect(updateProductSchema.parse({})).toEqual({});
        expect(updateProductSchema.parse({ name: 'x' })).toEqual({ name: 'x' });
    });

    it('keeps null distinguishable from absent, so a relation can be detached', () => {
        expect(updateProductSchema.parse({ artistId: null })).toEqual({ artistId: null });
        expect('artistId' in updateProductSchema.parse({ name: 'x' })).toBe(false);
    });

    it('refuses minting through an edit', () => {
        expect(updateProductSchema.safeParse({ skus: { count: 5 } }).success).toBe(false);
    });

    it('refuses repricing through an edit — that is PUT /prices', () => {
        // Not cosmetic: `prices` used to reach `product.update()` as if it
        // were a scalar column, which Prisma would have rejected at runtime.
        expect(
            updateProductSchema.safeParse({ prices: [{ marketCode: 'IN', amount: '1' }] }).success,
        ).toBe(false);
    });

    it('refuses gallery edits through an edit — that is PUT /images', () => {
        expect(
            updateProductSchema.safeParse({
                images: [{ assetId: '11111111-2222-3333-4444-555555555555' }],
            }).success,
        ).toBe(false);
    });

    it('refuses unknown keys', () => {
        expect(updateProductSchema.safeParse({ nmae: 'typo' }).success).toBe(false);
    });
});

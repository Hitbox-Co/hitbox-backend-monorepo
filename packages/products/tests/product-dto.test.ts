import { createProductSchema, updateProductSchema } from '../src/dto/product.dto';

/**
 * Regression tests for the 422 storm.
 *
 * Every case in the first block is a payload a real client actually sends and
 * that the original schema rejected with `422 VALIDATION_ERROR`. They are
 * pinned here because "be lenient about the wire format" is the kind of
 * decision a later tightening silently undoes.
 */

describe('createProductSchema — shapes real clients send', () => {
    it('accepts numbers as strings', () => {
        const parsed = createProductSchema.parse({
            name: 'T',
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
        expect(createProductSchema.parse({ name: 'T', isAgeSpecific: 'false' }).isAgeSpecific)
            .toBe(false);
        expect(createProductSchema.parse({ name: 'T', isAgeSpecific: 'true' }).isAgeSpecific)
            .toBe(true);
        expect(createProductSchema.parse({ name: 'T', isAgeSpecific: 0 }).isAgeSpecific)
            .toBe(false);
    });

    it('treats blank optional text as absent rather than invalid', () => {
        const parsed = createProductSchema.parse({
            name: 'T',
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
            name: 'T',
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
        expect(createProductSchema.parse({ name: 'T', groupCode: '123456780042' }).groupCode)
            .toBe('0042');
        expect(createProductSchema.parse({ name: 'T', groupCode: '0042' }).groupCode)
            .toBe('0042');
    });

    it('accepts a lower-case status from a UI select', () => {
        expect(createProductSchema.parse({ name: 'T', status: 'draft' }).status).toBe('DRAFT');
    });

    it('trims the name', () => {
        expect(createProductSchema.parse({ name: '  Neon Drift  ' }).name).toBe('Neon Drift');
    });

    it('defaults a bare payload', () => {
        const parsed = createProductSchema.parse({ name: 'T' });
        expect(parsed).toMatchObject({
            totalSupply: 0,
            status: 'DRAFT',
            isAgeSpecific: false,
            groupCode: '0000',
        });
    });
});

describe('createProductSchema — what is still rejected', () => {
    const rejected: [string, unknown][] = [
        ['a non-numeric number', { name: 'T', totalSupply: 'lots' }],
        ['a malformed uuid', { name: 'T', artistId: 'not-a-uuid' }],
        ['an unknown status', { name: 'T', status: 'LAUNCHED' }],
        ['a blank name', { name: '   ' }],
        ['a wrong-length group code', { name: 'T', groupCode: '123' }],
        ['a negative supply', { name: 'T', totalSupply: -1 }],
        ['an unknown key inside skus', { name: 'T', skus: { count: 1, tagIds: ['04A3'] } }],
    ];

    it.each(rejected)('rejects %s', (_label, body) => {
        expect(createProductSchema.safeParse(body).success).toBe(false);
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

    it('refuses unknown keys', () => {
        expect(updateProductSchema.safeParse({ nmae: 'typo' }).success).toBe(false);
    });
});

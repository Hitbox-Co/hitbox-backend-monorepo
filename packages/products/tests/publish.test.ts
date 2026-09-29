import { publishProductSchema, updateProductSchema } from '../src/dto/product.dto';

/**
 * The two halves of one change.
 *
 * A publish route with preconditions is worthless while `PATCH { status }`
 * sits next to it with none — so the gate and the closed door are tested
 * together, and neither can be removed without this file failing.
 */

describe('PATCH no longer moves a drop through its lifecycle', () => {
    it('REFUSES status outright', () => {
        // The hole this closes: `PATCH { status: "ACTIVE" }` took a drop from
        // DRAFT to live without the artist ever being asked, wrote no approval
        // row, set no publishedAt and left no audit trail.
        const result = updateProductSchema.safeParse({ status: 'ACTIVE' });
        expect(result.success).toBe(false);
    });

    it.each(['DRAFT', 'SUBMITTED', 'APPROVED', 'PUBLISHED', 'ACTIVE', 'ENDED', 'ARCHIVED'])(
        'refuses status=%s',
        (status) => {
            expect(updateProductSchema.safeParse({ status }).success).toBe(false);
        },
    );

    it('names the offending field rather than ignoring it', () => {
        // `.strict()` matters here: silently dropping `status` would look to
        // the caller exactly like the publish succeeded.
        const result = updateProductSchema.safeParse({ name: 'Ember', status: 'ACTIVE' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(JSON.stringify(result.error.issues)).toMatch(/status/);
        }
    });

    it('still accepts the ordinary catalog fields', () => {
        const result = updateProductSchema.safeParse({
            name: 'Ember Series',
            description: 'Second pressing.',
        });
        expect(result.success).toBe(true);
    });
});

describe('the publish body', () => {
    it('defaults to ACTIVE — "publish" means "make it live"', () => {
        const result = publishProductSchema.safeParse({});
        expect(result.success && result.data.target).toBe('ACTIVE');
    });

    it('accepts PUBLISHED for staging', () => {
        // PUBLISHED is orderable but not listed by the storefront, which
        // filters on ACTIVE (PUBLIC_PRODUCT_WHERE).
        const result = publishProductSchema.safeParse({ target: 'PUBLISHED' });
        expect(result.success && result.data.target).toBe('PUBLISHED');
    });

    it('takes a lower-case target from a form', () => {
        const result = publishProductSchema.safeParse({ target: 'active' });
        expect(result.success && result.data.target).toBe('ACTIVE');
    });

    it('refuses a target that is not a live state', () => {
        // Publishing is not a way to reach DRAFT, REJECTED or ARCHIVED — those
        // belong to other transitions.
        for (const target of ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ENDED', 'ARCHIVED']) {
            expect(publishProductSchema.safeParse({ target }).success).toBe(false);
        }
    });

    it('accepts an optional note', () => {
        const result = publishProductSchema.safeParse({ note: 'Cleared with the label.' });
        expect(result.success && result.data.note).toBe('Cleared with the label.');
    });
});

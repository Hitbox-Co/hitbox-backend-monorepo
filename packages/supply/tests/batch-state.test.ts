import { SupplyBatchStatus } from '@hitbox/database';
import { acceptsRows, canTransition, isTerminal } from '../src/domain/batch-state';
import {
    createBatchSchema,
    createVendorSchema,
    decideBatchSchema,
    manifestRowSchema,
    registerTagsSchema,
    updateVendorSchema,
} from '../src/dto/supply.dto';
import { formatTagCode, nextTagOrdinal } from '../src/repository/supply.repository';
import { percent } from '../src/service/supply.service';

describe('the intake state machine', () => {
    it('walks UPLOADED -> VALIDATED -> ACCEPTED', () => {
        expect(canTransition(SupplyBatchStatus.UPLOADED, SupplyBatchStatus.VALIDATED)).toBe(true);
        expect(canTransition(SupplyBatchStatus.VALIDATED, SupplyBatchStatus.ACCEPTED)).toBe(true);
    });

    it('lets a small hand-keyed consignment skip VALIDATED', () => {
        expect(canTransition(SupplyBatchStatus.UPLOADED, SupplyBatchStatus.ACCEPTED)).toBe(true);
    });

    it('refuses to walk an accepted consignment backwards', () => {
        // The stock is physically in the building by then; pretending otherwise
        // loses the record that it ever arrived.
        expect(canTransition(SupplyBatchStatus.ACCEPTED, SupplyBatchStatus.REJECTED)).toBe(false);
        expect(canTransition(SupplyBatchStatus.ACCEPTED, SupplyBatchStatus.VALIDATED)).toBe(false);
    });

    it('refuses to re-decide a rejected consignment', () => {
        expect(canTransition(SupplyBatchStatus.REJECTED, SupplyBatchStatus.ACCEPTED)).toBe(false);
    });

    it('refuses a transition to itself, so a double-click is a 409', () => {
        expect(canTransition(SupplyBatchStatus.ACCEPTED, SupplyBatchStatus.ACCEPTED)).toBe(false);
    });

    it('marks both decisions terminal', () => {
        expect(isTerminal(SupplyBatchStatus.ACCEPTED)).toBe(true);
        expect(isTerminal(SupplyBatchStatus.REJECTED)).toBe(true);
        expect(isTerminal(SupplyBatchStatus.UPLOADED)).toBe(false);
    });

    it('accepts rows while under review, never after a decision', () => {
        // Rows are registered with the reviewer watching; appending to an
        // already-accepted consignment silently changes a decision.
        expect(acceptsRows(SupplyBatchStatus.UPLOADED)).toBe(true);
        expect(acceptsRows(SupplyBatchStatus.VALIDATED)).toBe(true);
        expect(acceptsRows(SupplyBatchStatus.ACCEPTED)).toBe(false);
        expect(acceptsRows(SupplyBatchStatus.REJECTED)).toBe(false);
    });
});

describe('the decision body', () => {
    it('requires a note to reject', () => {
        const result = decideBatchSchema.safeParse({ status: 'REJECTED' });
        expect(result.success).toBe(false);
    });

    it('treats a whitespace-only note as no note', () => {
        expect(
            decideBatchSchema.safeParse({ status: 'REJECTED', note: '   ' }).success,
        ).toBe(false);
    });

    it('accepts a rejection with a note', () => {
        expect(
            decideBatchSchema.safeParse({ status: 'REJECTED', note: 'Seals broken on arrival.' })
                .success,
        ).toBe(true);
    });

    it('does not require a note to accept — taking delivery carries no dispute', () => {
        expect(decideBatchSchema.safeParse({ status: 'ACCEPTED' }).success).toBe(true);
    });

    it('takes a lower-case status from a query-shaped client', () => {
        const result = decideBatchSchema.safeParse({ status: 'accepted' });
        expect(result.success && result.data.status).toBe(SupplyBatchStatus.ACCEPTED);
    });
});

describe('the manifest row', () => {
    it('strips separators and upper-cases a UID', () => {
        const result = manifestRowSchema.safeParse({ uid: '04:a3:9b:2c:5d:6e:80' });
        expect(result.success && result.data.uid).toBe('04A39B2C5D6E80');
    });

    it('accepts the same UID written three ways as one value', () => {
        const parse = (uid: string) => manifestRowSchema.parse({ uid }).uid;
        expect(parse('04-A3-9B-2C-5D-6E-80')).toBe(parse('04 a3 9b 2c 5d 6e 80'));
        expect(parse('04A39B2C5D6E80')).toBe(parse('04:a3:9b:2c:5d:6e:80'));
    });

    it('refuses a non-hexadecimal UID', () => {
        expect(manifestRowSchema.safeParse({ uid: 'NOT-A-TAG-XYZ!' }).success).toBe(false);
    });

    it('refuses a UID too short to be one', () => {
        expect(manifestRowSchema.safeParse({ uid: '04A3' }).success).toBe(false);
    });

    it('defaults dryRun to false, so an unflagged call writes', () => {
        const result = registerTagsSchema.safeParse({ tags: [{ uid: '04A39B2C5D6E80' }] });
        expect(result.success && result.data.dryRun).toBe(false);
    });

    it('refuses an empty manifest', () => {
        expect(registerTagsSchema.safeParse({ tags: [] }).success).toBe(false);
    });
});

describe('the vendor body — what a real form actually sends', () => {
    /**
     * The regression this locks down: an admin edit form posts every control it
     * renders, and the ones the user left blank arrive as `''`. Before this,
     * `contactEmail: ""` and `country: ""` were a 422 complaining the value was
     * not an email / not two characters — true, and useless, because the caller
     * was saying "there is no email".
     */
    it('accepts a full edit form with blank optional controls', () => {
        const result = updateVendorSchema.safeParse({
            name: 'Shenzhen ChipWorks',
            legalName: '',
            country: '',
            contactName: '',
            contactEmail: '',
            contactPhone: '',
            notes: '',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.contactEmail).toBeUndefined();
            expect(result.data.country).toBeUndefined();
            expect(result.data.legalName).toBeUndefined();
            expect(result.data.name).toBe('Shenzhen ChipWorks');
        }
    });

    it('accepts a blank email on create too', () => {
        const result = createVendorSchema.safeParse({
            name: 'ChipWorks',
            vendorType: 'NFC_TAG_MANUFACTURER',
            contactEmail: '',
            country: '',
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.contactEmail).toBeUndefined();
    });

    it('still refuses an email that was typed and is wrong', () => {
        // The blank-string escape must not become a way past validation.
        expect(
            updateVendorSchema.safeParse({ contactEmail: 'not-an-email' }).success,
        ).toBe(false);
    });

    it('still refuses a country that is not two characters', () => {
        expect(updateVendorSchema.safeParse({ country: 'India' }).success).toBe(false);
    });

    it('upper-cases a lower-case country code', () => {
        const result = updateVendorSchema.safeParse({ country: 'cn' });
        expect(result.success && result.data.country).toBe('CN');
    });

    it('refuses a body with no fields at all', () => {
        expect(updateVendorSchema.safeParse({}).success).toBe(false);
    });

    it('takes the archive switch', () => {
        const result = updateVendorSchema.safeParse({ archived: true });
        expect(result.success && result.data.archived).toBe(true);
    });
});

describe('the consignment body', () => {
    it('defaults batchDate from receivedAt only in the service, not the schema', () => {
        const result = createBatchSchema.safeParse({
            vendorId: '00000000-0000-4000-8000-000000000001',
            itemType: 'nfc_tag',
            quantity: '500',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.quantity).toBe(500);
            expect(result.data.batchDate).toBeUndefined();
            // `receivedAt` defaults to now so a same-day intake needs no date.
            expect(result.data.receivedAt).toBeInstanceOf(Date);
        }
    });

    it('refuses a zero-quantity consignment', () => {
        expect(
            createBatchSchema.safeParse({
                vendorId: '00000000-0000-4000-8000-000000000001',
                itemType: 'NFC_TAG',
                quantity: 0,
            }).success,
        ).toBe(false);
    });
});

describe('tag codes', () => {
    it('zero-pads to a fixed width, which is what makes lexical order numeric', () => {
        expect(formatTagCode(1)).toBe('NT00000001');
        expect(formatTagCode(42)).toBe('NT00000042');
        // The property the allocator relies on.
        expect(formatTagCode(9) < formatTagCode(10)).toBe(true);
        expect(formatTagCode(99) < formatTagCode(100)).toBe(true);
    });

    it('fits inside VarChar(10)', () => {
        expect(formatTagCode(99_999_999)).toHaveLength(10);
    });

    it('starts at 1 on an empty table', () => {
        expect(nextTagOrdinal(undefined)).toBe(1);
    });

    it('continues from the highest issued code', () => {
        expect(nextTagOrdinal('NT00000042')).toBe(43);
    });

    it('restarts rather than producing NaN on an unparseable code', () => {
        expect(nextTagOrdinal('NTXXXXXXXX')).toBe(1);
    });
});

describe('percent', () => {
    it('renders two decimals as a string, never a float', () => {
        expect(percent(1, 3)).toBe('33.33');
        expect(percent(2, 3)).toBe('66.67');
    });

    it('renders a zero denominator as 0.00, not NaN', () => {
        // "No rows were decided" is a real state on the intake screen, and it
        // should render as a number.
        expect(percent(0, 0)).toBe('0.00');
        expect(percent(5, 0)).toBe('0.00');
    });

    it('renders a whole number with its decimals intact', () => {
        expect(percent(1, 1)).toBe('100.00');
        expect(percent(0, 10)).toBe('0.00');
    });
});

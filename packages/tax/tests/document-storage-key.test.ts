import { describe, expect, it } from '@jest/globals';
import {
    artistTaxDocumentKey,
    filingDocumentKey,
    invoiceDocumentKey,
    isTaxKey,
    normaliseExtension,
    TAX_PREFIXES,
} from '../src/domain/document-storage-key';

/**
 * The prefixes the bucket policy grants anonymous `s3:GetObject` on, copied
 * from `@hitbox/media`'s `PUBLIC_PREFIXES` and from §4 of
 * docs/media/s3-configuration.md.
 *
 * Duplicated rather than imported because @hitbox/tax deliberately does not
 * depend on @hitbox/media — but the fact matters here more than anywhere: an
 * invoice carries a customer's name and postal address, and a W-9 carries a
 * taxpayer identification number. If a tax prefix ever drifted under a public
 * one, nothing would break, no error would be logged, and the documents would
 * simply be on the open internet.
 */
const PUBLIC_PREFIXES = ['drop-images/', 'profile-images/'];

describe('tax documents are never anonymously readable', () => {
    it('no tax prefix sits under a publicly readable one', () => {
        for (const taxPrefix of TAX_PREFIXES) {
            for (const publicPrefix of PUBLIC_PREFIXES) {
                expect(taxPrefix.startsWith(publicPrefix)).toBe(false);
            }
        }
    });

    it('every key this module builds lands under a tax prefix', () => {
        const keys = [
            invoiceDocumentKey({
                countryCode: 'IN',
                fiscalYear: '2026-27',
                invoiceNumber: 'INV-2026-27-IN-001234',
            }),
            filingDocumentKey({
                countryCode: 'IN',
                filingType: 'GSTR_1',
                period: '2026-09',
                filingId: 'aaaaaaaa-0000-0000-0000-000000000001',
            }),
            artistTaxDocumentKey({
                artistId: 'bbbbbbbb-0000-0000-0000-000000000001',
                documentType: 'W9',
                documentId: 'cccccccc-0000-0000-0000-000000000001',
                extension: 'scan.PDF',
            }),
        ];

        for (const key of keys) {
            expect(isTaxKey(key)).toBe(true);
            for (const publicPrefix of PUBLIC_PREFIXES) {
                expect(key.startsWith(publicPrefix)).toBe(false);
            }
        }
    });

    it('does not claim a key from another module', () => {
        expect(isTaxKey('drop-images/products/x/y.jpg')).toBe(false);
        expect(isTaxKey('legal-documents/organizations/x/y.pdf')).toBe(false);
    });
});

describe('key layout', () => {
    it('files an invoice by jurisdiction and fiscal year', () => {
        expect(
            invoiceDocumentKey({
                countryCode: 'IN',
                fiscalYear: '2026-27',
                invoiceNumber: 'INV-2026-27-IN-001234',
            }),
        ).toBe('tax-invoices/IN/2026-27/INV-2026-27-IN-001234.pdf');
    });

    it('files an artist document by artist and type', () => {
        expect(
            artistTaxDocumentKey({
                artistId: 'bbbbbbbb-0000-0000-0000-000000000001',
                documentType: 'W9',
                documentId: 'cccccccc-0000-0000-0000-000000000001',
                extension: 'pdf',
            }),
        ).toBe(
            'tax-artist-documents/artists/bbbbbbbb-0000-0000-0000-000000000001/W9/' +
            'cccccccc-0000-0000-0000-000000000001.pdf',
        );
    });
});

describe('path safety', () => {
    it('refuses a segment that could escape the prefix', () => {
        expect(() =>
            invoiceDocumentKey({
                countryCode: 'IN',
                fiscalYear: '../../drop-images',
                invoiceNumber: 'INV-1',
            }),
        ).toThrow(/Unsafe fiscal year/);

        expect(() =>
            invoiceDocumentKey({
                countryCode: 'IN',
                fiscalYear: '2026-27',
                invoiceNumber: 'a/b',
            }),
        ).toThrow(/Unsafe invoice number/);
    });

    it('normalises an extension down to something safe', () => {
        expect(normaliseExtension('Scan.PDF')).toBe('pdf');
        expect(normaliseExtension('w9.tar.gz')).toBe('gz');
        expect(normaliseExtension('no-extension')).toBe('bin');
        expect(normaliseExtension('weird.<script>')).toBe('bin');
    });
});

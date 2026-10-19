import { describe, expect, it } from '@jest/globals';
import { calculateInvoice } from '../src/domain/tax-calculation';
import { HITBOX_LOGO_PNG } from '../src/infrastructure/hitbox-logo.asset';
import { InvoicePdfRenderer } from '../src/infrastructure/invoice-pdf.renderer';
import type { InvoiceDocumentModel } from '../src/infrastructure/invoice-pdf.renderer';

const totals = calculateInvoice([
    {
        description: 'LeBron James Signature Jersey — Edition 042/500',
        hsnCode: '9706',
        quantity: 1,
        unitPrice: '2000.00',
        taxRate: '12',
    },
]);

function indianInvoice(overrides: Partial<InvoiceDocumentModel> = {}): InvoiceDocumentModel {
    return {
        invoiceNumber: 'INV-2026-27-IN-001234',
        invoiceDate: new Date('2026-09-15T00:00:00Z'),
        dueDate: new Date('2026-09-22T00:00:00Z'),
        countryCode: 'IN',
        stateCode: 'KA',
        currency: 'INR',
        status: 'ISSUED',
        taxType: 'GST',
        supplier: {
            legalName: 'HitBox Collectibles Private Limited',
            addressLines: ['Prestige Atrium', 'Bengaluru 560001'],
            gstin: '29AABCH5055K1Z4',
            pan: 'AABCH5055K',
        },
        customer: {
            name: 'Arjun Singh',
            email: 'arjun@example.in',
            addressLines: ['Indiranagar', 'Bengaluru 560038'],
        },
        orderReference: 'ORD-1',
        lines: totals.lines,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
        taxRate: totals.uniformTaxRate,
        ...overrides,
    };
}

describe('the mandatory-field gate', () => {
    const renderer = new InvoicePdfRenderer();

    it('refuses an Indian invoice with no supplier GSTIN', () => {
        // §1.4 of the compliance guide: a GST invoice without the supplier's
        // GSTIN is not a deficient invoice, it is not an invoice. Catching it
        // at render is much better than at filing.
        return expect(
            renderer.render(
                indianInvoice({
                    supplier: { legalName: 'HitBox', addressLines: ['X'], gstin: null },
                }),
            ),
        ).rejects.toThrow(/supplier's GSTIN/);
    });

    it('refuses an Indian invoice with a line missing its HSN/SAC code', () => {
        return expect(
            renderer.render(
                indianInvoice({
                    lines: totals.lines.map((line) => ({ ...line, hsnCode: null, sacCode: null })),
                }),
            ),
        ).rejects.toThrow(/HSN\/SAC code on line 1/);
    });

    it('names every missing field at once rather than one per attempt', () => {
        return expect(
            renderer.render(
                indianInvoice({
                    invoiceNumber: '',
                    supplier: { legalName: '', addressLines: [], gstin: null },
                }),
            ),
        ).rejects.toThrow(/invoice number; supplier name; supplier's GSTIN; supplier address/);
    });

    it('does NOT require an HSN code on a US invoice', async () => {
        // The US has no federal invoice law and no HSN equivalent; requiring
        // one would block every US invoice.
        const pdf = await renderer.render(
            indianInvoice({
                countryCode: 'US',
                stateCode: 'CA',
                currency: 'USD',
                taxType: 'SALES_TAX',
                supplier: { legalName: 'HitBox Collectibles Inc.', addressLines: ['SF'], ein: '88-1234567' },
                lines: totals.lines.map((line) => ({ ...line, hsnCode: null })),
            }),
        );
        expect(pdf.length).toBeGreaterThan(0);
    });

    it('refuses an invoice with no line items', () => {
        return expect(renderer.render(indianInvoice({ lines: [] }))).rejects.toThrow(
            /at least one line item/,
        );
    });
});

describe('rendering', () => {
    const renderer = new InvoicePdfRenderer();

    it('produces a single-page PDF', async () => {
        const pdf = await renderer.render(indianInvoice());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        // One page for a one-line invoice. This is a real regression guard:
        // writing the footer below the bottom margin used to make PDFKit add a
        // page per footer, silently turning every invoice into three pages.
        expect(countPages(pdf)).toBe(1);
    });

    it('is deterministic — the same row renders to the same document', async () => {
        const [first, second] = await Promise.all([
            renderer.render(indianInvoice()),
            renderer.render(indianInvoice()),
        ]);
        // Byte-identical: the renderer is a pure projection of the row, so an
        // invoice can be re-produced years later and still hash the same.
        expect(first.equals(second)).toBe(true);
    });

    it('always carries a logo, and an override path that is missing falls back', async () => {
        // The mark is embedded in the module rather than read from disk, so
        // there is no configuration under which an invoice renders without
        // one. A bad TAX_INVOICE_LOGO_PATH must degrade to the embedded logo,
        // not fail the render — a wrong logo is cosmetic, an invoice that
        // could not be issued is a compliance problem.
        const embedded = await renderer.render(indianInvoice());
        const withBadPath = await new InvoicePdfRenderer({
            logoPath: '/does/not/exist.png',
        }).render(indianInvoice());

        expect(withBadPath.equals(embedded)).toBe(true);
        expect(HITBOX_LOGO_PNG.subarray(1, 4).toString()).toBe('PNG');
    });

    it('stamps a void invoice so it stops reading like a valid one', async () => {
        const issued = await renderer.render(indianInvoice());
        const voided = await renderer.render(
            indianInvoice({ status: 'VOID', voidReason: 'Duplicate of INV-2026-27-IN-001233' }),
        );
        expect(voided.length).not.toBe(issued.length);
        expect(countPages(voided)).toBe(1);
    });
});

/** Counts `/Type /Page` objects — enough to catch accidental pagination. */
function countPages(pdf: Buffer): number {
    return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

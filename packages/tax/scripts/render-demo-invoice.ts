/**
 * Renders the two demo invoices and, with `--upload`, puts them in S3.
 *
 *     pnpm --filter @hitbox/tax demo:invoice
 *     pnpm --filter @hitbox/tax demo:invoice -- --upload
 *
 * Why this exists: the invoice PDF is the one artefact in the system whose
 * correctness is a visual judgement — you cannot assert your way to "this looks
 * like a tax invoice". So the renderer is driven here with the exact figures
 * printed in the compliance guide (§1.4's ₹2,000 + 12% GST = ₹2,240 Indian
 * example, §2.3's $25.00 + 8.625% sales tax = $27.16 US example), and the
 * output is the reference both a reviewer and a test can compare against.
 *
 * It touches no database. `--upload` uses the same `S3DocumentStorage` and the
 * same key convention the service uses, so a successful run also proves the
 * bucket, the credentials and the key prefix are wired correctly — which is the
 * smoke test docs/tax/s3-storage.md asks for before first production use.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoiceDocumentKey } from '../src/domain/document-storage-key';
import { calculateInvoice } from '../src/domain/tax-calculation';
import { formatInvoiceNumber } from '../src/domain/invoice-number';
import { fiscalYearOf } from '../src/domain/fiscal-calendar';
import { InvoicePdfRenderer } from '../src/infrastructure/invoice-pdf.renderer';
import type { InvoiceDocumentModel } from '../src/infrastructure/invoice-pdf.renderer';
import { S3DocumentStorage } from '../src/infrastructure/s3-document-storage';
import { HSN_COLLECTIBLES, INVOICE_PAYMENT_TERMS_DAYS } from '../src/constants/tax.constant';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/tax/examples');
const ISSUED_AT = new Date('2026-09-15T10:30:00.000Z');

function dueDate(from: Date): Date {
    return new Date(from.getTime() + INVOICE_PAYMENT_TERMS_DAYS * 86_400_000);
}

// ── India: GST @ 12% on a ₹2,000 collectible (compliance guide §1.4) ────────
const indiaTotals = calculateInvoice([
    {
        description: 'LeBron James Signature Jersey — Lakers 2026 Drop, Edition 042/500',
        hsnCode: HSN_COLLECTIBLES,
        quantity: 1,
        unitPrice: '2000.00',
        taxRate: '12.00',
    },
]);

const indiaInvoice: InvoiceDocumentModel = {
    invoiceNumber: formatInvoiceNumber({
        fiscalYear: fiscalYearOf('IN', ISSUED_AT),
        countryCode: 'IN',
        sequence: 1234,
    }),
    invoiceDate: ISSUED_AT,
    dueDate: dueDate(ISSUED_AT),
    countryCode: 'IN',
    stateCode: 'KA',
    currency: 'INR',
    status: 'ISSUED',
    taxType: 'GST',
    supplier: {
        legalName: 'HitBox Collectibles Private Limited',
        addressLines: [
            '4th Floor, Prestige Atrium, 1 Central Street',
            'Bengaluru, Karnataka 560001',
            'India',
        ],
        gstin: '29AABCH5055K1Z4',
        pan: 'AABCH5055K',
        email: 'billing@hitboxcollectibles.com',
        phone: '+91 80 4718 0100',
    },
    customer: {
        name: 'Arjun Singh',
        email: 'arjun.singh@example.in',
        addressLines: ['221B Indiranagar 12th Main', 'Bengaluru, Karnataka 560038', 'India'],
        gstin: null,
    },
    orderReference: 'ORD-2026-0009812',
    lines: indiaTotals.lines,
    subtotal: indiaTotals.subtotal,
    taxAmount: indiaTotals.taxAmount,
    totalAmount: indiaTotals.totalAmount,
    taxRate: indiaTotals.uniformTaxRate,
    paymentMethod: 'UPI (Razorpay)',
    notes: 'Supply of goods. Place of supply: Karnataka (29).',
};

// ── United States: sales tax @ 8.625% on a $25.00 collectible (§2.3) ────────
const usTotals = calculateInvoice([
    {
        description: 'Signed LeBron James Jersey — Lakers 2026 Drop, Edition 043/500',
        quantity: 1,
        unitPrice: '25.00',
        taxRate: '8.625',
    },
]);

const usInvoice: InvoiceDocumentModel = {
    invoiceNumber: formatInvoiceNumber({
        fiscalYear: fiscalYearOf('US', ISSUED_AT),
        countryCode: 'US',
        sequence: 1234,
    }),
    invoiceDate: ISSUED_AT,
    dueDate: dueDate(ISSUED_AT),
    countryCode: 'US',
    stateCode: 'CA',
    currency: 'USD',
    status: 'ISSUED',
    taxType: 'SALES_TAX',
    supplier: {
        legalName: 'HitBox Collectibles Inc.',
        addressLines: ['123 Collectible Lane', 'San Francisco, CA 94102', 'United States'],
        ein: '88-1234567',
        email: 'billing@hitboxcollectibles.com',
        phone: '+1 (415) 555-0100',
    },
    customer: {
        name: 'Michael Johnson',
        email: 'michael.j@example.com',
        addressLines: ['456 Sports Way', 'Los Angeles, CA 90001', 'United States'],
        gstin: null,
    },
    orderReference: 'ORD-2026-0009813',
    lines: usTotals.lines,
    subtotal: usTotals.subtotal,
    taxAmount: usTotals.taxAmount,
    totalAmount: usTotals.totalAmount,
    taxRate: usTotals.uniformTaxRate,
    paymentMethod: 'Visa •••• 4242 (Stripe)',
    notes: 'Sales tax collected for California (CDTFA).',
};

async function main(): Promise<void> {
    const upload = process.argv.includes('--upload');
    const renderer = new InvoicePdfRenderer();
    mkdirSync(OUT_DIR, { recursive: true });

    const storage =
        upload && process.env.MEDIA_S3_BUCKET
            ? new S3DocumentStorage({
                bucket: process.env.MEDIA_S3_BUCKET,
                region: process.env.MEDIA_S3_REGION ?? 'us-east-1',
                endpoint: process.env.MEDIA_S3_ENDPOINT,
                forcePathStyle: Boolean(process.env.MEDIA_S3_ENDPOINT),
            })
            : null;

    if (upload && !storage) {
        throw new Error('--upload needs MEDIA_S3_BUCKET in the environment.');
    }

    for (const invoice of [indiaInvoice, usInvoice]) {
        const pdf = await renderer.render(invoice);
        const key = invoiceDocumentKey({
            countryCode: invoice.countryCode,
            fiscalYear:
                invoice.countryCode === 'IN'
                    ? fiscalYearOf('IN', invoice.invoiceDate)
                    : fiscalYearOf('US', invoice.invoiceDate),
            invoiceNumber: invoice.invoiceNumber,
        });

        const localPath = resolve(OUT_DIR, `${invoice.invoiceNumber}.pdf`);
        writeFileSync(localPath, pdf);
        // eslint-disable-next-line no-console
        console.log(
            `${invoice.invoiceNumber}  ${invoice.currency} ${invoice.totalAmount}  ` +
            `${pdf.length} bytes  ->  ${localPath}`,
        );

        if (storage) {
            const stored = await storage.put({
                key,
                body: pdf,
                contentType: 'application/pdf',
                metadata: {
                    'invoice-number': invoice.invoiceNumber,
                    'country-code': invoice.countryCode,
                    'document-class': 'tax-invoice',
                },
            });
            // eslint-disable-next-line no-console
            console.log(`   uploaded s3://${process.env.MEDIA_S3_BUCKET}/${stored.key}`);
            // eslint-disable-next-line no-console
            console.log(`   sha256   ${stored.sha256}`);
            const link = await storage.presignDownload({ key, expiresInSeconds: 900 });
            // eslint-disable-next-line no-console
            console.log(`   presigned GET (15 min): ${link.url}`);
        }
    }
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});

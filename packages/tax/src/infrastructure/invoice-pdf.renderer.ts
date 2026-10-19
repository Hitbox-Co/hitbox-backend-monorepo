import { existsSync, readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { amountInWords } from '../domain/amount-in-words';
import { HITBOX_LOGO_PNG } from './hitbox-logo.asset';

/**
 * Renders the invoice PDF.
 *
 * This is a **projection** of the `Invoice` row, never a source of truth: every
 * figure on the page is passed in already computed and already snapshotted, and
 * re-rendering an invoice from the same row must produce the same document.
 * Nothing here reads the database, the clock, or configuration.
 *
 * Layout decisions worth knowing:
 *
 *   **A4, not Letter.** India is the jurisdiction with a statutory invoice
 *   format, and A4 is what gets printed and filed there. A US invoice on A4 is
 *   unremarkable; an Indian invoice on Letter looks wrong to the person filing
 *   it.
 *
 *   **Standard fonts only.** Helvetica/Helvetica-Bold ship inside PDFKit, so
 *   the document renders identically on any machine with no font installed and
 *   no font file to lose. The cost is WinAnsi's character set, which has no ₹ —
 *   see `formatMoney`.
 *
 *   **Everything mandatory is present or the render fails.** §1.4 of the
 *   compliance guide lists eight mandatory fields for an Indian GST invoice.
 *   `assertRenderable` checks them before a single byte is drawn, because a
 *   PDF that is missing a GSTIN is not a deficient invoice — it is not an
 *   invoice, and discovering that at filing time is much worse than at issue.
 */

const PAGE = { size: 'A4' as const, margin: 48 };
const INK = '#111114';
const MUTED = '#6E6E76';
const RULE = '#DCDCE2';
const ACCENT = '#DE3C2F';
const PANEL = '#F6F6F8';

export interface InvoiceDocumentLine {
    position: number;
    description: string;
    hsnCode?: string | null;
    sacCode?: string | null;
    quantity: number;
    unitPrice: string;
    lineSubtotal: string;
    taxRate: string;
    taxAmount: string;
    lineTotal: string;
}

export interface InvoiceDocumentModel {
    invoiceNumber: string;
    invoiceDate: Date;
    dueDate: Date | null;
    countryCode: string;
    stateCode: string | null;
    currency: string;
    /** ISSUED / VOID / CORRECTED — drives the watermark. */
    status: string;
    /** 'GST' | 'SALES_TAX' | 'EXEMPT'. Names the tax on the page. */
    taxType: string;

    supplier: {
        legalName: string;
        addressLines: string[];
        gstin?: string | null;
        pan?: string | null;
        ein?: string | null;
        email?: string | null;
        phone?: string | null;
    };

    customer: {
        name: string;
        email: string;
        addressLines: string[];
        gstin?: string | null;
    };

    orderReference: string;
    lines: InvoiceDocumentLine[];
    subtotal: string;
    taxAmount: string;
    totalAmount: string;
    /** Single rate when every line shares one. */
    taxRate: string | null;

    paymentMethod?: string | null;
    /** Free text printed under the totals — terms, return policy. */
    notes?: string | null;
    /** Only set on a CORRECTED / VOID invoice. */
    supersedesInvoiceNumber?: string | null;
    voidReason?: string | null;
}

export interface InvoicePdfRendererConfig {
    /**
     * A PNG on disk to print instead of the embedded mark — this is how a
     * deployment swaps in the real brand asset. A path that does not exist
     * falls back to the embedded logo rather than failing.
     */
    logoPath?: string | undefined;
    /** Printed in the footer. */
    supportEmail?: string | undefined;
}

export class InvoicePdfRenderer {
    private readonly logo: Buffer;
    private readonly supportEmail: string;

    constructor(config: InvoicePdfRendererConfig = {}) {
        // The embedded mark is the default and always present, so an invoice
        // never renders without a logo because a file moved. An override path
        // that does not exist falls back to it rather than failing: an invoice
        // with the wrong logo is a cosmetic problem, an invoice that could not
        // be issued is a compliance one.
        this.logo =
            config.logoPath && existsSync(config.logoPath)
                ? readFileSync(config.logoPath)
                : HITBOX_LOGO_PNG;
        this.supportEmail = config.supportEmail ?? 'support@hitboxcollectibles.com';
    }

    async render(model: InvoiceDocumentModel): Promise<Buffer> {
        assertRenderable(model);

        const doc = new PDFDocument({
            size: PAGE.size,
            margin: PAGE.margin,
            // Pages are buffered so the footer and the VOID watermark can be
            // stamped on every page after the content is laid out — neither
            // can be drawn on page 1 before we know how many pages there are.
            bufferPages: true,
            info: {
                Title: `Invoice ${model.invoiceNumber}`,
                Author: model.supplier.legalName,
                Subject: `${titleOf(model)} — ${model.orderReference}`,
                Keywords: [
                    model.invoiceNumber,
                    model.countryCode,
                    model.taxType,
                    'invoice',
                ].join(', '),
                CreationDate: model.invoiceDate,
            },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        const finished = new Promise<Buffer>((resolveBuffer, reject) => {
            doc.on('end', () => resolveBuffer(Buffer.concat(chunks)));
            doc.on('error', reject);
        });

        this.drawHeader(doc, model);
        this.drawParties(doc, model);
        this.drawMetaStrip(doc, model);
        this.drawLineItems(doc, model);
        this.drawTotals(doc, model);
        this.drawPaymentAndTerms(doc, model);
        this.drawSignature(doc, model);
        if (model.status !== 'ISSUED') this.drawStatusWatermark(doc, model);
        this.drawFooters(doc, model);

        doc.end();
        return finished;
    }

    // ── Sections ────────────────────────────────────────────────────────────

    private drawHeader(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        const top = doc.y;

        // The brand mark is square (an isometric cube), not a horizontal
        // lockup, so the wordmark is set beside it rather than being part of
        // the image. An invoice should name its supplier prominently — the
        // legal name in the FROM block is the statutory field, but the reader
        // identifies the document by the lockup at the top.
        //
        // Always drawn: the default is embedded in the module, so there is no
        // "no logo" branch to get wrong.
        doc.image(this.logo, left, top, { height: 44 });
        doc.fillColor(INK)
            .font('Helvetica-Bold')
            .fontSize(16)
            .text('HITBOX', left + 56, top + 8, { lineBreak: false });
        doc.fillColor(MUTED)
            .font('Helvetica-Bold')
            .fontSize(7)
            .text('COLLECTIBLES', left + 57, top + 28, {
                characterSpacing: 1.4,
                lineBreak: false,
            });

        // Document title, right-aligned against the logo.
        doc.fillColor(INK)
            .font('Helvetica-Bold')
            .fontSize(20)
            .text(titleOf(model), left, top + 4, { width: right - left, align: 'right' });
        doc.fillColor(MUTED)
            .font('Helvetica')
            .fontSize(9)
            .text(
                model.countryCode === 'IN'
                    ? 'Issued under the Central Goods and Services Tax Act, 2017'
                    : 'Retail sale — state sales tax',
                left,
                doc.y + 2,
                { width: right - left, align: 'right' },
            );

        doc.y = top + 62;
        rule(doc, ACCENT, 2);
        doc.moveDown(0.8);
    }

    private drawParties(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        const columnWidth = (right - left - 24) / 2;
        const top = doc.y;

        // FROM
        label(doc, 'FROM', left);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
        doc.text(model.supplier.legalName, left, doc.y + 2, { width: columnWidth });
        doc.font('Helvetica').fontSize(9).fillColor(MUTED);
        for (const line of model.supplier.addressLines) {
            doc.text(line, { width: columnWidth });
        }
        const supplierIds: string[] = [];
        if (model.supplier.gstin) supplierIds.push(`GSTIN: ${model.supplier.gstin}`);
        if (model.supplier.pan) supplierIds.push(`PAN: ${model.supplier.pan}`);
        if (model.supplier.ein) supplierIds.push(`EIN: ${model.supplier.ein}`);
        if (model.supplier.email) supplierIds.push(model.supplier.email);
        if (model.supplier.phone) supplierIds.push(model.supplier.phone);
        if (supplierIds.length > 0) {
            doc.moveDown(0.3).fillColor(INK);
            for (const line of supplierIds) doc.text(line, { width: columnWidth });
        }
        const fromBottom = doc.y;

        // BILL TO
        const rightColumn = left + columnWidth + 24;
        doc.y = top;
        label(doc, 'BILL TO', rightColumn);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
        doc.text(model.customer.name, rightColumn, doc.y + 2, { width: columnWidth });
        doc.font('Helvetica').fontSize(9).fillColor(MUTED);
        doc.text(model.customer.email, rightColumn, doc.y, { width: columnWidth });
        for (const line of model.customer.addressLines) {
            doc.text(line, rightColumn, doc.y, { width: columnWidth });
        }
        doc.fillColor(INK).text(
            // Printed even when absent: "not applicable" is the B2C answer and
            // a blank line reads like a field someone forgot to fill in.
            model.countryCode === 'IN'
                ? `GSTIN: ${model.customer.gstin ?? 'Not applicable (B2C)'}`
                : model.customer.gstin
                    ? `Tax ID: ${model.customer.gstin}`
                    : '',
            rightColumn,
            doc.y + 4,
            { width: columnWidth },
        );

        doc.y = Math.max(fromBottom, doc.y) + 14;
    }

    private drawMetaStrip(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        // Weighted rather than equal columns: an invoice number is three times
        // the width of a currency code, and equal columns make the long values
        // wrap while the short ones sit in white space.
        const cells: { caption: string; value: string; weight: number }[] = [
            { caption: 'Invoice number', value: model.invoiceNumber, weight: 1.5 },
            { caption: 'Invoice date', value: formatDate(model.invoiceDate), weight: 1 },
            {
                caption: 'Due date',
                value: model.dueDate ? formatDate(model.dueDate) : 'Paid in full',
                weight: 1,
            },
            { caption: 'Order ref.', value: model.orderReference, weight: 1.25 },
            {
                caption: model.countryCode === 'IN' ? 'Place of supply' : 'Tax jurisdiction',
                value: [model.stateCode, model.countryCode].filter(Boolean).join(', '),
                weight: 1.1,
            },
            { caption: 'Currency', value: model.currency, weight: 0.9 },
        ];

        const height = 44;
        const width = right - left;
        doc.save().roundedRect(left, doc.y, width, height, 4).fill(PANEL).restore();

        const totalWeight = cells.reduce((sum, cell) => sum + cell.weight, 0);
        const top = doc.y + 10;
        let x = left + 10;
        for (const cell of cells) {
            const cellWidth = (width - 20) * (cell.weight / totalWeight);
            doc.fillColor(MUTED).font('Helvetica').fontSize(6);
            doc.text(cell.caption.toUpperCase(), x, top, {
                width: cellWidth - 8,
                characterSpacing: 0.5,
                lineBreak: false,
            });
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
            doc.text(cell.value, x, top + 11, {
                width: cellWidth - 8,
                lineBreak: false,
                ellipsis: true,
            });
            x += cellWidth;
        }

        doc.x = left;
        doc.y = top + height - 2;
        doc.moveDown(1);
    }

    private drawLineItems(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        const india = model.countryCode === 'IN';
        const width = right - left;

        // The HSN/SAC column only exists for India — it is mandatory there and
        // meaningless in the US, and an empty column reads as missing data.
        const columns = india
            ? ([
                { key: 'position', title: '#', width: 20, align: 'left' },
                { key: 'description', title: 'Description', width: width - 352, align: 'left' },
                { key: 'hsn', title: 'HSN/SAC', width: 56, align: 'left' },
                { key: 'quantity', title: 'Qty', width: 36, align: 'right' },
                { key: 'unitPrice', title: 'Unit price', width: 64, align: 'right' },
                { key: 'taxable', title: 'Taxable', width: 62, align: 'right' },
                { key: 'taxRate', title: 'GST %', width: 48, align: 'right' },
                { key: 'tax', title: 'GST', width: 66, align: 'right' },
            ] as const)
            : ([
                { key: 'position', title: '#', width: 20, align: 'left' },
                { key: 'description', title: 'Description', width: width - 294, align: 'left' },
                { key: 'quantity', title: 'Qty', width: 32, align: 'right' },
                { key: 'unitPrice', title: 'Unit price', width: 68, align: 'right' },
                { key: 'taxable', title: 'Amount', width: 66, align: 'right' },
                { key: 'taxRate', title: 'Tax %', width: 52, align: 'right' },
                { key: 'tax', title: 'Tax', width: 56, align: 'right' },
            ] as const);

        // Header row
        const headerTop = doc.y;
        doc.save().rect(left, headerTop, width, 20).fill(INK).restore();
        let x = left;
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5);
        for (const column of columns) {
            doc.text(column.title.toUpperCase(), x + 6, headerTop + 6.5, {
                width: column.width - 12,
                align: column.align,
                lineBreak: false,
                characterSpacing: 0.4,
            });
            x += column.width;
        }
        doc.y = headerTop + 20;

        // Body
        for (const line of model.lines) {
            const values: Record<string, string> = {
                position: String(line.position),
                description: line.description,
                hsn: line.hsnCode ?? line.sacCode ?? '—',
                quantity: String(line.quantity),
                unitPrice: formatMoney(line.unitPrice, model.currency, false),
                taxable: formatMoney(line.lineSubtotal, model.currency, false),
                taxRate: `${trimRate(line.taxRate)}%`,
                tax: formatMoney(line.taxAmount, model.currency, false),
            };

            // Measure the description so a long product name wraps without the
            // numeric columns drifting out of alignment.
            const descriptionColumn = columns.find((column) => column.key === 'description');
            const descriptionHeight = doc
                .font('Helvetica')
                .fontSize(9)
                .heightOfString(values.description as string, {
                    width: (descriptionColumn?.width ?? 200) - 12,
                });
            const rowHeight = Math.max(descriptionHeight + 12, 24);
            const rowTop = doc.y;

            x = left;
            for (const column of columns) {
                doc.fillColor(INK)
                    .font(column.key === 'description' ? 'Helvetica' : 'Helvetica')
                    .fontSize(9)
                    .text(values[column.key] ?? '', x + 6, rowTop + 6, {
                        width: column.width - 12,
                        align: column.align,
                        ...(column.key === 'description' ? {} : { lineBreak: false }),
                    });
                x += column.width;
            }

            doc.y = rowTop + rowHeight;
            rule(doc, RULE, 0.5);
        }

        doc.moveDown(0.6);
    }

    private drawTotals(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        const boxWidth = 250;
        const boxLeft = right - boxWidth;
        const top = doc.y;

        const taxLabel =
            model.taxType === 'GST'
                ? `GST${model.taxRate ? ` @ ${trimRate(model.taxRate)}%` : ''}`
                : model.taxType === 'SALES_TAX'
                    ? `Sales tax${model.taxRate ? ` @ ${trimRate(model.taxRate)}%` : ''}`
                    : 'Tax (exempt)';

        const rows: [string, string, boolean][] = [
            ['Taxable value', formatMoney(model.subtotal, model.currency), false],
            [taxLabel, formatMoney(model.taxAmount, model.currency), false],
            ['Total payable', formatMoney(model.totalAmount, model.currency), true],
        ];

        let y = top;
        for (const [caption, value, emphasised] of rows) {
            if (emphasised) {
                doc.save().roundedRect(boxLeft, y - 2, boxWidth, 26, 4).fill(INK).restore();
            }
            doc.fillColor(emphasised ? '#FFFFFF' : MUTED)
                .font(emphasised ? 'Helvetica-Bold' : 'Helvetica')
                .fontSize(emphasised ? 10 : 9)
                .text(caption, boxLeft + 10, y + (emphasised ? 5 : 2), { width: boxWidth / 2, lineBreak: false });
            doc.fillColor(emphasised ? '#FFFFFF' : INK)
                .font('Helvetica-Bold')
                .fontSize(emphasised ? 11 : 9)
                .text(value, boxLeft + boxWidth / 2 - 10, y + (emphasised ? 4 : 2), {
                    width: boxWidth / 2,
                    align: 'right',
                    lineBreak: false,
                });
            y += emphasised ? 30 : 16;
        }

        // Amount in words, left of the totals. Conventional on an Indian
        // invoice and a genuine control: it makes a transposed digit in the
        // numeric total visible to a human reader.
        doc.fillColor(MUTED).font('Helvetica').fontSize(7).text('AMOUNT IN WORDS', left, top, {
            width: boxLeft - left - 20,
            characterSpacing: 0.6,
        });
        doc.fillColor(INK)
            .font('Helvetica-Bold')
            .fontSize(9)
            .text(amountInWords(model.totalAmount, model.currency), left, doc.y + 2, {
                width: boxLeft - left - 20,
            });

        doc.y = Math.max(y, doc.y) + 12;
    }

    private drawPaymentAndTerms(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        rule(doc, RULE, 0.5);
        doc.moveDown(0.6);

        const columnWidth = (right - left - 24) / 2;
        const top = doc.y;

        label(doc, 'PAYMENT', left);
        doc.fillColor(INK).font('Helvetica').fontSize(9);
        doc.text(
            model.paymentMethod
                ? `Settled via ${model.paymentMethod}.`
                : 'Settled through the HitBox checkout.',
            left,
            doc.y + 2,
            { width: columnWidth },
        );
        doc.fillColor(MUTED).text(
            model.dueDate
                ? `Payment due ${formatDate(model.dueDate)}.`
                : 'No balance outstanding — this document is a receipt.',
            { width: columnWidth },
        );
        const paymentBottom = doc.y;

        const rightColumn = left + columnWidth + 24;
        doc.y = top;
        label(doc, 'NOTES & TERMS', rightColumn);
        doc.fillColor(MUTED).font('Helvetica').fontSize(8);
        const terms = [
            model.notes,
            model.supersedesInvoiceNumber
                ? `Supersedes invoice ${model.supersedesInvoiceNumber}.`
                : null,
            model.voidReason ? `Voided: ${model.voidReason}` : null,
            'Collectibles are certified authentic and carry an NFC provenance tag.',
            'Returns accepted within 30 days of delivery, tag intact.',
        ].filter((line): line is string => Boolean(line));
        for (const line of terms) {
            doc.text(`• ${line}`, rightColumn, doc.y + 1, { width: columnWidth });
        }

        doc.y = Math.max(paymentBottom, doc.y) + 16;
    }

    private drawSignature(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const { left, right } = bounds(doc);
        const boxWidth = 210;
        const boxLeft = right - boxWidth;
        const top = doc.y;

        doc.save()
            .roundedRect(boxLeft, top, boxWidth, 62, 4)
            .lineWidth(0.5)
            .strokeColor(RULE)
            .stroke()
            .restore();

        doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(
            `For ${model.supplier.legalName}`,
            boxLeft + 10,
            top + 8,
            { width: boxWidth - 20 },
        );
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(
            'Authorised signatory',
            boxLeft + 10,
            top + 40,
            { width: boxWidth - 20 },
        );
        doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text(
            'Digitally issued — no physical signature required',
            boxLeft + 10,
            top + 51,
            { width: boxWidth - 20 },
        );

        doc.y = top + 70;
        doc.x = left;
    }

    /**
     * Diagonal VOID / CORRECTED stamp.
     *
     * Drawn over the content rather than behind it, and deliberately loud: a
     * cancelled invoice that still reads like a valid one is how the wrong
     * number ends up on a return. Only ISSUED invoices are unstamped.
     */
    private drawStatusWatermark(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const pages = doc.bufferedPageRange();
        for (let index = pages.start; index < pages.start + pages.count; index += 1) {
            doc.switchToPage(index);
            doc.save();
            doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
            doc.fillColor(ACCENT)
                .opacity(0.16)
                .font('Helvetica-Bold')
                .fontSize(92)
                .text(model.status, 0, doc.page.height / 2 - 50, {
                    width: doc.page.width,
                    align: 'center',
                });
            doc.restore();
        }
    }

    private drawFooters(doc: PDFKit.PDFDocument, model: InvoiceDocumentModel): void {
        const pages = doc.bufferedPageRange();
        for (let index = pages.start; index < pages.start + pages.count; index += 1) {
            doc.switchToPage(index);
            // The footer sits BELOW the bottom margin, and PDFKit adds a page
            // whenever text crosses that line. Dropping the margin for the two
            // footer writes is what stops every invoice growing a trail of
            // blank pages behind it.
            const bottomMargin = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            const y = doc.page.height - PAGE.margin + 6;
            doc.fillColor(MUTED).font('Helvetica').fontSize(7);
            doc.text(
                `${model.invoiceNumber}  ·  This is a computer-generated invoice and is valid without a signature.  ·  ${this.supportEmail}`,
                PAGE.margin,
                y,
                { width: doc.page.width - PAGE.margin * 2, align: 'left', lineBreak: false },
            );
            doc.text(
                `Page ${index - pages.start + 1} of ${pages.count}`,
                PAGE.margin,
                y,
                { width: doc.page.width - PAGE.margin * 2, align: 'right', lineBreak: false },
            );
            doc.page.margins.bottom = bottomMargin;
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bounds(doc: PDFKit.PDFDocument): { left: number; right: number } {
    return { left: PAGE.margin, right: doc.page.width - PAGE.margin };
}

function rule(doc: PDFKit.PDFDocument, color: string, width: number): void {
    const { left, right } = bounds(doc);
    doc.save()
        .moveTo(left, doc.y)
        .lineTo(right, doc.y)
        .lineWidth(width)
        .strokeColor(color)
        .stroke()
        .restore();
}

/**
 * A small caps-ish section caption. Advances `doc.y` past itself — drawn with
 * `lineBreak: false` so a long caption never wraps, which means PDFKit does not
 * move the cursor and the next block would otherwise be written on top of it.
 */
function label(doc: PDFKit.PDFDocument, text: string, x: number): void {
    const top = doc.y;
    doc.fillColor(MUTED)
        .font('Helvetica')
        .fontSize(7)
        .text(text, x, top, { characterSpacing: 0.8, lineBreak: false });
    doc.x = x;
    doc.y = top + 11;
}

function titleOf(model: InvoiceDocumentModel): string {
    // "TAX INVOICE" is the statutory heading under Indian GST rules — an
    // invoice headed anything else is a commercial document, not a tax one.
    return model.countryCode === 'IN' ? 'TAX INVOICE' : 'INVOICE';
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** `12.00` -> `12`, `8.625` -> `8.625`. Trailing zeros only. */
function trimRate(value: string): string {
    return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/**
 * `2000.00` -> `INR 2,000.00`.
 *
 * The ISO code rather than a symbol, deliberately. PDFKit's built-in fonts are
 * WinAnsi-encoded and have no ₹ (U+20B9) — printing one would produce a wrong
 * glyph or a blank on a statutory document. Embedding a Unicode font to gain
 * one character would mean shipping a font file that the render depends on and
 * that can go missing. `INR 2,000.00` is unambiguous, is what a bank statement
 * and a GST return both use, and cannot render incorrectly.
 */
function formatMoney(value: string, currency: string, withCode = true): string {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = '00'] = (negative ? value.slice(1) : value).split('.');
    const grouped = groupDigits(whole, currency);
    const amount = `${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
    return withCode ? `${currency} ${amount}` : amount;
}

/**
 * Digit grouping, which is not the same in the two jurisdictions.
 *
 * India uses the lakh/crore system — 12,34,567 — and an Indian invoice that
 * groups in thousands looks foreign to the person reading it. Everywhere else
 * groups in threes.
 */
function groupDigits(whole: string, currency: string): string {
    if (currency !== 'INR') return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (whole.length <= 3) return whole;
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * The mandatory-field check from §1.4 of the compliance guide, enforced before
 * anything is drawn.
 *
 * India only. The US has no federal invoice law, so its invoices are checked
 * for the things that make a document usable (a number, a date, a line) and
 * nothing more.
 */
function assertRenderable(model: InvoiceDocumentModel): void {
    const missing: string[] = [];

    if (!model.invoiceNumber) missing.push('invoice number');
    if (!model.invoiceDate) missing.push('invoice date');
    if (model.lines.length === 0) missing.push('at least one line item');
    if (!model.supplier.legalName) missing.push('supplier name');
    if (!model.customer.name) missing.push('customer name');

    if (model.countryCode === 'IN') {
        if (!model.supplier.gstin) missing.push("supplier's GSTIN");
        if (!model.supplier.addressLines.length) missing.push('supplier address');
        const withoutCode = model.lines.filter((line) => !line.hsnCode && !line.sacCode);
        if (withoutCode.length > 0) {
            missing.push(
                `HSN/SAC code on line${withoutCode.length > 1 ? 's' : ''} ` +
                withoutCode.map((line) => line.position).join(', '),
            );
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `Cannot render invoice ${model.invoiceNumber || '(unnumbered)'}: ` +
            `missing ${missing.join('; ')}. ` +
            `These fields are mandatory for a ${model.countryCode} tax invoice.`,
        );
    }
}

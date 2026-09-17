import { z } from 'zod';
import { TAX_DEFAULT_LIMIT, TAX_MAX_LIMIT } from '../constants/tax.constant';

/**
 * Input validation and response shapes.
 *
 * Every monetary value and every rate crosses the wire as a **string**, in and
 * out — same rule the finance module states, and it matters more here: a tax
 * figure that arrives as a JSON float and is summed client-side produces a
 * number that will not reconcile against a return.
 */

const money = z
    .string()
    .regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Must be an amount with at most 2 decimal places.');

/** Three decimals — US local rates carry them (8.625%). See money.ts. */
const percentage = z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Must be a percentage, e.g. "12" or "8.625".')
    .refine((value) => Number(value) <= 100, 'Must not exceed 100.');

const uuid = z.string().uuid();
const countryCode = z.string().length(2).regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, uppercase.');
const stateCode = z.string().length(2).regex(/^[A-Z]{2}$/, 'Two-letter state code, uppercase.');

/** HSN/SAC: digits only, 4–8 of them. Anything else fails GSTR-1 matching. */
const classificationCode = z
    .string()
    .regex(/^\d{4,8}$/, 'Must be a 4–8 digit HSN or SAC code.');

const pagination = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(TAX_MAX_LIMIT).default(TAX_DEFAULT_LIMIT),
};

// ── Tax configuration ───────────────────────────────────────────────────────

export const createTaxConfigurationSchema = z
    .object({
        /** Omit for the jurisdiction's default row. */
        productId: uuid.optional(),
        countryCode,
        stateCode: stateCode.optional(),
        taxType: z.enum(['GST', 'SALES_TAX', 'EXEMPT']),
        taxRate: percentage,
        hsnCode: classificationCode.optional(),
        sacCode: classificationCode.optional(),
        exemptionReason: z.string().min(1).max(200).optional(),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().optional(),
    })
    .refine(
        (value) => value.countryCode !== 'IN' || Boolean(value.hsnCode ?? value.sacCode),
        {
            message:
                'An Indian rate needs an HSN or SAC code — GST invoices must carry one and ' +
                'the department matches it against GSTR-1.',
            path: ['hsnCode'],
        },
    )
    .refine(
        (value) => value.taxType !== 'EXEMPT' || Boolean(value.exemptionReason),
        { message: 'An exempt rate must say why.', path: ['exemptionReason'] },
    )
    .refine(
        (value) => !value.effectiveTo || value.effectiveTo > value.effectiveFrom,
        { message: 'effectiveTo must be after effectiveFrom.', path: ['effectiveTo'] },
    );
export type CreateTaxConfigurationDto = z.infer<typeof createTaxConfigurationSchema>;

/** Rates are versioned, not edited — closing one is the only mutation. */
export const closeTaxConfigurationSchema = z.object({
    effectiveTo: z.coerce.date(),
    reason: z.string().min(1).max(500),
});
export type CloseTaxConfigurationDto = z.infer<typeof closeTaxConfigurationSchema>;

export const listTaxConfigurationsQuerySchema = z.object({
    ...pagination,
    countryCode: countryCode.optional(),
    stateCode: stateCode.optional(),
    productId: uuid.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    activeAt: z.coerce.date().optional(),
});
export type ListTaxConfigurationsQuery = z.infer<typeof listTaxConfigurationsQuerySchema>;

// ── Invoices ────────────────────────────────────────────────────────────────

/**
 * Issue an invoice for an order.
 *
 * Only an order id: everything else — the price, the buyer, the address, the
 * rate — is resolved server-side from the order and the tax configuration. A
 * client that could supply an amount could supply the wrong one, and the
 * resulting document would still be a statutory record.
 */
export const issueInvoiceSchema = z.object({
    orderId: uuid,
    /** Defaults to now. Backdating is allowed for a migration, not routinely. */
    invoiceDate: z.coerce.date().optional(),
    notes: z.string().max(1000).optional(),
});
export type IssueInvoiceDto = z.infer<typeof issueInvoiceSchema>;

export const listInvoicesQuerySchema = z.object({
    ...pagination,
    countryCode: countryCode.optional(),
    stateCode: stateCode.optional(),
    status: z.enum(['ISSUED', 'VOID', 'CORRECTED']).optional(),
    fiscalYear: z.string().max(10).optional(),
    buyerId: uuid.optional(),
    organizationId: uuid.optional(),
    /** Half-open: `issuedFrom <= invoiceDate < issuedTo`. */
    issuedFrom: z.coerce.date().optional(),
    issuedTo: z.coerce.date().optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const voidInvoiceSchema = z.object({
    reason: z.string().min(1).max(500),
});
export type VoidInvoiceDto = z.infer<typeof voidInvoiceSchema>;

// ── Tax adjustments ─────────────────────────────────────────────────────────

export const createTaxAdjustmentSchema = z.object({
    invoiceId: uuid,
    adjustmentType: z.enum(['TAX_CORRECTION', 'REFUND', 'EXEMPTION_GRANTED']),
    reason: z.string().min(1).max(1000),
    adjustedTaxAmount: money,
});
export type CreateTaxAdjustmentDto = z.infer<typeof createTaxAdjustmentSchema>;

export const decideTaxAdjustmentSchema = z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().min(1).max(500),
});
export type DecideTaxAdjustmentDto = z.infer<typeof decideTaxAdjustmentSchema>;

export const listTaxAdjustmentsQuerySchema = z.object({
    ...pagination,
    invoiceId: uuid.optional(),
    status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED']).optional(),
});
export type ListTaxAdjustmentsQuery = z.infer<typeof listTaxAdjustmentsQuerySchema>;

// ── Artist tax documents ────────────────────────────────────────────────────

export const documentTypeSchema = z.enum([
    'W9',
    'PAN',
    'GST_REGISTRATION',
    'STATE_TAX_ID',
    'FORM_1099_NEC_ISSUED',
    'FORM_16A_ISSUED',
]);

/**
 * Registers a tax document the artist has uploaded.
 *
 * `storageRef` rather than the file itself: the bytes go to S3 through the
 * media module's presigned upload, and this records the result. Keeping the
 * file off this endpoint means a 30 MB scan of a W-9 never travels through the
 * JSON body of an API that also writes a database row.
 */
export const registerArtistTaxDocumentSchema = z
    .object({
        artistId: uuid,
        countryCode,
        documentType: documentTypeSchema,
        storageRef: z.string().min(1).max(500),
        documentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        /** PAN or GSTIN. Never an SSN — see the schema comment. */
        documentNumber: z.string().min(1).max(50).optional(),
        issuerName: z.string().min(1).max(200).optional(),
        issueDate: z.coerce.date().optional(),
        expiresAt: z.coerce.date().optional(),
        notes: z.string().max(1000).optional(),
    })
    .refine(
        (value) =>
            value.documentType !== 'PAN' ||
            /^[A-Z]{5}\d{4}[A-Z]$/.test(value.documentNumber ?? ''),
        { message: 'A PAN is five letters, four digits, one letter.', path: ['documentNumber'] },
    )
    .refine(
        (value) =>
            value.documentType !== 'GST_REGISTRATION' ||
            /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(value.documentNumber ?? ''),
        {
            message: 'A GSTIN is 15 characters: state code, PAN, entity code, Z, checksum.',
            path: ['documentNumber'],
        },
    );
export type RegisterArtistTaxDocumentDto = z.infer<typeof registerArtistTaxDocumentSchema>;

export const reviewArtistTaxDocumentSchema = z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().min(1).max(500),
});
export type ReviewArtistTaxDocumentDto = z.infer<typeof reviewArtistTaxDocumentSchema>;

export const listArtistTaxDocumentsQuerySchema = z.object({
    ...pagination,
    artistId: uuid.optional(),
    countryCode: countryCode.optional(),
    documentType: documentTypeSchema.optional(),
    status: z
        .enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'ARCHIVED'])
        .optional(),
    /** Documents lapsing within N days — the expiry sweep's query. */
    expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type ListArtistTaxDocumentsQuery = z.infer<typeof listArtistTaxDocumentsQuerySchema>;

// ── Tax return filings ──────────────────────────────────────────────────────

export const filingTypeSchema = z.enum([
    'GSTR_1',
    'GSTR_3B',
    'FORM_16A',
    'FORM_1099_NEC',
    'STATE_SALES_TAX',
]);

export const createTaxFilingSchema = z
    .object({
        filingType: filingTypeSchema,
        countryCode,
        stateCode: stateCode.optional(),
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
        /** Information returns only. */
        artistId: uuid.optional(),
        payoutId: uuid.optional(),
        notes: z.string().max(1000).optional(),
    })
    .refine((value) => value.periodEnd > value.periodStart, {
        message: 'periodEnd must be after periodStart.',
        path: ['periodEnd'],
    })
    .refine(
        (value) =>
            !['FORM_16A', 'FORM_1099_NEC'].includes(value.filingType) ||
            (Boolean(value.artistId) && Boolean(value.payoutId)),
        {
            message:
                'Form 16A and 1099-NEC report *paid* royalty income, so both need the artist ' +
                'and the approved payout they are filed against.',
            path: ['payoutId'],
        },
    )
    .refine(
        (value) => value.filingType !== 'STATE_SALES_TAX' || Boolean(value.stateCode),
        { message: 'A state sales-tax return needs its state.', path: ['stateCode'] },
    );
export type CreateTaxFilingDto = z.infer<typeof createTaxFilingSchema>;

export const markTaxFilingFiledSchema = z.object({
    referenceNumber: z.string().min(1).max(100),
    filedAt: z.coerce.date().optional(),
    notes: z.string().max(1000).optional(),
});
export type MarkTaxFilingFiledDto = z.infer<typeof markTaxFilingFiledSchema>;

export const listTaxFilingsQuerySchema = z.object({
    ...pagination,
    filingType: filingTypeSchema.optional(),
    countryCode: countryCode.optional(),
    stateCode: stateCode.optional(),
    status: z.enum(['PENDING', 'READY', 'FILED', 'ACCEPTED', 'REJECTED']).optional(),
    artistId: uuid.optional(),
    /** Filings whose period starts on or after this instant. */
    periodFrom: z.coerce.date().optional(),
    periodTo: z.coerce.date().optional(),
});
export type ListTaxFilingsQuery = z.infer<typeof listTaxFilingsQuerySchema>;

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * The dataset behind a return. `periodStart`/`periodEnd` are half-open.
 *
 * Not paginated: a GSTR-1 summary is an aggregate over a month, and returning
 * page 2 of a tax return would be a way to file half of one.
 */
export const taxSummaryQuerySchema = z
    .object({
        countryCode,
        stateCode: stateCode.optional(),
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
    })
    .refine((value) => value.periodEnd > value.periodStart, {
        message: 'periodEnd must be after periodStart.',
        path: ['periodEnd'],
    });
export type TaxSummaryQuery = z.infer<typeof taxSummaryQuerySchema>;

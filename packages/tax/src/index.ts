// Module factory — the only thing bootstrap needs.
export { createTaxModule } from './module';
export type {
    OrderSettledEventPayload,
    TaxModule,
    TaxModuleDeps,
    TaxPermissionGuard,
} from './module';

// Access resolution. Bootstrap builds both from the guard's principal.
export { buildBuyerTaxAccess, buildTaxAccess, TaxScope } from './domain/tax-access';
export type { TaxAccess, TaxPrincipal } from './domain/tax-access';

// Ports the composition root connects.
export type {
    IInvoiceableOrderSource,
    InvoiceableOrder,
} from './domain/interfaces/invoiceable-order.port';
export type {
    IArtistOwnership,
    IPayoutLookup,
    ReportablePayout,
} from './domain/interfaces/payout-lookup.port';
export type {
    IDocumentStorage,
    PresignedDownload,
    StoredDocument,
} from './domain/interfaces/document-storage.port';
export { NOOP_TAX_AUDIT, recordTaxAudit } from './domain/interfaces/audit-recorder.port';
export type {
    ITaxAuditRecorder,
    TaxAuditEvent,
    TaxAuditRecordInput,
} from './domain/interfaces/audit-recorder.port';

// Storage adapter + key convention.
export { S3DocumentStorage } from './infrastructure/s3-document-storage';
export type { S3DocumentStorageConfig } from './infrastructure/s3-document-storage';
export {
    artistTaxDocumentKey,
    filingDocumentKey,
    invoiceDocumentKey,
    isTaxKey,
    TAX_ARTIST_DOCUMENT_PREFIX,
    TAX_FILING_PREFIX,
    TAX_INVOICE_PREFIX,
    TAX_PREFIXES,
} from './domain/document-storage-key';

// Supplier identity.
export {
    formatSupplierAddress,
    supplierIsIssuable,
    supplierProfilesFromEnv,
} from './domain/supplier-profile';
export type { SupplierProfile } from './domain/supplier-profile';

// The renderer, exported for the demo script and for anything that needs to
// produce an invoice document outside the service (a migration, a re-issue).
export { InvoicePdfRenderer } from './infrastructure/invoice-pdf.renderer';
export type {
    InvoiceDocumentLine,
    InvoiceDocumentModel,
    InvoicePdfRendererConfig,
} from './infrastructure/invoice-pdf.renderer';

// Pure domain helpers, exported because tests and scripts drive them directly.
export { calculateInvoice, resolveTaxConfiguration } from './domain/tax-calculation';
export type { InvoiceTotals, TaxLine, TaxLineInput } from './domain/tax-calculation';
export { formatInvoiceNumber, parseInvoiceNumber, toGstFilingFormat } from './domain/invoice-number';
export { filingDueDate, fiscalYearOf, fiscalYearPeriod, monthOf, quarterOf } from './domain/fiscal-calendar';
export { amountInWords } from './domain/amount-in-words';
export {
    addMoney,
    compareMoney,
    money,
    multiplyMoney,
    rate,
    subtractMoney,
    sumMoney,
    taxOn,
} from './domain/money';

export * from './constants/tax.constant';

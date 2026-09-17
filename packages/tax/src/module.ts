import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import {
    TAX_EXPORT_CAPABILITY,
    TAX_MANAGE_CAPABILITY,
    TAX_MODULE,
    TAX_ORDER_READ_CAPABILITY,
    TAX_OVERRIDE_CAPABILITY,
    TAX_READ_CAPABILITY,
} from './constants/tax.constant';
import { TaxController } from './controller/tax.controller';
import type { TaxAccessResolver } from './controller/tax.controller';
import type { IDocumentStorage } from './domain/interfaces/document-storage.port';
import type { IInvoiceableOrderSource } from './domain/interfaces/invoiceable-order.port';
import type { IArtistOwnership, IPayoutLookup } from './domain/interfaces/payout-lookup.port';
import type { ITaxAuditRecorder } from './domain/interfaces/audit-recorder.port';
import { NOOP_TAX_AUDIT } from './domain/interfaces/audit-recorder.port';
import type { SupplierProfile } from './domain/supplier-profile';
import { InvoicePdfRenderer } from './infrastructure/invoice-pdf.renderer';
import { ArtistTaxDocumentRepository } from './repository/artist-tax-document.repository';
import { InvoiceRepository } from './repository/invoice.repository';
import { TaxAdjustmentRepository } from './repository/tax-adjustment.repository';
import { TaxConfigurationRepository } from './repository/tax-configuration.repository';
import { TaxFilingRepository } from './repository/tax-filing.repository';
import { ArtistTaxDocumentService } from './service/artist-tax-document.service';
import { InvoiceService } from './service/invoice.service';
import { TaxAdjustmentService } from './service/tax-adjustment.service';
import { TaxConfigurationService } from './service/tax-configuration.service';
import { TaxFilingService } from './service/tax-filing.service';

/** Structural guard — the shape of `requirePermission`, not an import. */
export interface TaxPermissionGuard {
    requirePermission(
        capability: string,
        options?: { context?: (req: Request) => unknown; globalOnly?: boolean },
    ): RequestHandler;
}

/** The settlement event this module invoices on. Matches @hitbox/payments. */
export interface OrderSettledEventPayload {
    orderId: string;
}

export interface TaxModuleDeps {
    prisma: PrismaClient;
    eventBus: IEventBus;
    guard: TaxPermissionGuard;
    /** Operator/artist view, from `buildTaxAccess`. */
    resolveAccess: TaxAccessResolver;
    /** Buyer view, from `buildBuyerTaxAccess`. */
    resolveBuyerAccess: TaxAccessResolver;
    /** Orders answers "what was sold, to whom, where" — see the port. */
    orders: IInvoiceableOrderSource;
    /** Finance answers "was this payout actually paid" — see the port. */
    payouts: IPayoutLookup;
    /** Artist answers "which artist records does this user act for". */
    artists: IArtistOwnership;
    /**
     * Where invoice PDFs and tax documents are stored. Null on a deploy with
     * no bucket: invoices are still ISSUED and every figure is still recorded,
     * but the document routes return a clear 503-shaped error rather than a
     * confusing 404. An invoice is a database row first and a PDF second.
     */
    storage: IDocumentStorage | null;
    /** HitBox's own identity per jurisdiction, keyed by ISO country code. */
    suppliers: Map<string, SupplierProfile>;
    /** Defaults to a no-op so unit tests need no audit wiring. */
    audit?: ITaxAuditRecorder;
    /**
     * The event to invoice on. Defaults to the payments module's
     * `payments.order.settled`; injectable so a test can drive the subscriber
     * without importing the payments package.
     */
    settlementEventName?: string;
    /** Overrides the bundled logo — point it at the brand asset. */
    logoPath?: string | undefined;
}

export interface TaxModule {
    /**
     * Whether an artist may be paid without backup withholding. Consumed by
     * finance before a US payout executes — the W-9 rule from §2.2 of the
     * compliance guide, asked as one question.
     */
    withholding: Pick<ArtistTaxDocumentService, 'withholdingStatus'>;
    /** Exposed for jobs: issue an invoice, sweep expired documents. */
    invoices: InvoiceService;
    documents: ArtistTaxDocumentService;
    /** Buyer-facing: GET /invoices, GET /invoices/:id, download. */
    createBuyerRouter(requireAuth: RequestHandler): Router;
    /** Operator/artist-facing: /admin/tax/*. */
    createAdminRouter(requireAuth: RequestHandler): Router;
}

/**
 * Wires the tax module.
 *
 * The one subscription is the important line in this file: invoices are issued
 * on **settlement**, not on claim. Tax is due on the supply, and the supply
 * happens when the buyer pays and the goods go out — an order paid in March and
 * claimed in April belongs on March's GSTR-1. That is the one place this module
 * deliberately differs from finance, which accrues at the claim.
 */
export function createTaxModule(deps: TaxModuleDeps): TaxModule {
    const logger = createModuleLogger(TAX_MODULE);
    const audit = deps.audit ?? NOOP_TAX_AUDIT;

    const invoiceRepo = new InvoiceRepository(deps.prisma);
    const configurationRepo = new TaxConfigurationRepository(deps.prisma);
    const documentRepo = new ArtistTaxDocumentRepository(deps.prisma);
    const filingRepo = new TaxFilingRepository(deps.prisma);
    const adjustmentRepo = new TaxAdjustmentRepository(deps.prisma);

    const renderer = new InvoicePdfRenderer({ logoPath: deps.logoPath });

    const invoices = new InvoiceService({
        invoices: invoiceRepo,
        configurations: configurationRepo,
        orders: deps.orders,
        storage: deps.storage,
        renderer,
        suppliers: deps.suppliers,
        eventBus: deps.eventBus,
        audit,
        logger,
    });
    const configurations = new TaxConfigurationService({
        configurations: configurationRepo,
        audit,
        logger,
    });
    const documents = new ArtistTaxDocumentService({
        documents: documentRepo,
        artists: deps.artists,
        storage: deps.storage,
        eventBus: deps.eventBus,
        audit,
        logger,
    });
    const filings = new TaxFilingService({
        filings: filingRepo,
        invoices: invoiceRepo,
        payouts: deps.payouts,
        artists: deps.artists,
        eventBus: deps.eventBus,
        audit,
        logger,
    });
    const adjustments = new TaxAdjustmentService({
        adjustments: adjustmentRepo,
        invoices: invoiceRepo,
        eventBus: deps.eventBus,
        audit,
        logger,
    });

    // Invoice at settlement. The handler swallows its own errors on purpose:
    // the event bus isolates a throwing subscriber already, and an invoice that
    // could not be issued is an operational problem to alert on, not a lost
    // payment — so it is logged with everything needed to issue it by hand
    // through POST /admin/tax/invoices.
    deps.eventBus.subscribe<OrderSettledEventPayload>(
        deps.settlementEventName ?? 'payments.order.settled',
        async (payload) => {
            try {
                await invoices.issueForOrder({ orderId: payload.orderId }, { actorId: null });
            } catch (error) {
                logger.error(
                    { err: error, orderId: payload.orderId },
                    'invoice could not be issued for settled order — issue it manually',
                );
            }
        },
    );

    const controller = new TaxController({
        invoices,
        configurations,
        documents,
        filings,
        adjustments,
        resolveAccess: deps.resolveAccess,
        resolveBuyerAccess: deps.resolveBuyerAccess,
    });

    return {
        withholding: documents,
        invoices,
        documents,

        /**
         * The buyer's own receipts.
         *
         * Gated on `order:read` — NOT on `payment-royalty:read`. A buyer holds
         * `order:read:own` and nothing in the payment-royalty family, and their
         * invoice is a fact about their order. Using the money capability here
         * would mean either granting buyers a finance permission or leaving
         * them unable to fetch their own receipt; neither is right.
         *
         * The resolver behind these routes always returns BUYER scope, so even
         * a finance operator calling them sees only their own invoices.
         */
        createBuyerRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            const own = deps.guard.requirePermission(TAX_ORDER_READ_CAPABILITY);

            router.get('/invoices', own, controller.listMyInvoices);
            router.get('/invoices/:invoiceId', own, controller.getMyInvoice);
            router.get('/invoices/:invoiceId/download', own, controller.downloadMyInvoice);

            return router;
        },

        createAdminRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);
            const { requirePermission } = deps.guard;

            // Reads take the plain read capability; the SCOPE of that grant
            // (own / organization / global) is what narrows the rows, and it is
            // resolved from the grant inside the service. An artist calling
            // GET /artist-documents gets their own paperwork and nothing else.
            const read = requirePermission(TAX_READ_CAPABILITY);
            // Writes are global-only: a tax rate, an invoice and a return are
            // all platform-level acts against a government.
            const manage = requirePermission(TAX_MANAGE_CAPABILITY, { globalOnly: true });
            // Correcting a figure already reported is a separate power again.
            const override = requirePermission(TAX_OVERRIDE_CAPABILITY, { globalOnly: true });
            // Copying customer rows out of the platform in bulk is a third.
            const exportData = requirePermission(TAX_EXPORT_CAPABILITY, { globalOnly: true });

            // ── Tax configuration (rates, HSN/SAC codes) ─────────────────────
            router.get('/configurations', read, controller.listConfigurations);
            router.post('/configurations', manage, controller.createConfiguration);
            router.get('/configurations/:configurationId', read, controller.getConfiguration);
            // No PUT/PATCH and no DELETE: rates are versioned, not edited.
            router.post(
                '/configurations/:configurationId/close',
                manage,
                controller.closeConfiguration,
            );

            // ── Invoices ─────────────────────────────────────────────────────
            router.get('/invoices', read, controller.listInvoices);
            router.post('/invoices', manage, controller.issueInvoice);
            router.get('/invoices/:invoiceId', read, controller.getInvoice);
            router.get('/invoices/:invoiceId/download', read, controller.downloadInvoice);
            router.post('/invoices/:invoiceId/void', manage, controller.voidInvoice);
            router.post(
                '/invoices/:invoiceId/regenerate',
                manage,
                controller.regenerateInvoiceDocument,
            );

            // ── Artist tax documents (W-9, PAN, GSTIN) ───────────────────────
            router.get('/artist-documents', read, controller.listArtistDocuments);
            // Registration is `read`-gated, not `manage`: an artist registering
            // their OWN W-9 is the normal path, and they hold read:own. The
            // service refuses a different artist's id.
            router.post('/artist-documents', read, controller.registerArtistDocument);
            router.get('/artist-documents/:documentId', read, controller.getArtistDocument);
            router.get(
                '/artist-documents/:documentId/download',
                read,
                controller.downloadArtistDocument,
            );
            // Verification is HitBox's: an artist cannot approve their own W-9.
            router.post(
                '/artist-documents/:documentId/review',
                manage,
                controller.reviewArtistDocument,
            );

            // ── Filings & statements ─────────────────────────────────────────
            router.get('/filings', read, controller.listFilings);
            router.post('/filings', manage, controller.createFiling);
            router.get('/filings/:filingId', read, controller.getFiling);
            router.post('/filings/:filingId/file', manage, controller.markFilingFiled);

            // ── Reports ──────────────────────────────────────────────────────
            // Platform returns are global-only, enforced in the service: a
            // GSTR-1 lists every seller's sales.
            router.get('/reports/indirect-tax', read, controller.indirectTaxSummary);
            router.get('/reports/export', exportData, controller.exportReturnRows);
            // Artist statements narrow by the caller's grant — an artist reads
            // their own 1099/16A figures, an operator reads anyone's.
            router.get('/reports/form-1099-nec', read, controller.form1099Preview);
            router.get('/reports/form-16a', read, controller.form16aPreview);

            // ── Adjustments ──────────────────────────────────────────────────
            router.get('/adjustments', read, controller.listAdjustments);
            router.post('/adjustments', manage, controller.createAdjustment);
            router.post(
                '/adjustments/:adjustmentId/decide',
                override,
                controller.decideAdjustment,
            );

            return router;
        },
    };
}

import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@hitbox/shared';
import type { TaxAccess } from '../domain/tax-access';
import { requireTaxManage } from '../domain/tax-access';
import {
    closeTaxConfigurationSchema,
    createTaxAdjustmentSchema,
    createTaxConfigurationSchema,
    createTaxFilingSchema,
    decideTaxAdjustmentSchema,
    issueInvoiceSchema,
    listArtistTaxDocumentsQuerySchema,
    listInvoicesQuerySchema,
    listTaxAdjustmentsQuerySchema,
    listTaxConfigurationsQuerySchema,
    listTaxFilingsQuerySchema,
    markTaxFilingFiledSchema,
    registerArtistTaxDocumentSchema,
    reviewArtistTaxDocumentSchema,
    taxSummaryQuerySchema,
    voidInvoiceSchema,
} from '../dto/tax.dto';
import type { ArtistTaxDocumentService } from '../service/artist-tax-document.service';
import type { InvoiceService } from '../service/invoice.service';
import type { TaxAdjustmentService } from '../service/tax-adjustment.service';
import type { TaxConfigurationService } from '../service/tax-configuration.service';
import type { TaxFilingService } from '../service/tax-filing.service';

/**
 * Resolves the caller's identity and what they may see. Two of them, because
 * the buyer surface and the operator surface answer the question differently —
 * see `buildTaxAccess` / `buildBuyerTaxAccess`.
 */
export type TaxAccessResolver = (req: Request) => Promise<TaxAccess>;

export interface TaxControllerDeps {
    invoices: InvoiceService;
    configurations: TaxConfigurationService;
    documents: ArtistTaxDocumentService;
    filings: TaxFilingService;
    adjustments: TaxAdjustmentService;
    /** Operator / artist surface. */
    resolveAccess: TaxAccessResolver;
    /** Buyer surface. Always BUYER scope, whatever else the caller holds. */
    resolveBuyerAccess: TaxAccessResolver;
}

const formPreviewQuerySchema = z.object({
    artistId: z.string().uuid(),
    taxYear: z.coerce.number().int().min(2020).max(2100),
});

const quarterPreviewQuerySchema = z.object({
    artistId: z.string().uuid(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
});

/** HTTP glue only: parse, resolve the caller, call a service, shape JSON. */
export class TaxController {
    constructor(private readonly deps: TaxControllerDeps) { }

    // ── Buyer surface ───────────────────────────────────────────────────────

    listMyInvoices: RequestHandler = asyncHandler(async (req, res) => {
        const query = listInvoicesQuerySchema.parse(req.query);
        const access = await this.deps.resolveBuyerAccess(req);
        res.json(await this.deps.invoices.list(query, access));
    });

    getMyInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveBuyerAccess(req);
        res.json({
            data: await this.deps.invoices.getById(req.params.invoiceId as string, access),
        });
    });

    downloadMyInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveBuyerAccess(req);
        res.json({
            data: await this.deps.invoices.downloadUrl(
                req.params.invoiceId as string,
                access,
            ),
        });
    });

    // ── Invoices (operator) ─────────────────────────────────────────────────

    listInvoices: RequestHandler = asyncHandler(async (req, res) => {
        const query = listInvoicesQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.invoices.list(query, access));
    });

    getInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.invoices.getById(req.params.invoiceId as string, access),
        });
    });

    issueInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const dto = issueInvoiceSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        // The route guard checked the capability; this checks that the grant
        // behind it is platform-wide. Issuing a statutory document is not
        // something an organization-scoped holder of the same capability does.
        requireTaxManage(access, 'issue an invoice');
        res.status(201).json({
            data: await this.deps.invoices.issueForOrder(dto, { actorId: access.userId }),
        });
    });

    downloadInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.invoices.downloadUrl(
                req.params.invoiceId as string,
                access,
            ),
        });
    });

    voidInvoice: RequestHandler = asyncHandler(async (req, res) => {
        const dto = voidInvoiceSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.invoices.void(req.params.invoiceId as string, dto, access),
        });
    });

    regenerateInvoiceDocument: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.invoices.regenerateDocument(
                req.params.invoiceId as string,
                access,
            ),
        });
    });

    // ── Tax configuration ───────────────────────────────────────────────────

    listConfigurations: RequestHandler = asyncHandler(async (req, res) => {
        const query = listTaxConfigurationsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.configurations.list(query, access));
    });

    getConfiguration: RequestHandler = asyncHandler(async (req, res) => {
        await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.configurations.getById(req.params.configurationId as string),
        });
    });

    createConfiguration: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createTaxConfigurationSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.configurations.create(dto, access) });
    });

    closeConfiguration: RequestHandler = asyncHandler(async (req, res) => {
        const dto = closeTaxConfigurationSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.configurations.close(
                req.params.configurationId as string,
                dto,
                access,
            ),
        });
    });

    // ── Artist tax documents ────────────────────────────────────────────────

    listArtistDocuments: RequestHandler = asyncHandler(async (req, res) => {
        const query = listArtistTaxDocumentsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.documents.list(query, access));
    });

    getArtistDocument: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.documents.getById(req.params.documentId as string, access),
        });
    });

    registerArtistDocument: RequestHandler = asyncHandler(async (req, res) => {
        const dto = registerArtistTaxDocumentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.documents.register(dto, access) });
    });

    reviewArtistDocument: RequestHandler = asyncHandler(async (req, res) => {
        const dto = reviewArtistTaxDocumentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.documents.review(
                req.params.documentId as string,
                dto,
                access,
            ),
        });
    });

    downloadArtistDocument: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.documents.downloadUrl(
                req.params.documentId as string,
                access,
            ),
        });
    });

    // ── Filings & reports ───────────────────────────────────────────────────

    listFilings: RequestHandler = asyncHandler(async (req, res) => {
        const query = listTaxFilingsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.filings.list(query, access));
    });

    getFiling: RequestHandler = asyncHandler(async (req, res) => {
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.filings.getById(req.params.filingId as string, access),
        });
    });

    createFiling: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createTaxFilingSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.filings.create(dto, access) });
    });

    markFilingFiled: RequestHandler = asyncHandler(async (req, res) => {
        const dto = markTaxFilingFiledSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.filings.markFiled(
                req.params.filingId as string,
                dto,
                access,
            ),
        });
    });

    indirectTaxSummary: RequestHandler = asyncHandler(async (req, res) => {
        const query = taxSummaryQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.filings.indirectTaxSummary(query, access) });
    });

    exportReturnRows: RequestHandler = asyncHandler(async (req, res) => {
        const query = taxSummaryQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.filings.exportInvoiceRows(query, access) });
    });

    form1099Preview: RequestHandler = asyncHandler(async (req, res) => {
        const query = formPreviewQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.filings.form1099Preview(query, access) });
    });

    form16aPreview: RequestHandler = asyncHandler(async (req, res) => {
        const query = quarterPreviewQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json({ data: await this.deps.filings.form16aPreview(query, access) });
    });

    // ── Adjustments ─────────────────────────────────────────────────────────

    listAdjustments: RequestHandler = asyncHandler(async (req, res) => {
        const query = listTaxAdjustmentsQuerySchema.parse(req.query);
        const access = await this.deps.resolveAccess(req);
        res.json(await this.deps.adjustments.list(query, access));
    });

    createAdjustment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createTaxAdjustmentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.status(201).json({ data: await this.deps.adjustments.create(dto, access) });
    });

    decideAdjustment: RequestHandler = asyncHandler(async (req, res) => {
        const dto = decideTaxAdjustmentSchema.parse(req.body);
        const access = await this.deps.resolveAccess(req);
        res.json({
            data: await this.deps.adjustments.decide(
                req.params.adjustmentId as string,
                dto,
                access,
            ),
        });
    });
}

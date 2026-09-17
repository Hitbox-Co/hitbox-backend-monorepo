import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Currency, Invoice } from '@hitbox/database';
import {
    INVOICE_PAYMENT_TERMS_DAYS,
    TAX_AUDIT_EVENTS,
    TAX_ERROR_CODES,
    TAX_EVENTS,
} from '../constants/tax.constant';
import { invoiceDocumentKey } from '../domain/document-storage-key';
import { fiscalYearOf } from '../domain/fiscal-calendar';
import { formatInvoiceNumber } from '../domain/invoice-number';
import { calculateInvoice, resolveTaxConfiguration } from '../domain/tax-calculation';
import type { TaxAccess } from '../domain/tax-access';
import { TaxScope, requireTaxManage } from '../domain/tax-access';
import {
    formatSupplierAddress,
    supplierIsIssuable,
} from '../domain/supplier-profile';
import type { SupplierProfile } from '../domain/supplier-profile';
import type { IDocumentStorage } from '../domain/interfaces/document-storage.port';
import type { IInvoiceableOrderSource, InvoiceableOrder } from '../domain/interfaces/invoiceable-order.port';
import type { ITaxAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { recordTaxAudit } from '../domain/interfaces/audit-recorder.port';
import type { InvoicePdfRenderer, InvoiceDocumentModel } from '../infrastructure/invoice-pdf.renderer';
import type { InvoiceRepository, InvoiceWithLines } from '../repository/invoice.repository';
import type { TaxConfigurationRepository } from '../repository/tax-configuration.repository';
import type { IssueInvoiceDto, ListInvoicesQuery, VoidInvoiceDto } from '../dto/tax.dto';

/** Order statuses an invoice may be issued against. */
const SETTLED_STATUSES = new Set(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED']);

/** How long a download URL lives. Long enough to click, short enough to leak. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

export interface InvoiceServiceDeps {
    invoices: InvoiceRepository;
    configurations: TaxConfigurationRepository;
    orders: IInvoiceableOrderSource;
    storage: IDocumentStorage | null;
    renderer: InvoicePdfRenderer;
    /** Keyed by ISO country code. See domain/supplier-profile.ts. */
    suppliers: Map<string, SupplierProfile>;
    eventBus: IEventBus;
    audit: ITaxAuditRecorder;
    logger: Logger;
}

/**
 * Issuing, reading and cancelling customer invoices.
 *
 * The invoice is written **when the order settles**, not when it is placed and
 * not when it is claimed. That is a deliberate difference from how the finance
 * module accrues royalties — royalty is earned at the claim, because HitBox has
 * not delivered value until the buyer holds the item — but tax is due on the
 * *supply*, and under both regimes the supply happens when the customer pays
 * for and receives the goods. Waiting for the claim would mean an order paid in
 * March and claimed in April lands in the wrong GSTR-1 period.
 */
export class InvoiceService {
    constructor(private readonly deps: InvoiceServiceDeps) { }

    // ── Issue ───────────────────────────────────────────────────────────────

    /**
     * Issues the invoice for a settled order, renders the PDF and stores it.
     *
     * Idempotent by construction: `Invoice.orderId` is unique, and an order
     * that already has an invoice returns the existing one rather than raising.
     * That matters because this is called from an event handler as well as from
     * the API, and a redelivered settlement event must not mint a second
     * statutory number for the same supply.
     */
    async issueForOrder(
        dto: IssueInvoiceDto,
        options: { actorId: string | null; force?: boolean } = { actorId: null },
    ): Promise<InvoiceWithLines> {
        const existing = await this.deps.invoices.findByOrderId(dto.orderId);
        if (existing) {
            this.deps.logger.debug(
                { orderId: dto.orderId, invoiceNumber: existing.invoiceNumber },
                'invoice already issued for order — returning it',
            );
            return existing;
        }

        const order = await this.deps.orders.findById(dto.orderId);
        if (!order) {
            throw AppError.notFound('Order not found.', TAX_ERROR_CODES.NOT_FOUND);
        }
        if (!SETTLED_STATUSES.has(order.status)) {
            throw AppError.badRequest(
                `An invoice may only be issued for a settled order; this one is ${order.status}. ` +
                `Issuing one earlier would put a number in the statutory series for a supply ` +
                `that may never happen.`,
                TAX_ERROR_CODES.ORDER_NOT_INVOICEABLE,
            );
        }

        const invoiceDate = dto.invoiceDate ?? new Date();
        const countryCode = jurisdictionOf(order);
        const stateCode = order.billingAddress?.state ?? null;

        const supplier = this.deps.suppliers.get(countryCode);
        if (!supplier || !supplierIsIssuable(supplier)) {
            throw AppError.badRequest(
                `HitBox has no issuable supplier profile for ${countryCode}` +
                (countryCode === 'IN' ? ' (an Indian tax invoice needs a GSTIN).' : '.'),
                TAX_ERROR_CODES.SUPPLIER_NOT_CONFIGURED,
            );
        }

        const configuration = resolveTaxConfiguration(
            (
                await this.deps.configurations.findCandidates({
                    productId: order.productId,
                    countryCode,
                    stateCode,
                })
            ).map((row) => ({
                id: row.id,
                productId: row.productId,
                countryCode: row.countryCode,
                stateCode: row.stateCode,
                taxType: row.taxType,
                taxRate: row.taxRate.toString(),
                hsnCode: row.hsnCode,
                sacCode: row.sacCode,
                effectiveFrom: row.effectiveFrom,
                effectiveTo: row.effectiveTo,
            })),
            { productId: order.productId, countryCode, stateCode, at: invoiceDate },
        );

        if (!configuration) {
            throw AppError.badRequest(
                `No tax rate is configured for ${[stateCode, countryCode].filter(Boolean).join('-')} ` +
                `on ${invoiceDate.toISOString().slice(0, 10)}. Configure one before invoicing ` +
                `sales in this jurisdiction — issuing an invoice at an assumed rate is worse ` +
                `than not issuing one.`,
                TAX_ERROR_CODES.NO_TAX_CONFIGURATION,
            );
        }

        const totals = calculateInvoice([
            {
                description: order.productName,
                productId: order.productId,
                skuId: order.skuId,
                hsnCode: configuration.hsnCode,
                sacCode: configuration.sacCode,
                quantity: order.quantity,
                unitPrice: order.unitPrice,
                taxRate: configuration.taxRate,
            },
        ]);

        const fiscalYear = fiscalYearOf(countryCode, invoiceDate);
        const created = await this.deps.invoices.createWithNumber({
            countryCode,
            fiscalYear,
            build: (sequence) => {
                const invoiceNumber = formatInvoiceNumber({ fiscalYear, countryCode, sequence });
                const now = new Date();
                return {
                    invoice: {
                        invoiceNumber,
                        invoiceDate,
                        fiscalYear,
                        orderId: order.orderId,
                        buyerId: order.buyerId,
                        organizationId: order.organizationId,
                        countryCode,
                        stateCode,
                        currency: order.currency as Currency,
                        subtotal: totals.subtotal,
                        taxAmount: totals.taxAmount,
                        totalAmount: totals.totalAmount,
                        taxType: configuration.taxType as 'GST' | 'SALES_TAX' | 'EXEMPT',
                        taxRate: totals.uniformTaxRate ?? configuration.taxRate,
                        hsnCode: totals.uniformHsnCode,
                        supplierName: supplier.legalName,
                        supplierAddress: formatSupplierAddress(supplier),
                        supplierGstin: supplier.gstin ?? null,
                        supplierPan: supplier.pan ?? null,
                        supplierEin: supplier.ein ?? null,
                        customerName: order.customerName,
                        customerEmail: order.customerEmail,
                        customerAddress: order.billingAddress
                            ? formatCustomerAddress(order).join('\n')
                            : null,
                        customerGstin: null,
                        // The price the invoice was raised at, frozen. When the
                        // versioned product_cost table lands, `productCostId`
                        // is set here too — the column already exists for it.
                        salesPriceSnapshot: order.unitPrice,
                        productCostId: null,
                        status: 'ISSUED' as const,
                        issuedAt: now,
                        notes: dto.notes ?? null,
                        createdById: options.actorId,
                        createdAt: now,
                        updatedAt: now,
                    },
                    lines: totals.lines.map((line) => ({
                        position: line.position,
                        description: line.description,
                        productId: line.productId ?? null,
                        skuId: line.skuId ?? null,
                        hsnCode: line.hsnCode ?? null,
                        sacCode: line.sacCode ?? null,
                        quantity: line.quantity,
                        unitPrice: line.unitPrice,
                        lineSubtotal: line.lineSubtotal,
                        taxRate: line.taxRate,
                        taxAmount: line.taxAmount,
                        lineTotal: line.lineTotal,
                        createdAt: now,
                    })),
                };
            },
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.INVOICE_ISSUE,
            actorId: options.actorId,
            targetType: 'Invoice',
            targetId: created.id,
            metadata: {
                invoiceNumber: created.invoiceNumber,
                orderId: order.orderId,
                countryCode,
                taxRate: created.taxRate.toString(),
                totalAmount: created.totalAmount.toString(),
                taxConfigurationId: configuration.id,
            },
        });
        this.deps.eventBus.publish(TAX_EVENTS.INVOICE_ISSUED, {
            invoiceId: created.id,
            invoiceNumber: created.invoiceNumber,
            orderId: order.orderId,
            buyerId: order.buyerId,
            countryCode,
            totalAmount: created.totalAmount.toString(),
            currency: created.currency,
        });

        // Rendering is best-effort and deliberately after the row is committed.
        // The invoice EXISTS the moment its number is minted; the PDF is a
        // projection that can be produced again at any time. A bucket outage
        // must not be able to stop HitBox issuing an invoice it is legally
        // required to issue.
        return (await this.renderAndStoreQuietly(created)) ?? created;
    }

    // ── Read ────────────────────────────────────────────────────────────────

    async list(
        query: ListInvoicesQuery,
        access: TaxAccess,
    ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number } }> {
        const { total, items } = await this.deps.invoices.list({
            ...query,
            organizationIds: access.scope === TaxScope.BUYER ? null : access.organizationIds,
            restrictToBuyerId: access.scope === TaxScope.BUYER ? access.userId : null,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            data: items.map((invoice) => this.present(invoice, access)),
            meta: { page: query.page, limit: query.limit, total },
        };
    }

    async getById(id: string, access: TaxAccess): Promise<unknown> {
        return this.present(await this.requireInScope(id, access), access);
    }

    /**
     * A short-lived download URL for the PDF.
     *
     * Presigned rather than proxied: the bytes go straight from S3 to the
     * client and never through this process, which matters when a finance
     * operator exports a quarter's invoices. The read is audited — fetching an
     * invoice is a disclosure of a customer's name and address, and "who
     * downloaded this" is a question both a tax audit and a data-subject
     * request will ask.
     */
    async downloadUrl(
        id: string,
        access: TaxAccess,
    ): Promise<{ url: string; expiresIn: number; invoiceNumber: string }> {
        const invoice = await this.requireInScope(id, access);
        const storage = this.requireStorage();

        if (!invoice.pdfStorageRef) {
            // The row exists but its document does not — render it now rather
            // than telling the customer their receipt is unavailable.
            const rendered = await this.renderAndStore(invoice);
            invoice.pdfStorageRef = rendered.pdfStorageRef;
        }

        const link = await storage.presignDownload({
            key: invoice.pdfStorageRef as string,
            expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.INVOICE_DOWNLOAD,
            actorId: access.userId,
            targetType: 'Invoice',
            targetId: invoice.id,
            metadata: { invoiceNumber: invoice.invoiceNumber, scope: access.scope },
        });

        return { ...link, invoiceNumber: invoice.invoiceNumber };
    }

    // ── Write ───────────────────────────────────────────────────────────────

    /**
     * Cancels an invoice.
     *
     * The number is retained and the row is kept: a void invoice is reported as
     * void on the return, and reusing its number would break the sequence. This
     * is why there is no delete anywhere in this service.
     */
    async void(id: string, dto: VoidInvoiceDto, access: TaxAccess): Promise<unknown> {
        requireTaxManage(access, 'void an invoice');
        const invoice = await this.requireInScope(id, access);

        if (invoice.status !== 'ISSUED') {
            throw AppError.conflict(
                `Invoice ${invoice.invoiceNumber} is already ${invoice.status}.`,
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const updated = await this.deps.invoices.setStatus(id, 'VOID', {
            voidReason: dto.reason,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.INVOICE_VOID,
            actorId: access.userId,
            targetType: 'Invoice',
            targetId: id,
            metadata: { invoiceNumber: invoice.invoiceNumber, reason: dto.reason },
        });
        this.deps.eventBus.publish(TAX_EVENTS.INVOICE_VOIDED, {
            invoiceId: id,
            invoiceNumber: invoice.invoiceNumber,
            reason: dto.reason,
        });

        // Re-render so the stored PDF carries the VOID watermark: the document
        // in the bucket is the one a customer already has a link to, and it
        // must stop reading like a valid invoice.
        await this.renderAndStoreQuietly({ ...invoice, ...updated });
        return this.present({ ...invoice, ...updated }, access);
    }

    /** Re-renders and re-stores the PDF from the row. Idempotent. */
    async regenerateDocument(id: string, access: TaxAccess): Promise<unknown> {
        requireTaxManage(access, 'regenerate an invoice document');
        const invoice = await this.requireInScope(id, access);
        return this.present(await this.renderAndStore(invoice), access);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Loads an invoice and refuses it if the caller's grant does not reach it.
     *
     * The scope check happens here rather than in the query so a caller asking
     * for an id they cannot see gets a 403 that says so, not a 404 that implies
     * the invoice does not exist. For a BUYER the two are the same answer
     * anyway — they may not learn that someone else's invoice exists — so that
     * case returns 404 deliberately.
     */
    private async requireInScope(id: string, access: TaxAccess): Promise<InvoiceWithLines> {
        const invoice = await this.deps.invoices.findById(id);
        if (!invoice) {
            throw AppError.notFound('Invoice not found.', TAX_ERROR_CODES.NOT_FOUND);
        }

        if (access.scope === TaxScope.BUYER) {
            if (invoice.buyerId !== access.userId) {
                throw AppError.notFound('Invoice not found.', TAX_ERROR_CODES.NOT_FOUND);
            }
            return invoice;
        }

        if (access.scope === TaxScope.GLOBAL) return invoice;

        const reaches =
            invoice.organizationId !== null &&
            (access.organizationIds ?? []).includes(invoice.organizationId);
        if (!reaches) {
            throw AppError.forbidden(
                'This invoice belongs to another organization.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
        return invoice;
    }

    private requireStorage(): IDocumentStorage {
        if (!this.deps.storage) {
            throw AppError.badRequest(
                'Document storage is not configured on this deployment.',
                TAX_ERROR_CODES.STORAGE_UNAVAILABLE,
            );
        }
        return this.deps.storage;
    }

    /** Renders, stores and records the document. Raises on failure. */
    private async renderAndStore(invoice: InvoiceWithLines): Promise<InvoiceWithLines> {
        const storage = this.requireStorage();
        const pdf = await this.deps.renderer.render(this.toDocumentModel(invoice));
        const key = invoiceDocumentKey({
            countryCode: invoice.countryCode,
            fiscalYear: invoice.fiscalYear,
            invoiceNumber: invoice.invoiceNumber,
        });

        const stored = await storage.put({
            key,
            body: pdf,
            contentType: 'application/pdf',
            metadata: {
                'invoice-number': invoice.invoiceNumber,
                'country-code': invoice.countryCode,
                'fiscal-year': invoice.fiscalYear,
                'document-class': 'tax-invoice',
            },
        });

        const updated = await this.deps.invoices.attachDocument(invoice.id, {
            storageRef: stored.key,
            sha256: stored.sha256,
            renderedAt: new Date(),
        });
        this.deps.eventBus.publish(TAX_EVENTS.INVOICE_DOCUMENT_STORED, {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            storageRef: stored.key,
            sha256: stored.sha256,
        });
        return { ...invoice, ...updated };
    }

    /**
     * Same, but swallows failure.
     *
     * Used on the issue path, where the invoice row is already committed and
     * the document can be produced again later. Logged with everything needed
     * to re-run it by hand, in the same spirit as finance's accrual handler.
     */
    private async renderAndStoreQuietly(
        invoice: InvoiceWithLines,
    ): Promise<InvoiceWithLines | null> {
        try {
            return await this.renderAndStore(invoice);
        } catch (error) {
            this.deps.logger.error(
                { err: error, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
                'invoice PDF could not be rendered or stored — the invoice is issued; ' +
                'regenerate the document with POST /admin/tax/invoices/:id/regenerate',
            );
            return null;
        }
    }

    private toDocumentModel(invoice: InvoiceWithLines): InvoiceDocumentModel {
        return {
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            dueDate: new Date(
                invoice.invoiceDate.getTime() + INVOICE_PAYMENT_TERMS_DAYS * 86_400_000,
            ),
            countryCode: invoice.countryCode,
            stateCode: invoice.stateCode,
            currency: invoice.currency,
            status: invoice.status,
            taxType: invoice.taxType,
            supplier: {
                legalName: invoice.supplierName,
                addressLines: invoice.supplierAddress.split('\n'),
                gstin: invoice.supplierGstin,
                pan: invoice.supplierPan,
                ein: invoice.supplierEin,
                email: this.deps.suppliers.get(invoice.countryCode)?.email ?? null,
                phone: this.deps.suppliers.get(invoice.countryCode)?.phone ?? null,
            },
            customer: {
                name: invoice.customerName,
                email: invoice.customerEmail,
                addressLines: invoice.customerAddress?.split('\n') ?? [],
                gstin: invoice.customerGstin,
            },
            orderReference: invoice.orderId,
            lines: invoice.lineItems.map((line) => ({
                position: line.position,
                description: line.description,
                hsnCode: line.hsnCode,
                sacCode: line.sacCode,
                quantity: line.quantity,
                unitPrice: line.unitPrice.toString(),
                lineSubtotal: line.lineSubtotal.toString(),
                taxRate: line.taxRate.toString(),
                taxAmount: line.taxAmount.toString(),
                lineTotal: line.lineTotal.toString(),
            })),
            subtotal: invoice.subtotal.toString(),
            taxAmount: invoice.taxAmount.toString(),
            totalAmount: invoice.totalAmount.toString(),
            taxRate: invoice.taxRate.toString(),
            notes: invoice.notes,
            voidReason: invoice.voidReason,
        };
    }

    /**
     * The API shape.
     *
     * A BUYER never sees the storage key or the digest — those are operational
     * facts about where HitBox keeps the file, not part of their receipt, and a
     * key is the one string that makes a bucket worth probing.
     */
    private present(invoice: InvoiceWithLines, access: TaxAccess): unknown {
        const operator = access.scope !== TaxScope.BUYER;
        return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            fiscalYear: invoice.fiscalYear,
            status: invoice.status,
            orderId: invoice.orderId,
            countryCode: invoice.countryCode,
            stateCode: invoice.stateCode,
            currency: invoice.currency,
            taxType: invoice.taxType,
            taxRate: invoice.taxRate.toString(),
            hsnCode: invoice.hsnCode,
            subtotal: invoice.subtotal.toString(),
            taxAmount: invoice.taxAmount.toString(),
            totalAmount: invoice.totalAmount.toString(),
            supplier: {
                name: invoice.supplierName,
                address: invoice.supplierAddress,
                gstin: invoice.supplierGstin,
                pan: invoice.supplierPan,
                ein: invoice.supplierEin,
            },
            customer: {
                name: invoice.customerName,
                email: invoice.customerEmail,
                address: invoice.customerAddress,
                gstin: invoice.customerGstin,
            },
            lineItems: invoice.lineItems.map((line) => ({
                position: line.position,
                description: line.description,
                hsnCode: line.hsnCode,
                sacCode: line.sacCode,
                quantity: line.quantity,
                unitPrice: line.unitPrice.toString(),
                lineSubtotal: line.lineSubtotal.toString(),
                taxRate: line.taxRate.toString(),
                taxAmount: line.taxAmount.toString(),
                lineTotal: line.lineTotal.toString(),
            })),
            documentAvailable: invoice.pdfStorageRef !== null,
            notes: invoice.notes,
            issuedAt: invoice.issuedAt,
            ...(operator
                ? {
                    buyerId: invoice.buyerId,
                    organizationId: invoice.organizationId,
                    pdfStorageRef: invoice.pdfStorageRef,
                    pdfSha256: invoice.pdfSha256,
                    pdfRenderedAt: invoice.pdfRenderedAt,
                    deliveredAt: invoice.deliveredAt,
                    voidReason: invoice.voidReason,
                    supersedesInvoiceId: invoice.supersedesInvoiceId,
                    salesPriceSnapshot: invoice.salesPriceSnapshot?.toString() ?? null,
                    productCostId: invoice.productCostId,
                    createdById: invoice.createdById,
                }
                : {}),
        };
    }
}

/**
 * Which jurisdiction's rules this order falls under.
 *
 * The **billing address** decides it, not the currency and not the buyer's
 * profile country: US sales tax is a destination tax keyed to where the
 * customer is, and Indian GST turns on the place of supply. Currency is only
 * the fallback for a digital order with no address captured at all, and it is a
 * weak one — a card can be billed in USD from anywhere — which is why an
 * address is captured at checkout.
 */
function jurisdictionOf(order: InvoiceableOrder): string {
    const fromAddress = order.billingAddress?.countryCode;
    if (fromAddress) return fromAddress.toUpperCase();
    return order.currency === 'INR' ? 'IN' : 'US';
}

function formatCustomerAddress(order: InvoiceableOrder): string[] {
    const address = order.billingAddress;
    if (!address) return [];
    return [
        ...address.lines,
        [address.city, address.state, address.postalCode].filter(Boolean).join(', '),
        address.countryCode,
    ].filter((line) => line.length > 0);
}

/** Exported for the settlement subscriber in module.ts. */
export type { Invoice };

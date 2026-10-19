/**
 * What this module needs to know about an order to invoice it.
 *
 * The consumer defines the port (architecture doc §6): tax states the shape,
 * orders provides an adapter, bootstrap connects them. Tax never reads the
 * `Order` table, and orders knows nothing about invoicing.
 *
 * Note what is NOT here: nothing about royalties, COGS, or what the artist
 * earns. An invoice is between HitBox and the *buyer*; the artist's side of the
 * transaction is the finance module's ledger and reaches this module only as a
 * filing (Form 16A / 1099-NEC) against an already-executed payout.
 */
export interface InvoiceableOrder {
    orderId: string;
    buyerId: string;
    organizationId: string | null;
    productId: string;
    skuId: string | null;
    /** Printed as the line description. Snapshotted onto the invoice line. */
    productName: string;
    quantity: number;
    /** Per-unit price, exclusive of tax, in `currency`. */
    unitPrice: string;
    /** quantity × unitPrice, exclusive of tax. */
    amount: string;
    currency: string;
    /** PAID / SHIPPED / DELIVERED etc. Only settled orders may be invoiced. */
    status: string;
    placedAt: Date;

    /** Buyer identity as printed on the document. */
    customerName: string;
    customerEmail: string;
    /** Billing address, already flattened to printable lines. Null if none. */
    billingAddress: {
        lines: string[];
        city: string;
        state: string | null;
        postalCode: string;
        countryCode: string;
    } | null;
}

export interface IInvoiceableOrderSource {
    /** Null when the order does not exist. */
    findById(orderId: string): Promise<InvoiceableOrder | null>;
}

/**
 * What checkout and the quote need from two modules that are not orders:
 * the buyer's address book (users) and the tax arithmetic (tax).
 *
 * Both are ports payments defines and bootstrap connects, like `IOrderLedger`.
 * Neither provider is imported here.
 */

/** An address the buyer picked, as far as checkout is concerned. */
export interface CheckoutAddress {
    id: string;
    countryCode: string;
    state: string | null;
}

export interface IAddressBook {
    /**
     * The one ownership check for an address id sent to checkout or the quote.
     *
     * - not the buyer's own → resolves to `null` (silently ignored, as always);
     * - the buyer's own but archived → throws (`USERS_ADDRESS_ARCHIVED`);
     * - cannot serve that side (shipping-only used as billing) → throws.
     */
    resolveForCheckout(
        buyerId: string,
        ids: { shippingAddressId?: string | null; billingAddressId?: string | null },
    ): Promise<{ shipping: CheckoutAddress | null; billing: CheckoutAddress | null }>;
}

export interface TaxEstimate {
    countryCode: string;
    stateCode: string | null;
    taxType: 'GST' | 'SALES_TAX' | 'EXEMPT' | null;
    taxRate: string;
    /** The price without tax. */
    subtotal: string;
    /** The part of the price that is tax. */
    taxAmount: string;
    /** subtotal + taxAmount: always the price. */
    totalAmount: string;
}

export interface ITaxEstimator {
    /**
     * The tax inside a tax-inclusive price, by the invoice's own arithmetic.
     * `countryCode: null` uses the currency's fallback country (INR → IN, else US).
     */
    estimate(input: {
        productId: string;
        countryCode: string | null;
        stateCode: string | null;
        currency: string;
        unitPrice: string;
    }): Promise<TaxEstimate>;

    /** Whether the currency's fallback country charges tax on this drop. */
    taxedByDefault(input: { productId: string; currency: string }): Promise<boolean>;
}

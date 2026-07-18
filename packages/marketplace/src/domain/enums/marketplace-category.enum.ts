/**
 * The Marketplace screen's filter tabs ("All Items" = omit the filter).
 * Screen-level vocabulary, NOT the Prisma ProductCategory enum — the
 * products adapter maps each tab to one or more storage categories, so
 * this module stays free of database knowledge.
 */
export enum MarketplaceCategory {
    CARDS = 'cards',
    FIGURES = 'figures',
    APPAREL = 'apparel',
    POSTERS = 'posters',
    DIGITAL = 'digital',
    OTHER = 'other',
}

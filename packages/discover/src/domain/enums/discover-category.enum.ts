/**
 * The category chips on the Discover screen ("All Items" = no category).
 * Screen-level vocabulary — the products adapter maps each onto the
 * free-form `Drop.category` values it covers. Same set as the Marketplace
 * tabs, kept separate so neither module depends on the other.
 */
export enum DiscoverCategory {
    CARDS = 'cards',
    FIGURES = 'figures',
    APPAREL = 'apparel',
    POSTERS = 'posters',
    DIGITAL = 'digital',
    OTHER = 'other',
}

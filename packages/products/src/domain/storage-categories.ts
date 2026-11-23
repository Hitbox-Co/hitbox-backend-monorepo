/**
 * The category tabs the Marketplace and Discover screens share ("cards",
 * "figures", …), mapped onto the free-form `Drop.category` values each
 * covers. Both modules define their own enum with these same string values;
 * this one map serves both adapters so the two screens cannot drift apart.
 *
 * `Drop.category` is a free-form `String?` since the catalog restructure, so
 * the values below are the contract with whoever populates it. A drop whose
 * category is in no list is reachable only from "All Items", which is why
 * `other` is a fallback list rather than a catch-all.
 */
export const STORAGE_CATEGORIES_BY_TAB = {
    cards: ['TRADING_CARD', 'CARD_PACK'],
    figures: ['FIGURE'],
    apparel: ['APPAREL', 'JERSEY', 'ACCESSORY'],
    posters: ['POSTER'],
    digital: ['DIGITAL_ASSET'],
    other: ['BOOK', 'AUTOGRAPH', 'GAME_BOX', 'OTHER'],
} satisfies Record<string, string[]>;

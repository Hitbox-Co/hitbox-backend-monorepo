/**
 * The Discover screen's product sections. Deliberately NOT a Prisma enum —
 * the products module maps these to storage concerns in its adapter, so this
 * module stays free of database knowledge.
 *
 * "Meet the creators" is not a product section: it lists artists, and has its
 * own port method (`findCreators`).
 */
export enum DiscoverSection {
    /** Hero carousel — the highest rarity tiers, most minted first. */
    FEATURED = 'featured',
    /** "Trending now" — most minted SKUs first. */
    TRENDING = 'trending',
    /** "Latest drops" — newest first. */
    NEW_RELEASES = 'new_releases',
}

/**
 * The Discover screen's tabs. Deliberately NOT the Prisma MarketplaceStatus
 * enum — the products module maps these to storage concerns in its adapter,
 * so this module stays free of database knowledge.
 */
export enum DiscoverSection {
    TRENDING = 'trending',
    NEW_RELEASES = 'new_releases',
    TOP_CREATORS = 'top_creators',
}

/**
 * Port: putting drops into (and out of) a collection.
 *
 * Consumer-defined here, implemented by @hitbox/products
 * (`productsModule.collectionMembership`), connected in bootstrap. Products
 * owns `Drop` and its cache, so products does the write; this module decides
 * whether the artist may make it. Neither imports the other.
 */

export interface MembershipDrop {
    id: string;
    publicCode: string | null;
    name: string;
    groupCode: string;
    status: string;
    /** On sale: ACTIVE, switched on, not archived. */
    active: boolean;
    artistId: string | null;
    totalSupply: number;
    publishedAt: Date | null;
    /** The collection it is in now, if any. */
    collection: { id: string; name: string } | null;
}

export interface IDropCollectionMembership {
    /**
     * The artist's active drops that could go into `collectionId` — never ones
     * already in it. Unfiled only, unless `includeFiled` (drops in the
     * artist's other collections, which an add would move).
     */
    listAssignable(input: {
        artistId: string;
        collectionId: string;
        includeFiled: boolean;
        q?: string | undefined;
        skip: number;
        take: number;
    }): Promise<{ total: number; items: MembershipDrop[] }>;

    /** Whichever of these ids exist. */
    findDrops(dropIds: string[]): Promise<MembershipDrop[]>;

    /**
     * All or nothing. Each drop must still belong to `artistId` and still sit
     * in `expectedCollectionId` (and be active, when asked) at write time;
     * false means one didn't, and nothing changed.
     */
    setCollection(input: {
        drops: { id: string; expectedCollectionId: string | null }[];
        artistId: string;
        collectionId: string | null;
        requireActive: boolean;
    }): Promise<boolean>;
}

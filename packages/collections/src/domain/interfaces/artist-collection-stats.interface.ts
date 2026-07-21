/** Capacity of one ArtistCollection — the "how many can this hold" number. */
export interface ArtistCollectionCapacity {
    collectionId: string;
    maximumLimit: number;
}

/**
 * Port the collections module needs from the artist module to compute a
 * buyer's "collection progress". Consumer (collections) defines it; provider
 * (artist) implements the adapter; bootstrap injects it. Same pattern as
 * auth's IAccountLookup ← users.
 */
export interface IArtistCollectionStats {
    /**
     * maximumLimit for each of the given ArtistCollection ids. Unknown ids are
     * omitted. Empty input → empty output.
     */
    getCapacities(collectionIds: string[]): Promise<ArtistCollectionCapacity[]>;
}

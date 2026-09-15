/**
 * Port: look up media assets by id.
 *
 * Products joins assets into its gallery (`ProductImage.assetId`) but does not
 * own `MediaAsset` — the media module does. Attaching an image has to answer
 * three questions about an asset products cannot answer itself: does it exist,
 * is it actually an image, and has it been archived. So it asks.
 *
 * Without this the alternative is products querying another module's table
 * directly, which is the exact coupling the module boundary exists to prevent
 * — and it would silently break the day media adds a soft-delete rule or a
 * storage-tier column that changes what "usable asset" means.
 *
 * Optional at the module factory: omit it and image attachment is refused with
 * a clear error rather than writing unvalidated joins.
 */
export interface IMediaAssets {
    findByIds(ids: string[]): Promise<MediaAssetRef[]>;
}

export interface MediaAssetRef {
    id: string;
    /** Object key — turned into a URL by `IMediaUrlResolver`. */
    storageRef: string;
    /** `DROP_IMAGE`, `PROFILE_IMAGE`, `EXCLUSIVE_CONTENT`, … */
    assetType: string;
    mimeType: string;
    /** Archived assets are refused: a gallery must not point at a dead file. */
    archivedAt: Date | null;
    /** Set when the asset was uploaded against a specific drop. */
    productId: string | null;
    organizationId: string | null;
}

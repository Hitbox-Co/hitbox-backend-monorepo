/**
 * Turns a `MediaAsset.storageRef` into a URL a client can render.
 *
 * Needed because the catalog restructure replaced `ProductImage.url` with
 * `ProductImage.assetId` → `MediaAsset`: the row carries an object-storage
 * **key**, and only the media module's storage adapter knows the bucket,
 * region and which prefixes are publicly readable.
 *
 * Products and collections declare structurally identical ports. They are
 * deliberately not shared — each consumer owning its own port is the pattern
 * discover and marketplace already follow, and it keeps this module free of a
 * dependency on another feature package for a one-method interface. Bootstrap
 * injects the same adapter into all three.
 */
export interface IMediaUrlResolver {
    publicUrl(storageRef: string): string | null;
}

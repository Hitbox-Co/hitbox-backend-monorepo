/**
 * Turns a `MediaAsset.storageRef` into a URL a client can render.
 *
 * Needed because the catalog restructure replaced `ProductImage.url` with
 * `ProductImage.assetId` → `MediaAsset`: the row carries an object-storage
 * **key**, and only the media module's storage adapter knows the bucket,
 * region and which prefixes are publicly readable.
 *
 * Products declares a structurally identical port. They are deliberately not
 * shared — each consumer owning its own port is the pattern discover and
 * marketplace already follow, and it keeps collections free of a dependency
 * on products for a one-method interface. Bootstrap injects the same adapter
 * into both.
 *
 * Returns `null` for a key under a private prefix. Product images live under
 * `drop-images/`, which is publicly readable, so in practice this resolves.
 */
export interface IMediaUrlResolver {
    publicUrl(storageRef: string): string | null;
}

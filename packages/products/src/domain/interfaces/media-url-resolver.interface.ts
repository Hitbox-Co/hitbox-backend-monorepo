/**
 * Turns a `MediaAsset.storageRef` into a URL a client can render.
 *
 * Products needs this because the catalog restructure replaced
 * `ProductImage.url` with `ProductImage.assetId` → `MediaAsset`. The row now
 * carries an object-storage **key**, and only the media module's storage
 * adapter knows the bucket, region and which prefixes are publicly readable.
 *
 * A port rather than an import of `@hitbox/media` so products keeps no
 * knowledge of object storage: bootstrap injects an adapter backed by the
 * same `S3ObjectStorage` the media module uses. Returns `null` for a key
 * under a private prefix — those need a per-request signed URL from
 * `GET /admin/media/:assetId/url`, which a public catalog feed cannot issue.
 *
 * Product images live under `drop-images/`, which is publicly readable, so in
 * practice this resolves for every catalog image.
 */
export interface IMediaUrlResolver {
    publicUrl(storageRef: string): string | null;
}

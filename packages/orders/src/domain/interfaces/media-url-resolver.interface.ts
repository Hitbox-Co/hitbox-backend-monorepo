/**
 * Turns a `MediaAsset.storageRef` into a URL a client can render — for the
 * product image on the buyer's order screens.
 *
 * Orders owns its copy of this one-method port, like products, collections
 * and claims do; bootstrap injects the same adapter into all of them. Returns
 * null for a private key. Optional: a deployment without object storage
 * still serves orders, just without images.
 */
export interface IMediaUrlResolver {
    publicUrl(storageRef: string): string | null;
}

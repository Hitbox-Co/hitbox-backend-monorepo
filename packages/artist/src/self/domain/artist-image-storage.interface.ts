/**
 * Port: storing an artist's avatar and cover image.
 *
 * Implemented by @hitbox/media (`mediaModule.profileImages`), which owns
 * `MediaAsset` and the S3 bucket; wired in apps/backend/src/bootstrap.ts.
 * This module never imports media.
 *
 * Optional: on a deployment with no bucket, the image endpoints answer
 * `503 ARTIST_IMAGES_UNAVAILABLE` and the rest of the profile still works.
 */
export interface ArtistImageUploadTicket {
    assetId: string;
    /** Presigned S3 PUT URL — upload the file bytes here. */
    uploadUrl: string;
    /** Seconds until `uploadUrl` stops working. */
    expiresIn: number;
    /** Where the image will be served from once uploaded. */
    publicUrl: string | null;
}

export interface ArtistImageAssetRef {
    id: string;
    assetType: string;
    mimeType: string;
    artistId: string | null;
    archived: boolean;
    virusScanStatus: string;
    publicUrl: string | null;
}

export interface IArtistImageStorage {
    createUpload(input: {
        artistId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ArtistImageUploadTicket>;
    findAsset(assetId: string): Promise<ArtistImageAssetRef | null>;
}

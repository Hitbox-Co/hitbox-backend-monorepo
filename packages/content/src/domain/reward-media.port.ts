/**
 * The files behind a reward, as this module needs them. Media owns
 * `MediaAsset` and the bucket, so it implements this
 * (`mediaModule.exclusiveContent`); content never touches either directly.
 *
 * Files sit under a private prefix. There is no public URL: every view is a
 * short-lived signed link, requested only after this module has decided the
 * caller may see the reward.
 */
export interface RewardUploadTicket {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    requiredHeaders: { 'Content-Type': string };
}

export interface RewardMediaAsset {
    id: string;
    collectionId: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    uploadedById: string;
    archived: boolean;
    infected: boolean;
    /** The bytes are actually in the bucket. */
    uploaded: boolean;
}

export interface RewardMediaLink {
    assetId: string;
    url: string | null;
    expiresIn: number | null;
}

export interface IRewardMedia {
    createUpload(input: {
        collectionId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<RewardUploadTicket>;
    inspect(assetIds: string[]): Promise<RewardMediaAsset[]>;
    links(assetIds: string[]): Promise<RewardMediaLink[]>;
}

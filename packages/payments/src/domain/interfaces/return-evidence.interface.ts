/**
 * What payments needs from the media registry to take photo evidence on a
 * return.
 *
 * Consumer-defined, like every port here: media implements it
 * (`mediaModule.returnEvidence`), bootstrap connects them, neither module
 * imports the other. Optional in the module's deps — a deployment with no
 * bucket cannot hold photos, and a buyer return then fails with a clear 503
 * rather than being accepted without the evidence it requires.
 *
 * Payments decides *who* may attach (the order's buyer, or staff holding the
 * refund grant); media decides *what* a valid file is (type, MIME, size, key)
 * and whether its bytes actually reached the bucket.
 */

export interface ReturnEvidenceUpload {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    requiredHeaders: { 'Content-Type': string };
}

export interface ReturnEvidenceAsset {
    id: string;
    /** The order the upload was issued for. */
    orderId: string | null;
    uploadedById: string;
    archived: boolean;
    infected: boolean;
    /** The bytes are in the bucket — not merely an upload URL was requested. */
    uploaded: boolean;
}

export interface ReturnEvidenceFile {
    assetId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    /** Short-lived signed GET; null when the photo cannot be served. */
    url: string | null;
    expiresIn: number | null;
}

export interface IReturnEvidenceMedia {
    createUpload(input: {
        orderId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<ReturnEvidenceUpload>;
    /** Only return-evidence assets come back; other ids are absent. */
    inspect(assetIds: string[]): Promise<ReturnEvidenceAsset[]>;
    /** In the order given; ids media does not know are skipped. */
    viewFiles(assetIds: string[]): Promise<ReturnEvidenceFile[]>;
}

import { AssetType } from '@hitbox/database';

/**
 * The S3 key convention behind `MediaAsset.storageRef`.
 *
 *   s3://hitbox-media-{env}/
 *     drop-images/products/{productId}/{assetId}.{ext}
 *     profile-images/users/{userId}/{assetId}.{ext}
 *     profile-images/artists/{artistId}/{assetId}.{ext}
 *     exclusive-content/products/{productId}/{assetId}.{ext}
 *     exclusive-content/collections/{collectionId}/{assetId}.{ext}
 *     legal-documents/organizations/{organizationId}/{assetId}.{ext}
 *     supply-spreadsheets/vendors/{vendorId}/{assetId}.{ext}
 *     other/{ownerType}/{ownerId}/{assetId}.{ext}
 *
 * Folder-first-by-type because the three things that differ between asset
 * types are all prefix-shaped: lifecycle policy (exclusive content and legal
 * documents need long retention, profile images can tier down), IAM scoping
 * (support can be granted `profile-images/*` without ever touching
 * `legal-documents/*`), and CDN routing (only the two image types sit behind
 * CloudFront).
 *
 * The filename is the `MediaAsset.id`, never the uploaded filename. That
 * makes the key derivable from the database row alone with no lookup table,
 * makes collisions impossible, and keeps path traversal and information
 * leakage out of a user-supplied string. Only the extension survives.
 *
 * `storageRef` stores the **key**, never a URL — signed-URL policy stays a
 * runtime decision.
 */

export const OwnerType = {
    product: 'product',
    collection: 'collection',
    organization: 'organization',
    artist: 'artist',
    user: 'user',
    vendor: 'vendor',
} as const;
export type OwnerType = (typeof OwnerType)[keyof typeof OwnerType];

const TOP_LEVEL: Record<AssetType, string> = {
    [AssetType.DROP_IMAGE]: 'drop-images',
    [AssetType.PROFILE_IMAGE]: 'profile-images',
    [AssetType.EXCLUSIVE_CONTENT]: 'exclusive-content',
    [AssetType.LEGAL_DOCUMENT]: 'legal-documents',
    [AssetType.SUPPLY_SPREADSHEET]: 'supply-spreadsheets',
    [AssetType.OTHER]: 'other',
};

/** Owner folder segment, pluralised as in the layout above. */
const OWNER_FOLDER: Record<OwnerType, string> = {
    product: 'products',
    collection: 'collections',
    organization: 'organizations',
    artist: 'artists',
    user: 'users',
    vendor: 'vendors',
};

/**
 * Which owner types each asset type accepts. Enforced rather than advisory:
 * a legal document filed under a product id would be invisible to the
 * organization-scoped IAM policy that is supposed to protect it.
 */
export const ALLOWED_OWNERS: Record<AssetType, OwnerType[]> = {
    [AssetType.DROP_IMAGE]: ['product'],
    [AssetType.PROFILE_IMAGE]: ['user', 'artist'],
    [AssetType.EXCLUSIVE_CONTENT]: ['product', 'collection'],
    [AssetType.LEGAL_DOCUMENT]: ['organization'],
    [AssetType.SUPPLY_SPREADSHEET]: ['vendor'],
    [AssetType.OTHER]: ['product', 'collection', 'organization', 'artist', 'user', 'vendor'],
};

export function isOwnerAllowed(assetType: AssetType, ownerType: OwnerType): boolean {
    return ALLOWED_OWNERS[assetType].includes(ownerType);
}

/** `hero.JPG` -> `jpg`. Extension only, lowercased, alphanumerics only. */
export function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    if (dot === -1 || dot === fileName.length - 1) return 'bin';
    const raw = fileName.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'bin';
}

export function buildStorageKey(input: {
    assetType: AssetType;
    ownerType: OwnerType;
    ownerId: string;
    assetId: string;
    fileName: string;
}): string {
    const top = TOP_LEVEL[input.assetType];
    const owner = OWNER_FOLDER[input.ownerType];
    const ext = extensionOf(input.fileName);
    return `${top}/${owner}/${input.ownerId}/${input.assetId}.${ext}`;
}

/** Derived sizes live beside the original so the prefix stays browsable. */
export function derivedKeys(storageRef: string): { thumb: string; card: string } {
    const dot = storageRef.lastIndexOf('.');
    const stem = dot === -1 ? storageRef : storageRef.slice(0, dot);
    const ext = dot === -1 ? '' : storageRef.slice(dot);
    return { thumb: `${stem}-thumb${ext}`, card: `${stem}-card${ext}` };
}

/**
 * Which `MediaAsset` owner column an owner type writes to.
 *
 * `user` and `vendor` map to no column: `uploadedById` already records the
 * user, and a vendor is reached through `SupplyBatch.sourceFileRef`. Returning
 * null keeps that explicit instead of silently dropping the owner.
 */
export function ownerColumn(
    ownerType: OwnerType,
): 'productId' | 'collectionId' | 'organizationId' | 'artistId' | null {
    switch (ownerType) {
        case 'product':
            return 'productId';
        case 'collection':
            return 'collectionId';
        case 'organization':
            return 'organizationId';
        case 'artist':
            return 'artistId';
        default:
            return null;
    }
}

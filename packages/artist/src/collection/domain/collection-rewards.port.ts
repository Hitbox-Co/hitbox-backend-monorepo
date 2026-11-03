/**
 * A collection's reward — the exclusive content a buyer unlocks by
 * collecting every released drop of the collection.
 *
 * The content module owns rewards (ContentBundle, its files, the buyers'
 * unlocks) and implements this (`contentModule.collectionRewards`). The
 * artist module only proves the caller is the artist who owns the collection,
 * then hands over — it never touches those tables.
 * docs/content/collection-rewards.md.
 *
 * The view types are the slice this module reads (for the audit trail); the
 * provider returns more, and the routes pass it through unchanged.
 */
export interface CollectionRewardItem {
    id: string;
    assetId: string;
    kind: string | null;
    title: string;
    position: number;
}

export interface CollectionRewardView {
    id: string;
    collectionId: string;
    name: string;
    description: string | null;
    status: 'ON' | 'OFF' | 'REMOVED';
    isActive: boolean;
    archivedAt: string | null;
    items: CollectionRewardItem[];
    unlockedCount: number;
    requiredDrops: number;
    /**
     * HitBox switched it off or removed it. While `locked`, switching it on or
     * restoring it is refused (409 CONTENT_REWARD_MODERATION_LOCKED).
     */
    moderation?: { locked: boolean; reason: string | null; lockedAt: string | null };
}

export interface CollectionRewardUploadTicket {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    requiredHeaders: { 'Content-Type': string };
    kind: string;
}

export interface ICollectionRewards {
    get(collectionId: string): Promise<CollectionRewardView | null>;
    save(input: {
        collectionId: string;
        name: string;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
    }): Promise<{ reward: CollectionRewardView; created: boolean; restored: boolean; newlyUnlocked: number }>;
    remove(collectionId: string): Promise<CollectionRewardView>;
    createItemUpload(input: {
        collectionId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<CollectionRewardUploadTicket>;
    addItem(input: { collectionId: string; assetId: string; title?: string | null | undefined }): Promise<CollectionRewardView>;
    updateItem(input: { collectionId: string; itemId: string; title: string | null }): Promise<CollectionRewardView>;
    reorderItems(input: { collectionId: string; itemIds: string[] }): Promise<CollectionRewardView>;
    removeItem(input: { collectionId: string; itemId: string }): Promise<CollectionRewardView>;
}

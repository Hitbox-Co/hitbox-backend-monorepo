/**
 * A drop's content — its REGULAR tier (every owner of a unit of the drop
 * opens it) and its EXCLUSIVE tiers (only the owners of the units each one
 * lists, by serial number).
 *
 * The content module owns it (ContentBundle, its files, ContentBundleSerial)
 * and implements this (`contentModule.dropContent`). The artist module only
 * proves the caller is the artist of the drop, then hands over — it never
 * touches those tables. docs/content/drop-content.md.
 *
 * The view types are the slice this module reads (for the audit trail); the
 * provider returns more, and the routes pass it through unchanged.
 */
export type DropContentTier = 'REGULAR' | 'EXCLUSIVE';

export interface DropContentItem {
    id: string;
    assetId: string;
    kind: string | null;
    title: string;
    position: number;
}

export interface DropContentView {
    id: string;
    dropId: string;
    tier: DropContentTier;
    name: string;
    description: string | null;
    status: 'ON' | 'OFF' | 'REMOVED';
    isActive: boolean;
    archivedAt: string | null;
    serialNumbers: number[];
    items: DropContentItem[];
}

export interface DropContentOverview {
    drop: { id: string; name: string; totalSupply: number };
    regular: DropContentView | null;
    exclusive: DropContentView[];
}

export interface DropContentUploadTicket {
    assetId: string;
    uploadUrl: string;
    expiresIn: number;
    requiredHeaders: { 'Content-Type': string };
    kind: string;
}

export interface IDropContent {
    overview(dropId: string): Promise<DropContentOverview>;
    get(dropId: string, bundleId: string): Promise<DropContentView>;
    create(input: {
        dropId: string;
        tier: DropContentTier;
        name: string;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
        serialNumbers?: number[] | undefined;
    }): Promise<DropContentView>;
    update(input: {
        dropId: string;
        bundleId: string;
        name?: string | undefined;
        description?: string | null | undefined;
        isActive?: boolean | undefined;
        serialNumbers?: number[] | undefined;
    }): Promise<DropContentView>;
    remove(input: { dropId: string; bundleId: string }): Promise<{ view: DropContentView; changed: boolean }>;
    restore(input: { dropId: string; bundleId: string }): Promise<DropContentView>;
    createItemUpload(input: {
        dropId: string;
        bundleId: string;
        uploadedById: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<DropContentUploadTicket>;
    addItem(input: { dropId: string; bundleId: string; assetId: string; title?: string | null | undefined }): Promise<DropContentView>;
    updateItem(input: { dropId: string; bundleId: string; itemId: string; title: string | null }): Promise<DropContentView>;
    reorderItems(input: { dropId: string; bundleId: string; itemIds: string[] }): Promise<DropContentView>;
    removeItem(input: { dropId: string; bundleId: string; itemId: string }): Promise<DropContentView>;
}

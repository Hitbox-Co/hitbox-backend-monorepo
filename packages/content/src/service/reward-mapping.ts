import { rewardKindOf } from '../domain/reward-kind';
import type { RewardKind } from '../domain/reward-kind';
import type { IRewardMedia } from '../domain/reward-media.port';
import type { ItemCounts, RewardCollectionRef, RewardItemView, RewardModerationView } from '../dto/reward.views';
import type { RewardItemRow, RewardRow } from '../repository/content.repository';

export function itemCounts(items: RewardItemRow[]): ItemCounts {
    const counts: ItemCounts = { VIDEO: 0, AUDIO: 0, GIF: 0, IMAGE: 0 };
    for (const item of items) {
        const kind = rewardKindOf(item.asset.mimeType);
        if (kind) counts[kind] += 1;
    }
    return counts;
}

export function collectionRef(row: RewardRow): RewardCollectionRef {
    const collection = row.collection!;
    return {
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        heroImageUrl: collection.heroImageUrl,
        artist: { id: collection.artist.id, name: collection.artist.name, slug: collection.artist.slug },
    };
}

/**
 * The items, with a signed link each when `withLinks` — only for someone
 * already allowed to see them. Without media wired, links are null.
 */
export async function itemViews(
    items: RewardItemRow[],
    media: IRewardMedia | undefined,
    withLinks: boolean,
): Promise<RewardItemView[]> {
    const links = withLinks && media
        ? new Map((await media.links(items.map((i) => i.assetId))).map((l) => [l.assetId, l]))
        : new Map();
    return items.map((item) => {
        const link = links.get(item.assetId);
        return {
            id: item.id,
            publicCode: item.publicCode,
            assetId: item.assetId,
            kind: rewardKindOf(item.asset.mimeType) as RewardKind | null,
            title: item.title ?? item.asset.fileName,
            fileName: item.asset.fileName,
            mimeType: item.asset.mimeType,
            sizeBytes: item.asset.sizeBytes,
            position: item.position,
            url: link?.url ?? null,
            expiresIn: link?.expiresIn ?? null,
        };
    });
}

export function moderationOf(row: RewardRow): RewardModerationView {
    return {
        locked: row.moderationLockedAt != null,
        reason: row.moderationReason ?? null,
        lockedAt: row.moderationLockedAt?.toISOString() ?? null,
    };
}

/** A reward a buyer can open: switched on, not removed, on a live collection. */
export function isOpen(row: RewardRow): boolean {
    return row.isActive && row.archivedAt === null && row.collection !== null && row.collection.archivedAt === null;
}

/**
 * @hitbox/content
 *
 * Exclusive content and the unlocks that open it. Built so far: **collection
 * rewards** — exclusive files (video, music, GIFs, images) an artist attaches
 * to a collection, unlocked by a buyer who collects every released drop of
 * it. docs/content/collection-rewards.md.
 */
export const MODULE_NAME = 'content' as const;

export { createContentModule } from './module';
export type { ContentModule, ContentModuleDeps, ContentPermissionGuard } from './module';
export type { ContentUserIdResolver } from './controller/buyer-reward.controller';

export {
    CONTENT_ERROR_CODES,
    CONTENT_EVENTS,
    CONTENT_MODULE,
    MAX_BYTES_BY_KIND,
    MAX_REWARD_ITEMS,
    RELEASED_DROP_STATUSES,
    REWARD_READ_CAPABILITY,
} from './constants/content.constant';
export { REWARD_MIME_TYPES, rewardKindOf } from './domain/reward-kind';
export type { RewardKind } from './domain/reward-kind';
export type {
    IRewardMedia,
    RewardMediaAsset,
    RewardMediaLink,
    RewardUploadTicket,
} from './domain/reward-media.port';
export type {
    AdminRewardDetail,
    AdminRewardRow,
    AdminRewardSummary,
    AdminRewardUnlock,
    RewardModerationView,
    ArtistRewardView,
    BuyerRewardDetail,
    BuyerRewardSummary,
    ItemCounts,
    RewardItemView,
    RewardTeaser,
} from './dto/reward.views';
export { CollectionRewardService } from './service/collection-reward.service';
export type { RewardSaveResult } from './service/collection-reward.service';
export { RewardUnlockService } from './service/reward-unlock.service';

// Staff monitoring and moderation — docs/content/admin-rewards-api.md.
export { AdminRewardService } from './service/admin-reward.service';
export type { ContentStaffActor, ModerationAction } from './service/admin-reward.service';
export {
    adminListRewardsQuerySchema,
    adminRewardUnlocksQuerySchema,
    moderationLiftSchema,
    moderationTakedownSchema,
} from './controller/admin-reward.controller';
export { CONTENT_AUDIT_EVENTS, REWARD_ADMIN_CAPABILITY } from './constants/content.constant';
export type { ContentAuditRecordInput, IContentAuditRecorder } from './domain/content-audit.port';

import { AppError } from '@hitbox/shared';
import { CONTENT_ERROR_CODES, MAX_BYTES_BY_KIND, MAX_REWARD_ITEMS } from '../constants/content.constant';
import { ALL_REWARD_MIME_TYPES, rewardKindOf } from '../domain/reward-kind';
import type { RewardKind } from '../domain/reward-kind';
import type { IRewardMedia, RewardMediaAsset } from '../domain/reward-media.port';

/**
 * The file rules every exclusive-content bundle shares — collection rewards
 * and drop content alike: what a file may be, how big, how many, and whether
 * an uploaded asset may be placed.
 */

/** Before an upload URL is issued: a video, music track, GIF or image, within its size cap. */
export function assertUploadable(mimeType: string, sizeBytes: number): RewardKind {
    const kind = rewardKindOf(mimeType);
    if (!kind) {
        throw AppError.badRequest(
            'A reward file must be a video, a music track, a GIF or an image.',
            CONTENT_ERROR_CODES.FILE_TYPE,
            { allowed: ALL_REWARD_MIME_TYPES },
        );
    }
    const maxBytes = MAX_BYTES_BY_KIND[kind];
    if (sizeBytes > maxBytes) {
        throw AppError.badRequest(
            `A ${kind.toLowerCase()} file can be at most ${Math.round(maxBytes / (1024 * 1024))} MB.`,
            CONTENT_ERROR_CODES.FILE_TYPE,
            { kind, maxBytes },
        );
    }
    return kind;
}

/**
 * Before placing an uploaded file: it exists, was uploaded for this owner
 * (`belongs`), is live, clean, fully uploaded and still a reward file type.
 */
export function assertUsableAsset(
    asset: RewardMediaAsset | undefined,
    assetId: string,
    belongs: (asset: RewardMediaAsset) => boolean,
    notOursWhy: string,
): void {
    const refuse = (why: string): never => {
        throw AppError.badRequest(`That file can't be added: ${why}`, CONTENT_ERROR_CODES.FILE_INVALID, { assetId });
    };
    if (!asset) refuse('it does not exist.');
    if (!belongs(asset!)) refuse(notOursWhy);
    if (asset!.archived) refuse('it has been deleted.');
    if (asset!.infected) refuse('it failed the virus scan.');
    if (!asset!.uploaded) refuse('the upload has not finished — PUT the file to the upload URL first.');
    if (!rewardKindOf(asset!.mimeType)) refuse('it is not a video, music track, GIF or image.');
}

export function assertRoom(itemCount: number): void {
    if (itemCount >= MAX_REWARD_ITEMS) {
        throw AppError.conflict(
            `A reward can hold at most ${MAX_REWARD_ITEMS} files. Remove one first.`,
            CONTENT_ERROR_CODES.TOO_MANY_ITEMS,
            { max: MAX_REWARD_ITEMS },
        );
    }
}

/** A reorder must name every current item exactly once. */
export function assertSameItems(current: string[], given: string[]): void {
    const sameSet =
        given.length === current.length &&
        new Set(given).size === given.length &&
        given.every((id) => current.includes(id));
    if (!sameSet) {
        throw AppError.badRequest(
            'Send every item of the reward exactly once, in the new order.',
            CONTENT_ERROR_CODES.ORDER_MISMATCH,
            { itemIds: current },
        );
    }
}

export function requireMedia(media: IRewardMedia | undefined): IRewardMedia {
    if (!media) {
        // 400, not 503: a 5xx AppError is rendered as an opaque 500.
        throw AppError.badRequest(
            'File uploads are not configured on this server.',
            CONTENT_ERROR_CODES.MEDIA_UNAVAILABLE,
        );
    }
    return media;
}

export function duplicateFile(): AppError {
    return AppError.conflict('That file is already in this reward.', CONTENT_ERROR_CODES.FILE_DUPLICATE);
}

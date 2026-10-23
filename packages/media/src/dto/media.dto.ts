import { AssetType, VirusScanStatus } from '@hitbox/database';
import { z } from 'zod';
import { MEDIA_DEFAULT_LIMIT, MEDIA_MAX_LIMIT } from '../constants/media.constant';
import { OwnerType } from '../domain/storage-key';

export const createUploadUrlSchema = z.object({
    /**
     * Every type except RETURN_EVIDENCE. Return photos are uploaded by the
     * buyer through `POST /refunds/evidence/upload-url`, which proves they own
     * the order first; letting this staff route mint them too would create
     * evidence nobody can attach (the uploader must be the requester) and a
     * second path into a prefix that exists to stay narrow.
     */
    assetType: z
        .nativeEnum(AssetType)
        .refine((type): boolean => type !== AssetType.RETURN_EVIDENCE, {
            message: 'Return photos are uploaded through POST /refunds/evidence/upload-url.',
        }),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    ownerType: z
        .nativeEnum(OwnerType)
        .refine((owner): boolean => owner !== OwnerType.order, {
            message: 'Orders own return photos only — see POST /refunds/evidence/upload-url.',
        }),
    ownerId: z.string().uuid(),
    /**
     * Required, not optional.
     *
     * It is checked against the cap before a URL is issued *and* welded into
     * the signature as `Content-Length`. With no ingest worker behind the
     * upload, those are the only two size checks that exist — an upload with
     * no declared size would be genuinely unbounded, so the request is
     * refused instead. Browsers send `file.size`.
     */
    sizeBytes: z.coerce.number().int().positive(),
});
export type CreateUploadUrlDto = z.infer<typeof createUploadUrlSchema>;

export const listMediaQuerySchema = z.object({
    assetType: z.nativeEnum(AssetType).optional(),
    ownerType: z.nativeEnum(OwnerType).optional(),
    ownerId: z.string().uuid().optional(),
    virusScanStatus: z.nativeEnum(VirusScanStatus).optional(),
    /**
     * Which archive state to list. Defaults to `live` — the media browser
     * shows what is in use, and an archived asset reappearing in it reads as
     * "the delete did not work".
     */
    archived: z.enum(['live', 'archived', 'all']).default('live'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MEDIA_MAX_LIMIT).default(MEDIA_DEFAULT_LIMIT),
});
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;

/** Body of the scanner's completion webhook. */
export const scanResultSchema = z.object({
    assetId: z.string().uuid(),
    virusScanStatus: z.enum([VirusScanStatus.CLEAN, VirusScanStatus.INFECTED]),
    checksum: z.string().max(128).optional(),
    sizeBytes: z.coerce.number().int().nonnegative().optional(),
});
export type ScanResultDto = z.infer<typeof scanResultSchema>;

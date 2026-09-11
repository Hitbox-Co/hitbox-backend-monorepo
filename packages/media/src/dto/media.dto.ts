import { AssetType, VirusScanStatus } from '@hitbox/database';
import { z } from 'zod';
import { MEDIA_DEFAULT_LIMIT, MEDIA_MAX_LIMIT } from '../constants/media.constant';
import { OwnerType } from '../domain/storage-key';

export const createUploadUrlSchema = z.object({
    assetType: z.nativeEnum(AssetType),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    ownerType: z.nativeEnum(OwnerType),
    ownerId: z.string().uuid(),
    /** Declared up front so the cap is enforced before a URL is issued. */
    sizeBytes: z.coerce.number().int().positive().optional(),
});
export type CreateUploadUrlDto = z.infer<typeof createUploadUrlSchema>;

export const listMediaQuerySchema = z.object({
    assetType: z.nativeEnum(AssetType).optional(),
    ownerType: z.nativeEnum(OwnerType).optional(),
    ownerId: z.string().uuid().optional(),
    virusScanStatus: z.nativeEnum(VirusScanStatus).optional(),
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

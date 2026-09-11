import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import { MEDIA_ERROR_CODES } from '../constants/media.constant';
import {
    createUploadUrlSchema,
    listMediaQuerySchema,
    scanResultSchema,
} from '../dto/media.dto';
import type { MediaScopeCheck, MediaService } from '../service/media.service';

/**
 * Resolves the caller's identity and the organizations their grant reaches.
 * Supplied by bootstrap so this module never imports the authorization one.
 */
export type MediaCallerResolver = (
    req: Request,
) => Promise<{ userId: string; organizationIds: string[] | null }>;

export class MediaController {
    constructor(
        private readonly service: MediaService,
        private readonly resolveCaller: MediaCallerResolver,
    ) { }

    /** POST /admin/media/upload-url */
    createUploadUrl: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createUploadUrlSchema.parse(req.body);
        const caller = await this.resolveCaller(req);
        res.status(201).json(
            await this.service.createUploadUrl({
                dto,
                uploadedById: caller.userId,
                scope: scopeCheck(caller.organizationIds),
            }),
        );
    });

    /** GET /admin/media */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listMediaQuerySchema.parse(req.query);
        const caller = await this.resolveCaller(req);
        res.json(await this.service.list(query, scopeCheck(caller.organizationIds)));
    });

    /** GET /admin/media/:assetId/url */
    signedUrl: RequestHandler = asyncHandler(async (req, res) => {
        const caller = await this.resolveCaller(req);
        res.json(
            await this.service.signedUrl(
                req.params.assetId as string,
                scopeCheck(caller.organizationIds),
            ),
        );
    });

    /** DELETE /admin/media/:assetId — soft archive */
    archive: RequestHandler = asyncHandler(async (req, res) => {
        const caller = await this.resolveCaller(req);
        res.json(
            await this.service.archive(
                req.params.assetId as string,
                scopeCheck(caller.organizationIds),
            ),
        );
    });

    /** POST /admin/media/scan-result — called by the scan pipeline. */
    scanResult: RequestHandler = asyncHandler(async (req, res) => {
        const dto = scanResultSchema.parse(req.body);
        await this.service.recordScanResult(dto);
        res.status(204).send();
    });
}

/**
 * Builds the scope check from the caller's reachable organizations.
 *
 * An org-scoped caller attaching an asset to an owner outside their own
 * organization is a 403 — and an owner that resolves to no organization at
 * all is refused too, because "unowned" would otherwise be a hole an
 * org-scoped caller could upload through.
 */
function scopeCheck(organizationIds: string[] | null): MediaScopeCheck {
    return {
        organizationIds,
        assertScope(organizationId) {
            if (organizationIds === null) return;
            if (organizationId === null || !organizationIds.includes(organizationId)) {
                throw AppError.forbidden(
                    'This owner is outside your granted scope.',
                    MEDIA_ERROR_CODES.SCOPE_MISMATCH,
                );
            }
        },
    };
}

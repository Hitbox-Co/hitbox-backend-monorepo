import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    imageUploadRequestSchema,
    setImageSchema,
    updateMyProfileSchema,
    type ArtistImageKind,
} from '../dto/artist-self.dto';
import type { ArtistSelfService } from '../service/artist-self.service';

/** Reads the signed-in account id — injected so this module never imports auth. */
export type ArtistUserIdResolver = (req: Request) => string | undefined;

/** HTTP for /api/v1/artist/me. Parse, delegate, respond. */
export class ArtistSelfController {
    constructor(
        private readonly service: ArtistSelfService,
        private readonly resolveUserId: ArtistUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    /** GET /artist/genres */
    genres: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: this.service.genres() });
    });

    /** GET /artist/me */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.get(this.userId(req)) });
    });

    /** PATCH /artist/me */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateMyProfileSchema.parse(req.body);
        res.json({ data: await this.service.update(this.userId(req), dto) });
    });

    /** POST /artist/me/{avatar|cover}/upload-url */
    createUpload = (kind: ArtistImageKind): RequestHandler =>
        asyncHandler(async (req, res) => {
            const dto = imageUploadRequestSchema.parse(req.body);
            res.status(201).json({ data: await this.service.createImageUpload(this.userId(req), kind, dto) });
        });

    /** PUT /artist/me/{avatar|cover} */
    setImage = (kind: ArtistImageKind): RequestHandler =>
        asyncHandler(async (req, res) => {
            const dto = setImageSchema.parse(req.body);
            res.json({ data: await this.service.setImage(this.userId(req), kind, dto) });
        });

    /** DELETE /artist/me/{avatar|cover} */
    removeImage = (kind: ArtistImageKind): RequestHandler =>
        asyncHandler(async (req, res) => {
            res.json({ data: await this.service.removeImage(this.userId(req), kind) });
        });
}

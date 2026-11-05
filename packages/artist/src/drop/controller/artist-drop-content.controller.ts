import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '@hitbox/shared';
import type { ArtistUserIdResolver } from '../../self/controller/artist-self.controller';
import {
    addRewardItemSchema,
    reorderRewardItemsSchema,
    rewardUploadSchema,
    updateRewardItemSchema,
} from '../../collection/dto/collection-reward.dto';
import { createDropContentSchema, updateDropContentSchema } from '../dto/drop-content.dto';
import type { ArtistDropContentService } from '../service/artist-drop-content.service';

const uuid = z.string().uuid();

/** HTTP for /api/v1/artist/drops/:dropId/content. Parse, delegate, respond. */
export class ArtistDropContentController {
    constructor(
        private readonly service: ArtistDropContentService,
        private readonly resolveUserId: ArtistUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    private ids(req: Request): { dropId: string; bundleId: string } {
        return { dropId: uuid.parse(req.params.dropId), bundleId: uuid.parse(req.params.bundleId) };
    }

    /** GET …/content */
    overview: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.overview(this.userId(req), uuid.parse(req.params.dropId)) });
    });

    /** POST …/content */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createDropContentSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(this.userId(req), uuid.parse(req.params.dropId), dto) });
    });

    /** GET …/content/:bundleId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        res.json({ data: await this.service.get(this.userId(req), dropId, bundleId) });
    });

    /** PATCH …/content/:bundleId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        const dto = updateDropContentSchema.parse(req.body);
        res.json({ data: await this.service.update(this.userId(req), dropId, bundleId, dto) });
    });

    /** DELETE …/content/:bundleId */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        res.json({ data: await this.service.remove(this.userId(req), dropId, bundleId) });
    });

    /** POST …/content/:bundleId/restore */
    restore: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        res.json({ data: await this.service.restore(this.userId(req), dropId, bundleId) });
    });

    /** POST …/content/:bundleId/items/upload-url */
    createItemUpload: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        const dto = rewardUploadSchema.parse(req.body);
        res.status(201).json({ data: await this.service.createItemUpload(this.userId(req), dropId, bundleId, dto) });
    });

    /** POST …/content/:bundleId/items */
    addItem: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        const dto = addRewardItemSchema.parse(req.body);
        res.status(201).json({ data: await this.service.addItem(this.userId(req), dropId, bundleId, dto) });
    });

    /** PUT …/content/:bundleId/items/order */
    reorderItems: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        const dto = reorderRewardItemsSchema.parse(req.body);
        res.json({ data: await this.service.reorderItems(this.userId(req), dropId, bundleId, dto) });
    });

    /** PATCH …/content/:bundleId/items/:itemId */
    updateItem: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        const dto = updateRewardItemSchema.parse(req.body);
        res.json({
            data: await this.service.updateItem(this.userId(req), dropId, bundleId, uuid.parse(req.params.itemId), dto),
        });
    });

    /** DELETE …/content/:bundleId/items/:itemId */
    removeItem: RequestHandler = asyncHandler(async (req, res) => {
        const { dropId, bundleId } = this.ids(req);
        res.json({
            data: await this.service.removeItem(this.userId(req), dropId, bundleId, uuid.parse(req.params.itemId)),
        });
    });
}

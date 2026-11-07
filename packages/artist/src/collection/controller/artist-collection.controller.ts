import type { Request, RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    adminListCollectionsQuerySchema,
    createCollectionSchema,
    listMyCollectionsQuerySchema,
    reorderCollectionsSchema,
    addDropsSchema,
    availableDropsQuerySchema,
    restoreCollectionSchema,
    updateCollectionSchema,
} from '../dto/artist-collection.dto';
import { imageUploadRequestSchema, setImageSchema } from '../../self/dto/artist-self.dto';
import type { ArtistUserIdResolver } from '../../self/controller/artist-self.controller';
import type { ArtistCollectionService } from '../service/artist-collection.service';
import type { ArtistRewardService } from '../service/artist-reward.service';
import {
    addRewardItemSchema,
    reorderRewardItemsSchema,
    rewardUploadSchema,
    saveRewardSchema,
    updateRewardItemSchema,
} from '../dto/collection-reward.dto';

/** HTTP for /api/v1/artist/collections/:collectionId/reward. Parse, delegate, respond. */
export class ArtistRewardController {
    constructor(
        private readonly service: ArtistRewardService,
        private readonly resolveUserId: ArtistUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    private collectionId(req: Request): string {
        return req.params.collectionId as string;
    }

    /** GET …/reward — `data: null` when the collection has no reward yet. */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.get(this.userId(req), this.collectionId(req)) });
    });

    /** PUT …/reward */
    save: RequestHandler = asyncHandler(async (req, res) => {
        const dto = saveRewardSchema.parse(req.body);
        res.json({ data: await this.service.save(this.userId(req), this.collectionId(req), dto) });
    });

    /** DELETE …/reward */
    remove: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.remove(this.userId(req), this.collectionId(req)) });
    });

    /** POST …/reward/items/upload-url */
    createItemUpload: RequestHandler = asyncHandler(async (req, res) => {
        const dto = rewardUploadSchema.parse(req.body);
        res.status(201).json({
            data: await this.service.createItemUpload(this.userId(req), this.collectionId(req), dto),
        });
    });

    /** POST …/reward/items */
    addItem: RequestHandler = asyncHandler(async (req, res) => {
        const dto = addRewardItemSchema.parse(req.body);
        res.status(201).json({ data: await this.service.addItem(this.userId(req), this.collectionId(req), dto) });
    });

    /** PUT …/reward/items/order */
    reorderItems: RequestHandler = asyncHandler(async (req, res) => {
        const dto = reorderRewardItemsSchema.parse(req.body);
        res.json({ data: await this.service.reorderItems(this.userId(req), this.collectionId(req), dto) });
    });

    /** PATCH …/reward/items/:itemId */
    updateItem: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateRewardItemSchema.parse(req.body);
        res.json({
            data: await this.service.updateItem(
                this.userId(req), this.collectionId(req), req.params.itemId as string, dto,
            ),
        });
    });

    /** DELETE …/reward/items/:itemId */
    removeItem: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.removeItem(this.userId(req), this.collectionId(req), req.params.itemId as string),
        });
    });
}

/** HTTP for /api/v1/artist/collections. Parse, delegate, respond. */
export class ArtistCollectionController {
    constructor(
        private readonly service: ArtistCollectionService,
        private readonly resolveUserId: ArtistUserIdResolver,
    ) { }

    private userId(req: Request): string {
        const id = this.resolveUserId(req);
        if (!id) throw AppError.unauthorized('Sign in first.');
        return id;
    }

    private id(req: Request): string {
        return req.params.collectionId as string;
    }

    /** GET /artist/collections */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = listMyCollectionsQuerySchema.parse(req.query);
        res.json({ data: await this.service.listMine(this.userId(req), query) });
    });

    /** POST /artist/collections */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createCollectionSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(this.userId(req), dto) });
    });

    /** PUT /artist/collections/order */
    reorder: RequestHandler = asyncHandler(async (req, res) => {
        const dto = reorderCollectionsSchema.parse(req.body);
        res.json({ data: await this.service.reorder(this.userId(req), dto) });
    });

    /** GET /artist/collections/:collectionId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getMine(this.userId(req), this.id(req)) });
    });

    /** PATCH /artist/collections/:collectionId */
    update: RequestHandler = asyncHandler(async (req, res) => {
        const dto = updateCollectionSchema.parse(req.body);
        res.json({ data: await this.service.update(this.userId(req), this.id(req), dto) });
    });

    /** DELETE /artist/collections/:collectionId — soft archive. */
    archive: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.archive(this.userId(req), this.id(req)) });
    });

    /** POST /artist/collections/:collectionId/restore — undo a delete. */
    restore: RequestHandler = asyncHandler(async (req, res) => {
        const dto = restoreCollectionSchema.parse(req.body ?? {});
        res.json({ data: await this.service.restore(this.userId(req), this.id(req), dto) });
    });

    /** GET /artist/collections/:collectionId/available-drops */
    availableDrops: RequestHandler = asyncHandler(async (req, res) => {
        const query = availableDropsQuerySchema.parse(req.query);
        res.json(await this.service.listAvailableDrops(this.userId(req), this.id(req), query));
    });

    /** POST /artist/collections/:collectionId/drops */
    addDrops: RequestHandler = asyncHandler(async (req, res) => {
        const dto = addDropsSchema.parse(req.body);
        res.json({ data: await this.service.addDrops(this.userId(req), this.id(req), dto) });
    });

    /** DELETE /artist/collections/:collectionId/drops/:dropId */
    removeDrop: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.removeDrop(this.userId(req), this.id(req), req.params.dropId as string) });
    });

    /** POST /artist/collections/:collectionId/hero/upload-url */
    createHeroUpload: RequestHandler = asyncHandler(async (req, res) => {
        const dto = imageUploadRequestSchema.parse(req.body);
        res.status(201).json({ data: await this.service.createHeroUpload(this.userId(req), this.id(req), dto) });
    });

    /** PUT /artist/collections/:collectionId/hero */
    setHero: RequestHandler = asyncHandler(async (req, res) => {
        const dto = setImageSchema.parse(req.body);
        res.json({ data: await this.service.setHero(this.userId(req), this.id(req), dto) });
    });

    /** DELETE /artist/collections/:collectionId/hero */
    removeHero: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.removeHero(this.userId(req), this.id(req)) });
    });
}

/** HTTP for /api/v1/admin/artist-collections — read-only monitoring. */
export class AdminArtistCollectionController {
    constructor(private readonly service: ArtistCollectionService) { }

    /** GET /admin/artist-collections */
    list: RequestHandler = asyncHandler(async (req, res) => {
        const query = adminListCollectionsQuerySchema.parse(req.query);
        res.json(await this.service.adminList(query));
    });

    /** GET /admin/artist-collections/summary */
    summary: RequestHandler = asyncHandler(async (_req, res) => {
        res.json({ data: await this.service.adminSummary() });
    });

    /** GET /admin/artist-collections/:collectionId */
    get: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.adminGet(req.params.collectionId as string) });
    });
}

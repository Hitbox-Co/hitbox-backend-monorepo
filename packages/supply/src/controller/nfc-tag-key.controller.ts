import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { buildSupplyAccess } from '../domain/supply-access';
import type { SupplyAccess } from '../domain/supply-access';
import { generateBatchTagKeysSchema, revokeTagKeysSchema } from '../dto/nfc-tag-key.dto';
import type { SupplyPrincipalResolver } from './supply.controller';
import type { NfcTagKeyService, TagKeyMutationContext } from '../service/nfc-tag-key.service';

export class NfcTagKeyController {
    constructor(
        private readonly service: NfcTagKeyService,
        private readonly resolvePrincipal: SupplyPrincipalResolver,
    ) { }

    /** GET /admin/supply/tags/:tagId/keys — the active key row's metadata, never key material. */
    getActive: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.getActiveKey(await this.access(req), req.params.tagId as string),
        });
    });

    /** POST /admin/supply/tags/:tagId/keys — plaintext keys in this response only. */
    generate: RequestHandler = asyncHandler(async (req, res) => {
        const data = await this.service.generateTagKeys(
            await this.mutation(req),
            req.params.tagId as string,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ data });
    });

    /** POST /admin/supply/batches/:batchId/tag-keys — CSV of keys in this response only. */
    generateForBatch: RequestHandler = asyncHandler(async (req, res) => {
        const dto = generateBatchTagKeysSchema.parse(req.body ?? {});
        const data = await this.service.generateKeysForBatch(
            await this.mutation(req),
            req.params.batchId as string,
            dto,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ data });
    });

    /** POST /admin/supply/tag-keys/:nfcTagKeyId/personalize */
    personalize: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.markTagPersonalized(
                await this.mutation(req),
                req.params.nfcTagKeyId as string,
            ),
        });
    });

    /** POST /admin/supply/tags/:tagId/keys/revoke */
    revoke: RequestHandler = asyncHandler(async (req, res) => {
        const dto = revokeTagKeysSchema.parse(req.body);
        res.json({
            data: await this.service.revokeTagKeys(
                await this.mutation(req),
                req.params.tagId as string,
                dto,
            ),
        });
    });

    private async access(req: Request): Promise<SupplyAccess> {
        return buildSupplyAccess(await this.resolvePrincipal(req));
    }

    private async mutation(req: Request): Promise<TagKeyMutationContext> {
        const correlated = req as Request & { correlationId?: string };
        return {
            access: await this.access(req),
            correlationId: correlated.correlationId ?? randomUUID(),
        };
    }
}

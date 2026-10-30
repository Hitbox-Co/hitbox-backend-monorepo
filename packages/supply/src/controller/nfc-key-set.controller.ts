import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { buildSupplyAccess } from '../domain/supply-access';
import type { SupplyAccess } from '../domain/supply-access';
import {
    createKeySetSchema,
    listKeySetsQuerySchema,
    personaliseTagsSchema,
    retireKeySetSchema,
} from '../dto/nfc-key-set.dto';
import type { SupplyPrincipalResolver } from './supply.controller';
import type { KeySetMutationContext, NfcKeySetService } from '../service/nfc-key-set.service';

export class NfcKeySetController {
    constructor(
        private readonly service: NfcKeySetService,
        private readonly resolvePrincipal: SupplyPrincipalResolver,
    ) { }

    /** GET /admin/supply/key-sets — never returns key material. */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json({
            data: await this.service.listKeySets(
                await this.access(req),
                listKeySetsQuerySchema.parse(req.query),
            ),
        });
    });

    /**
     * POST /admin/supply/key-sets — the one response that carries plaintext
     * keys. `no-store` keeps it out of any cache between here and the operator.
     */
    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createKeySetSchema.parse(req.body);
        const data = await this.service.createKeySet(await this.mutation(req), dto);
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ data });
    });

    /** POST /admin/supply/key-sets/:keySetId/personalise */
    personalise: RequestHandler = asyncHandler(async (req, res) => {
        const dto = personaliseTagsSchema.parse(req.body);
        res.json({
            data: await this.service.personaliseBatchTags(
                await this.mutation(req),
                req.params.keySetId as string,
                dto,
            ),
        });
    });

    /** POST /admin/supply/key-sets/:keySetId/retire */
    retire: RequestHandler = asyncHandler(async (req, res) => {
        const dto = retireKeySetSchema.parse(req.body);
        res.json({
            data: await this.service.retireKeySet(
                await this.mutation(req),
                req.params.keySetId as string,
                dto,
            ),
        });
    });

    private async access(req: Request): Promise<SupplyAccess> {
        return buildSupplyAccess(await this.resolvePrincipal(req));
    }

    private async mutation(req: Request): Promise<KeySetMutationContext> {
        const correlated = req as Request & { correlationId?: string };
        return {
            access: await this.access(req),
            correlationId: correlated.correlationId ?? randomUUID(),
        };
    }
}

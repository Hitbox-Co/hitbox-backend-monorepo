import type { RequestHandler } from 'express';
import { AppError, asyncHandler } from '@hitbox/shared';
import {
    addressIdParamSchema,
    createAddressSchema,
    updateAddressSchema,
} from '../dto/address.dto';
import type { AddressService } from '../service/address.service';

/** `/users/me/addresses`: every handler is scoped to the signed-in caller. */
export class AddressController {
    constructor(private readonly service: AddressService) { }

    private caller(req: Parameters<RequestHandler>[0]): string {
        const auth = req.auth;
        if (!auth) throw AppError.unauthorized();
        return auth.accountId;
    }

    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.list(this.caller(req)) });
    });

    create: RequestHandler = asyncHandler(async (req, res) => {
        const dto = createAddressSchema.parse(req.body);
        res.status(201).json({ data: await this.service.create(this.caller(req), dto) });
    });

    get: RequestHandler = asyncHandler(async (req, res) => {
        const { id } = addressIdParamSchema.parse(req.params);
        res.json({ data: await this.service.get(this.caller(req), id) });
    });

    update: RequestHandler = asyncHandler(async (req, res) => {
        const { id } = addressIdParamSchema.parse(req.params);
        const patch = updateAddressSchema.parse(req.body);
        res.json({ data: await this.service.update(this.caller(req), id, patch) });
    });

    /** DELETE archives (soft delete) and answers 204. */
    archive: RequestHandler = asyncHandler(async (req, res) => {
        const { id } = addressIdParamSchema.parse(req.params);
        await this.service.archive(this.caller(req), id);
        res.status(204).end();
    });

    setDefault: RequestHandler = asyncHandler(async (req, res) => {
        const { id } = addressIdParamSchema.parse(req.params);
        res.json({ data: await this.service.setDefault(this.caller(req), id) });
    });
}

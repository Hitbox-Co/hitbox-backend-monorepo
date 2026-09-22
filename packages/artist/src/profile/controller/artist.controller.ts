import type { RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { listArtistsQuerySchema } from '../dto/artist.dto';
import type { ArtistService } from '../service/artist.service';

export class ArtistController {
    constructor(private readonly service: ArtistService) { }

    /** GET /admin/artists */
    list: RequestHandler = asyncHandler(async (req, res) => {
        res.json(await this.service.list(listArtistsQuerySchema.parse(req.query)));
    });

    /** GET /admin/artists/:artistId */
    getById: RequestHandler = asyncHandler(async (req, res) => {
        res.json({ data: await this.service.getById(req.params.artistId as string) });
    });
}

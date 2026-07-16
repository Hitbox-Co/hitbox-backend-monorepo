import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '@hitbox/shared';
import type { AuthWebhookService } from '../service/auth-webhook.service';

/** app.ts captures the raw body for signature verification (see express.json verify). */
type RequestWithRawBody = Request & { rawBody?: Buffer };

export class AuthController {
    constructor(private readonly webhookService: AuthWebhookService) { }

    /** POST /auth/webhooks/clerk */
    handleClerkWebhook: RequestHandler = asyncHandler(async (req, res) => {
        const rawBody =
            (req as RequestWithRawBody).rawBody?.toString('utf8') ?? JSON.stringify(req.body);

        await this.webhookService.processClerkWebhook(rawBody, {
            'svix-id': req.header('svix-id') ?? '',
            'svix-timestamp': req.header('svix-timestamp') ?? '',
            'svix-signature': req.header('svix-signature') ?? '',
        });

        res.status(200).json({ received: true });
    });

    /** GET /auth/me — the authenticated principal (requireAuth runs first). */
    me = (req: Request, res: Response): void => {
        res.json({ data: req.auth });
    };
}

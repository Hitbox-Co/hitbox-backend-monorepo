import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '@hitbox/shared';
import type { WebhookService } from '../service/webhook.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

/**
 * The provider's endpoint.
 *
 * Unauthenticated by design — Stripe has no HitBox session — which is exactly
 * why the signature is the gate. The raw bytes come from `req.rawBody`, which
 * `app.ts` captures in `express.json({ verify })`: re-serialising `req.body`
 * would produce different bytes and every signature would fail.
 */
export class WebhookController {
    constructor(private readonly service: WebhookService) { }

    /** POST /webhooks/payments/stripe */
    stripe: RequestHandler = asyncHandler(async (req, res) => {
        const rawBody =
            (req as RequestWithRawBody).rawBody ??
            Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

        const outcome = await this.service.handleStripe({
            rawBody,
            signatureHeader: req.header('stripe-signature'),
        });

        // 200 with a body that says what happened. A replay is a success from
        // the provider's point of view — it delivered, we have it — and
        // returning anything else makes Stripe retry a delivery that is
        // already recorded.
        res.status(200).json(outcome);
    });
}

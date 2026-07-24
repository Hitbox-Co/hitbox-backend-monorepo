import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '@hitbox/shared';
import { registrationValidationSchema } from '../dto/registration.dto';
import type { AuthWebhookService } from '../service/auth-webhook.service';
import type { RegistrationService } from '../service/registration.service';

/** app.ts captures the raw body for signature verification (see express.json verify). */
type RequestWithRawBody = Request & { rawBody?: Buffer };

export class AuthController {
    constructor(
        private readonly webhookService: AuthWebhookService,
        private readonly registrationService: RegistrationService,
    ) { }

    /**
     * POST /auth/registration/validate — pre-flight check the client runs
     * before Clerk sign-up. Zod → 422 VALIDATION_ERROR on bad input;
     * 409 AUTH_EMAIL_TAKEN if the email already has an account.
     */
    validateRegistration: RequestHandler = asyncHandler(async (req, res) => {
        const input = registrationValidationSchema.parse(req.body);
        res.json({ data: await this.registrationService.validate(input) });
    });

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

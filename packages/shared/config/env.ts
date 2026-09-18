import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 * Fails fast at boot with a readable report instead of crashing at
 * request-time with `undefined is not a string`.
 */

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'qa', 'pre-production', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Database — optional here: only the mobile app (@hitbox/database) needs
    // it, and it reads process.env.DATABASE_URL directly via Prisma's own
    // datasource block. Other apps sharing this schema (e.g. the public
    // website, which uses its own separate database) don't need it set.
    DATABASE_URL: z.string().url().optional(),

    // Clerk — optional here for the same reason: only @hitbox/auth (mobile
    // app) uses Clerk. It asserts these are present itself (createAuthModule)
    // so a missing key fails loudly at the module that actually needs it,
    // not at every app that merely imports @hitbox/shared.
    CLERK_SECRET_KEY: z.string().min(1).optional(),
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
    CLERK_AUTHORIZED_PARTIES: z.string().optional(),

    // Redis — backs the distributed rate limiter (and future cache/queue).
    // Optional: when unset the limiter falls back to per-instance memory.
    REDIS_URL: z.string().url().optional(),

    // Rate limiting — a client may make up to RATE_LIMIT_MAX requests per
    // RATE_LIMIT_WINDOW_MS. Defaults: 100 requests / 60s ≈ 1.6 req/sec.
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    // TEMPORARY demo auth — when "true" (and NODE_ENV != production), requests
    // may authenticate via an `X-Demo-User: <email>` header instead of Clerk.
    // Remove/disable before production.
    DEMO_AUTH_ENABLED: z.string().optional(),

    // Public website (lead capture) — served on this SAME server at
    // /app/web/v1, not a separate app, but its own database. Optional here
    // for the same reason as DATABASE_URL: @hitbox/leads' Prisma schema
    // reads these directly; this is only a fail-fast convenience.
    LEADS_DATABASE_URL: z.string().url().optional(),
    LEADS_DIRECT_URL: z.string().url().optional(),
    // Salt for hashing client IPs before storage (see @hitbox/leads).
    // Not a security-critical secret — its only job is to make a
    // precomputed-table attack pointless, not gate access — so a missing
    // value gets a startup warning and a dev-only fallback, not a hard exit.
    IP_HASH_SALT: z.string().min(1).optional(),

    // ── Media storage (optional) ────────────────────────────────────────────
    // Absent on a deploy that does not serve uploads; the media routes are
    // then not mounted at all rather than mounted and failing at runtime.
    //
    // AWS credentials are deliberately NOT declared here. The SDK resolves
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the process environment
    // itself (Railway service variables in production). Naming them in this
    // schema would invite passing them around as values and logging them in
    // the validation error report.
    MEDIA_S3_BUCKET: z.string().optional(),
    MEDIA_S3_REGION: z.string().optional(),
    /**
     * Set for MinIO or another S3-compatible endpoint. **Local development
     * only** — setting it in production also switches on path-style
     * addressing and redirects every public URL away from S3.
     */
    MEDIA_S3_ENDPOINT: z.string().url().optional(),
    /**
     * Origin serving the publicly readable prefixes (`drop-images/`,
     * `profile-images/`), no trailing slash. Defaults to the bucket's
     * regional S3 endpoint; set it to a CloudFront domain to move public
     * image traffic onto a CDN without touching code.
     */
    MEDIA_S3_PUBLIC_BASE_URL: z.string().url().optional(),

    /**
     * Where Clerk sends an invited staff member after they accept — the admin
     * dashboard's sign-up completion route. Optional: Clerk falls back to the
     * instance's own configured URL, which is the right default for a single
     * dashboard. Set it when the dashboard is on its own domain.
     */
    ADMIN_INVITATION_REDIRECT_URL: z.string().url().optional(),
    /**
     * How long a staff invitation stays claimable, in hours. Short by default:
     * an invitation is a standing offer of privilege, and one that sits unused
     * for a fortnight is more likely to be a stale mailbox than a colleague who
     * has not got round to it.
     */
    ADMIN_INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),

    // ── Tax & invoicing (optional) ──────────────────────────────────────────
    // HitBox's own identity as a supplier, per jurisdiction. Deployment
    // identity rather than business data: a staging deploy must not print a
    // production GSTIN on an invoice, and an environment variable is the
    // cheapest way to guarantee that. @hitbox/tax asserts what it needs itself
    // — a country with no profile simply cannot have invoices issued in it,
    // which fails at issue time with a clear error rather than at boot.
    //
    // Addresses are pipe-separated, one line per segment:
    //   TAX_SUPPLIER_IN_ADDRESS="4th Floor, Prestige Atrium|Bengaluru 560001|India"
    //
    // Bank account numbers are deliberately absent. HitBox is paid through the
    // gateway before the invoice exists, so the document is a receipt, not a
    // request for payment — printing an account number on every customer PDF
    // would be a fraud surface for no benefit.
    /** India: HitBox's GSTIN. Without it, no Indian invoice can be issued. */
    TAX_SUPPLIER_IN_GSTIN: z.string().min(1).optional(),
    TAX_SUPPLIER_IN_PAN: z.string().min(1).optional(),
    TAX_SUPPLIER_IN_NAME: z.string().min(1).optional(),
    TAX_SUPPLIER_IN_ADDRESS: z.string().min(1).optional(),
    TAX_SUPPLIER_IN_PHONE: z.string().min(1).optional(),
    /** US: HitBox's EIN. Best practice rather than law — see docs/tax/. */
    TAX_SUPPLIER_US_EIN: z.string().min(1).optional(),
    TAX_SUPPLIER_US_NAME: z.string().min(1).optional(),
    TAX_SUPPLIER_US_ADDRESS: z.string().min(1).optional(),
    TAX_SUPPLIER_US_PHONE: z.string().min(1).optional(),
    /** Printed in the "FROM" block of every invoice, both jurisdictions. */
    TAX_SUPPLIER_EMAIL: z.string().email().optional(),
    /**
     * Overrides the logo on the invoice PDF. Absolute path to a PNG; defaults
     * to the one bundled in @hitbox/tax. A missing file degrades to a text
     * wordmark rather than failing — an invoice without a logo is still valid.
     */
    TAX_INVOICE_LOGO_PATH: z.string().min(1).optional(),
    /**
     * Separate KMS key for tax documents. Optional: the bucket's default
     * encryption already covers them, and this exists for the case where W-9s
     * and invoices need a different key from the rest of the bucket.
     */
    TAX_S3_KMS_KEY_ID: z.string().min(1).optional(),

    // ── Payments (optional) ─────────────────────────────────────────────────
    // Absent on a deploy that takes no money. @hitbox/payments asserts what it
    // needs itself (createPaymentsModule), same pattern as Clerk above: a
    // missing webhook secret fails at the module that requires it rather than
    // at every app that merely imports @hitbox/shared.
    //
    // Gateway API keys are deliberately NOT declared here. They live in the
    // secrets manager and PaymentGatewayConfig stores only a pointer
    // (`credentialsRef`) — naming them in this schema would invite passing
    // them around as values and printing them in the validation report.
    /**
     * Stripe's webhook signing secret (`whsec_…`). Required to accept
     * `/webhooks/payments/stripe`; without it the route is not mounted at all,
     * because an unverified payment webhook is a way to mark any order paid.
     */
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * How far a webhook's timestamp may be from now, in seconds. Stripe's own
     * default is 300; the window is what stops a captured delivery being
     * replayed indefinitely.
     */
    PAYMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
    /**
     * How long a checkout holds a serialized unit before the sweeper releases
     * it. Long enough for a 3-D Secure challenge, short enough that a
     * abandoned basket does not keep a one-of-500 unit off sale for an hour.
     */
    INVENTORY_HOLD_SECONDS: z.coerce.number().int().positive().default(900),
});

export type Env = z.infer<typeof envSchema>;


let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
    if (cached) return cached;

    const result = envSchema.safeParse(source);
    if (!result.success) {
        const report = result.error.issues
            .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
        // eslint-disable-next-line no-console
        console.error(`Invalid environment configuration:\n${report}`);
        process.exit(1);
    }

    cached = result.data;
    return cached;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isQA = env.NODE_ENV === 'qa';

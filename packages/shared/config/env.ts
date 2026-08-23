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

    // Database 
    DATABASE_URL: z.string().url(),

    // Clerk
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
    CLERK_AUTHORIZED_PARTIES: z.string().optional(),

    // Redis — backs the distributed rate limiter (and future cache/queue).
    // Optional: when unset the limiter falls back to per-instance memory.
    REDIS_URL: z.string().url().optional(),

    // Rate limiting — a client may make up to RATE_LIMIT_MAX requests per
    // RATE_LIMIT_WINDOW_MS. Defaults: 100 requests / 60s ≈ 1.6 req/sec.
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

    // ── Authorization (see docs/authorization/07-caching.md) ──────────────
    // L2 (Redis) TTL for a user's effective-permission snapshot. Also the
    // upper bound on staleness if an invalidation message is ever lost.
    AUTHZ_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // L1 (in-process) TTL. Pub/sub normally clears L1 within milliseconds of a
    // change; this is the fallback bound. Set to 0 to disable the L1 tier.
    AUTHZ_LOCAL_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),
    // How recently a Clerk factor must have been verified for a sensitive
    // (step-up) capability to be usable.
    AUTHZ_STEP_UP_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(15),

    // ── CORS, per API surface (see docs/authorization/11-api-surfaces.md) ─
    // Comma-separated origin allowlists. When a list is unset that surface
    // falls back to allowing any origin, which is the pre-existing behaviour —
    // set them in production.
    // e.g. https://hitbox.com,https://www.hitbox.com
    CORS_APP_ORIGINS: z.string().optional(),
    // e.g. https://admin.hitbox.com
    CORS_ADMIN_ORIGINS: z.string().optional(),
    // e.g. https://productmanager.hitbox.com
    CORS_MANAGE_ORIGINS: z.string().optional(),
    // TEMPORARY demo auth — when "true" (and NODE_ENV != production), requests
    // may authenticate via an `X-Demo-User: <email>` header instead of Clerk.
    // Remove/disable before production.
    DEMO_AUTH_ENABLED: z.string().optional(),
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

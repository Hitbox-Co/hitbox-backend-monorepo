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

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

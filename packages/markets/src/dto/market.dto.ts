import { Currency } from '@hitbox/database';
import { z } from 'zod';
import { MARKETS_DEFAULT_LIMIT, MARKETS_MAX_LIMIT } from '../constants/markets.constant';

/** ISO 3166-1 alpha-2, upper-cased. `countryCode` is globally unique. */
const countryCode = z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'Two letters, ISO 3166-1 alpha-2')
    .transform((value) => value.toUpperCase());

export const listMarketsQuerySchema = z.object({
    /** Omit to list live markets only; `true` includes archived ones. */
    includeArchived: z.coerce.boolean().default(false),
    isActive: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MARKETS_MAX_LIMIT).default(MARKETS_DEFAULT_LIMIT),
});
export type ListMarketsQuery = z.infer<typeof listMarketsQuerySchema>;

export const createMarketSchema = z.object({
    /** Short stable key, e.g. `IN`, `US`. Unique, upper-cased. */
    code: z
        .string()
        .trim()
        .min(2)
        .max(12)
        .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, "_" and "-" only')
        .transform((value) => value.toUpperCase()),
    name: z.string().trim().min(1).max(120),
    currency: z.nativeEnum(Currency),
    isActive: z.boolean().default(true),
    /**
     * Promoting a market to default demotes the previous one in the same
     * transaction — exactly one row carries it at any time.
     */
    isDefault: z.boolean().default(false),
    /** Countries resolving to this market. Each belongs to exactly one. */
    countryCodes: z.array(countryCode).max(300).default([]),
});
export type CreateMarketDto = z.infer<typeof createMarketSchema>;

/**
 * `code` is omitted: it is the market's stable identifier, referenced by
 * dashboards and reports, and renaming it silently would break every saved
 * view. Create a new market instead.
 */
export const updateMarketSchema = createMarketSchema
    .omit({ code: true })
    .partial()
    .strict();
export type UpdateMarketDto = z.infer<typeof updateMarketSchema>;

export interface MarketResponse {
    id: string;
    code: string;
    name: string;
    currency: Currency;
    isActive: boolean;
    isDefault: boolean;
    countryCodes: string[];
    /** Live references — non-zero means a delete will be refused. */
    usage: { productPrices: number; orders: number };
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

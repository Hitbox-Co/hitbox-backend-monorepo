import { z } from 'zod';
import {
    ARTIST_BIO_MAX,
    ARTIST_NAME_MAX,
    ARTIST_SLUG_MAX,
    ARTIST_SLUG_MIN,
    ARTIST_SLUG_RE,
} from '../../self/constants/artist-self.constant';
import {
    ARTIST_REASON_MAX,
    TOP_ARTISTS_DEFAULT,
    TOP_ARTISTS_MAX,
    TOP_DROPS_DEFAULT,
    TOP_DROPS_MAX,
} from '../constants/artist-admin.constant';
import type { ArtistAccountStatus, ArtistSalesRank, ArtistStats } from '../domain/artist-insights.port';

/** `""` and `null` both clear an optional text field. */
const clearableText = (max: number) =>
    z
        .union([z.string(), z.null()])
        .transform((value) => {
            const trimmed = value?.trim() ?? '';
            return trimmed === '' ? null : trimmed;
        })
        .pipe(z.string().max(max).nullable());

const booleanish = z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

/**
 * PATCH /admin/artists/:artistId — a staff edit. Send only what changes.
 *
 * `.strict()`: state (`isActive`, `isPublic`, `archivedAt`) has its own
 * actions, and the account / organization links are not editable here, so a
 * body naming them is refused instead of silently ignored.
 */
export const staffUpdateArtistSchema = z
    .object({
        name: z.string().trim().min(1).max(ARTIST_NAME_MAX),
        slug: z
            .string()
            .trim()
            .toLowerCase()
            .min(ARTIST_SLUG_MIN)
            .max(ARTIST_SLUG_MAX)
            .regex(ARTIST_SLUG_RE, 'Use lowercase letters, digits and single hyphens (e.g. the-midnight-club)'),
        bio: clearableText(ARTIST_BIO_MAX),
        /** A code or label from GET /artist/genres; `null` clears it. */
        genre: z.union([z.string().trim().min(1).max(64), z.null()]),
        /** Staff can take an image down; putting one up is the artist's upload flow. */
        avatarUrl: z.null(),
        coverUrl: z.null(),
        /** `true` records that HitBox checked the artist's compliance (now, by you); `false` withdraws it. */
        complianceAttested: booleanish,
        /** Why — kept in the audit trail. */
        reason: z.string().trim().min(1).max(ARTIST_REASON_MAX),
    })
    .partial()
    .strict()
    .refine((value): boolean => Object.keys(value).some((key) => key !== 'reason'), {
        message: 'Send at least one field to change',
    });
export type StaffUpdateArtistDto = z.infer<typeof staffUpdateArtistSchema>;

/** POST /admin/artists/:artistId/{action} — the body is optional. */
export const artistStateActionSchema = z
    .object({
        reason: z.string().trim().min(1).max(ARTIST_REASON_MAX).optional(),
    })
    .strict();
export type ArtistStateActionDto = z.infer<typeof artistStateActionSchema>;

/** GET /admin/artists/:artistId/stats */
export const artistStatsQuerySchema = z
    .object({
        period: z.enum(['week', 'month', 'year', 'custom']).default('year'),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        topDrops: z.coerce.number().int().min(1).max(TOP_DROPS_MAX).default(TOP_DROPS_DEFAULT),
    })
    .refine((q): boolean => q.period !== 'custom' || (q.from !== undefined && q.to !== undefined), {
        message: 'from and to are required when period=custom',
        path: ['from'],
    });
export type ArtistStatsQuery = z.infer<typeof artistStatsQuerySchema>;

/** GET /admin/artists/summary */
export const artistSummaryQuerySchema = z
    .object({
        organizationId: z.string().uuid().optional(),
        top: z.coerce.number().int().min(1).max(TOP_ARTISTS_MAX).default(TOP_ARTISTS_DEFAULT),
    })
    .strict();
export type ArtistSummaryQuery = z.infer<typeof artistSummaryQuerySchema>;

// ── Responses ────────────────────────────────────────────────────────────────

/** The full staff view of one artist. */
export interface StaffArtistProfile {
    id: string;
    publicCode: string | null;
    name: string;
    slug: string;
    bio: string | null;
    genre: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    isPublic: boolean;
    isActive: boolean;
    archivedAt: string | null;
    /** True when the artist can edit their own profile (active, not archived). */
    editable: boolean;
    /** The artist's sign-in account, or null while the invitation is unaccepted. */
    account: {
        userId: string;
        email: string;
        fullName: string | null;
        isActive: boolean;
        /** When the account was created — the date the artist joined HitBox. */
        joinedAt: string;
    } | null;
    /** The staff invitation the profile was created from, if any. */
    invitationId: string | null;
    organization: { id: string; name: string; type: string } | null;
    /** Commercial links to brands. */
    brandLinks: {
        id: string;
        organizationId: string;
        organizationName: string;
        linkType: string;
        startDate: string;
        endDate: string | null;
        isActive: boolean;
    }[];
    compliance: {
        attested: boolean;
        attestedAt: string | null;
        /** User id of the staff member who attested. */
        attestedById: string | null;
    };
    /** Payout and tax status. Null when the reporting adapter isn't wired. */
    payouts: ArtistAccountStatus['payouts'] | null;
    tax: ArtistAccountStatus['tax'] | null;
    counts: { drops: number; collections: number; followers: number; claims: number };
    createdAt: string;
    updatedAt: string;
}

export type StaffArtistStats = ArtistStats & { artistId: string; moneyVisible: boolean };

export interface ArtistDirectorySummary {
    /** Live (not archived) artists. Every figure below counts live artists only, except `archived`. */
    total: number;
    active: number;
    inactive: number;
    public: number;
    unlisted: number;
    archived: number;
    /** Created since the 1st of this month (UTC). */
    newThisMonth: number;
    withoutAvatar: number;
    withoutBio: number;
    /** No sign-in account linked yet (invitation not accepted). */
    withoutAccount: number;
    /** Compliance not attested. */
    withoutCompliance: number;
    moneyVisible: boolean;
    /** Best sellers by units sold, all time. Null when the reporting adapter isn't wired. */
    topBySales:
        | (ArtistSalesRank & { name: string; slug: string; avatarUrl: string | null })[]
        | null;
}

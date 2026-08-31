import type { WaitlistSubscriber } from '../client';
import type { ServerContext } from '../dto/common.dto';
import type { WaitlistSubmitDto } from '../dto/waitlist.dto';
import type { WaitlistRepository } from '../repository/waitlist.repository';
import { normalizeToStringArray } from '../utils/normalize-array';

export class WaitlistService {
    constructor(private readonly repo: WaitlistRepository) { }

    /**
     * `rawBody` is the UNVALIDATED request body, captured separately from
     * `dto` — Zod silently drops keys it doesn't recognize, so storing the
     * validated dto in rawPayload would defeat the whole point of the
     * column (docs §2.2: "anything unmapped is gone for good").
     */
    async subscribe(
        dto: WaitlistSubmitDto,
        ctx: ServerContext,
        rawBody: unknown,
    ): Promise<WaitlistSubscriber> {
        const emailNormalized = dto.email.trim().toLowerCase();
        const sourcePage = dto.sourcePage ?? ctx.refererFallback ?? undefined;

        // undefined (not sent) is passed through as-is so a repeat signup
        // via a narrower form variant (e.g. the footer, which never sends
        // interests) does not wipe interests recorded by an earlier
        // full-page signup — Prisma leaves an undefined update field
        // untouched, and falls back to the schema's @default([]) on create.
        const interests = dto.interests === undefined ? undefined : normalizeToStringArray(dto.interests);
        const musicGenres =
            dto.musicGenres === undefined ? undefined : normalizeToStringArray(dto.musicGenres);

        const shared = {
            email: dto.email,
            emailNormalized,
            firstName: dto.firstName,
            lastName: dto.lastName,
            country: dto.country,
            stateRegion: dto.stateRegion,
            city: dto.city,
            ageRange: dto.ageRange,
            interests,
            musicGenres,
            referralSource: dto.referralSource,
            utmSource: dto.utmSource,
            utmMedium: dto.utmMedium,
            utmCampaign: dto.utmCampaign,
            utmContent: dto.utmContent,
            utmTerm: dto.utmTerm,
            sourcePage,
            ipHash: ctx.ipHash,
            userAgentSummary: ctx.userAgentSummary,
            rawPayload: rawBody as object,
        };

        return this.repo.upsertByEmail(
            emailNormalized,
            {
                ...shared,
                consentVersion: ctx.consentVersion,
                consentTimestamp: ctx.consentTimestamp,
            },
            // Repeat signup: refresh the fields above but never touch
            // consentVersion/consentTimestamp (stays pinned to the FIRST
            // time consent was recorded) or status/opt-in progress.
            shared,
        );
    }
}

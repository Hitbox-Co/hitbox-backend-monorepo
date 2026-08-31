import type { ArtistLead } from '../client';
import type { ArtistInquirySubmitDto } from '../dto/artist-lead.dto';
import type { ServerContext } from '../dto/common.dto';
import type { ArtistLeadRepository } from '../repository/artist-lead.repository';
import { parseSocialLinks } from '../utils/social-links';

export class ArtistLeadService {
    constructor(private readonly repo: ArtistLeadRepository) { }

    submit(dto: ArtistInquirySubmitDto, ctx: ServerContext, rawBody: unknown): Promise<ArtistLead> {
        // `socials` is a free-text textarea, not a URL field (docs §2.3) —
        // best-effort parse; the raw text survives regardless in rawPayload.
        const { primary, additional } = parseSocialLinks(dto.socials);

        return this.repo.create({
            artistName: dto.artistName,
            primaryCategory: dto.primaryCategory,
            country: dto.country,
            website: dto.website,
            primarySocialUrl: primary ?? undefined,
            additionalSocialUrls: additional,
            // Form field is `name` — schema column is `contactName`.
            contactName: dto.name,
            contactRole: dto.contactRole,
            // Form field is `email` — schema column is `contactEmail`.
            contactEmail: dto.email,
            // Form field is `phone` — schema column is `contactPhone`.
            contactPhone: dto.phone,
            // Form field is `management` — schema column is `managementCompany`.
            managementCompany: dto.management,
            // Form field is `label` — schema column is `recordLabel`.
            recordLabel: dto.label,
            // Form field is `projectIdea` — schema column is `collaborationDescription`.
            collaborationDescription: dto.projectIdea,
            // Form field `collectibleType` is a single value; schema column
            // is a String[] — wrapped into a one-element array (docs §2.3).
            collectibleFormats: dto.collectibleType ? [dto.collectibleType] : [],
            timeline: dto.timeline,
            authorizedConfirmation: dto.authorizedConfirmation,
            // Form field is `additional` — schema column is `additionalNotes`.
            additionalNotes: dto.additional,
            sourcePage: dto.sourcePage ?? ctx.refererFallback ?? undefined,
            utmSource: dto.utmSource,
            utmMedium: dto.utmMedium,
            utmCampaign: dto.utmCampaign,
            ipHash: ctx.ipHash,
            consentVersion: ctx.consentVersion,
            consentTimestamp: ctx.consentTimestamp,
            rawPayload: rawBody as object,
        });
    }
}

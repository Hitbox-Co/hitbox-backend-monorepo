import type { PartnerLead } from '../client';
import type { BusinessInquirySubmitDto } from '../dto/partner-lead.dto';
import type { ServerContext } from '../dto/common.dto';
import type { PartnerLeadRepository } from '../repository/partner-lead.repository';

export class PartnerLeadService {
    constructor(private readonly repo: PartnerLeadRepository) { }

    submit(dto: BusinessInquirySubmitDto, ctx: ServerContext, rawBody: unknown): Promise<PartnerLead> {
        return this.repo.create({
            // Form field is `company` — schema column is `companyName`.
            companyName: dto.company,
            // Form field is `name` — schema column is `contactName`.
            contactName: dto.name,
            jobTitle: dto.jobTitle,
            // Form field is `email` — schema column is `workEmail`.
            workEmail: dto.email,
            phone: dto.phone,
            country: dto.country,
            partnershipType: dto.partnershipType,
            // Form field is `website` — schema column is `companyWebsite`.
            companyWebsite: dto.website,
            companySize: dto.companySize,
            linkedinUrl: dto.linkedinUrl,
            // `companyDescription` is a distinct question from
            // `relevantCapabilities` (docs §2.2) — not mapped to it.
            companyDescription: dto.companyDescription,
            // Form field is `projectDetails` — schema column is `message`.
            message: dto.projectDetails,
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

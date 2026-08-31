import { z } from 'zod';
import { requestContextSchema } from './common.dto';

/**
 * Matches BusinessPartnerForm. Field names differ from the schema — mapped
 * in the service layer (docs §3): company→companyName, name→contactName,
 * email→workEmail, website→companyWebsite, projectDetails→message,
 * additional→additionalNotes.
 *
 * `jobTitle` and `website` are optional ON THE FORM even though the
 * original schema draft had them non-null — both are nullable columns here
 * (docs §2.1). `companyDescription` is a distinct question from
 * `relevantCapabilities` (docs §2.2) — stored in its own column.
 */
export const businessInquirySubmitSchema = requestContextSchema.extend({
    company: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255),
    jobTitle: z.string().trim().max(150).optional(),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(50).optional(),
    country: z.string().trim().min(1).max(100),
    partnershipType: z.string().trim().min(1).max(100),
    website: z.string().trim().url().max(500).optional(),
    companyDescription: z.string().trim().optional(),
    projectDetails: z.string().trim().min(1),
    additional: z.string().trim().optional(),

    // Not on the form yet — forward-compatible placeholders.
    companySize: z.string().trim().max(50).optional(),
    linkedinUrl: z.string().trim().url().max(500).optional(),
});

export type BusinessInquirySubmitDto = z.infer<typeof businessInquirySubmitSchema>;

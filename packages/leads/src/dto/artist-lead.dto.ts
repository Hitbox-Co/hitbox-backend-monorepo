import { z } from 'zod';
import { requestContextSchema } from './common.dto';

/**
 * Matches ArtistInquiryForm. Several field names differ from the schema —
 * mapped in the service layer (docs §3): name→contactName, email→
 * contactEmail, phone→contactPhone, management→managementCompany, label→
 * recordLabel, projectIdea→collaborationDescription, additional→
 * additionalNotes.
 *
 * `socials` is free text (parsed into primarySocialUrl/additionalSocialUrls
 * — see utils/social-links.ts). `collectibleType` is a single value, wrapped
 * into the one-element `collectibleFormats` array in the service layer.
 *
 * primaryCategory / contactRole / authorizedConfirmation are NOT on the form
 * today (docs §2.1) — accepted here so no API change is needed once they
 * are; until then they arrive undefined and the corresponding columns stay
 * null.
 */
export const artistInquirySubmitSchema = requestContextSchema.extend({
    artistName: z.string().trim().min(1).max(255),
    country: z.string().trim().min(1).max(100),
    website: z.string().trim().url().max(500).optional(),
    socials: z.string().trim().optional(),
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(50).optional(),
    management: z.string().trim().max(255).optional(),
    label: z.string().trim().max(255).optional(),
    projectIdea: z.string().trim().min(1),
    collectibleType: z.string().trim().max(100).optional(),
    timeline: z.string().trim().max(100).optional(),
    additional: z.string().trim().optional(),

    // Not on the form yet (docs §2.1) — forward-compatible placeholders.
    primaryCategory: z.string().trim().max(100).optional(),
    contactRole: z.string().trim().max(100).optional(),
    authorizedConfirmation: z.boolean().optional(),
});

export type ArtistInquirySubmitDto = z.infer<typeof artistInquirySubmitSchema>;

// Module factory
export { createLeadsModule } from './module';
export type { LeadsModule } from './module';

// PrismaClient singleton — for graceful-shutdown $disconnect() in apps/web's
// server.ts. Feature code should go through the module/service layer, not
// this directly.
export { leadsPrisma } from './client';

// Constants
export { CURRENT_CONSENT_VERSION, LEADS_ERROR_CODES, LEADS_MODULE } from './constants/leads.constant';

// DTOs
export { waitlistSubmitSchema } from './dto/waitlist.dto';
export type { WaitlistSubmitDto } from './dto/waitlist.dto';
export { contactSubmitSchema } from './dto/contact.dto';
export type { ContactSubmitDto } from './dto/contact.dto';
export { artistInquirySubmitSchema } from './dto/artist-lead.dto';
export type { ArtistInquirySubmitDto } from './dto/artist-lead.dto';
export { businessInquirySubmitSchema } from './dto/partner-lead.dto';
export type { BusinessInquirySubmitDto } from './dto/partner-lead.dto';

// Generated Prisma types (enums etc.) — modules outside this package should
// import them from here, never reach into src/generated directly.
export { LeadStatus, LeadPriority, WaitlistStatus } from './client';

import { Router } from 'express';
import { leadsPrisma } from './client';
import { LeadCaptureController } from './controller/lead-capture.controller';
import { ArtistLeadRepository } from './repository/artist-lead.repository';
import { ContactRepository } from './repository/contact.repository';
import { PartnerLeadRepository } from './repository/partner-lead.repository';
import { WaitlistRepository } from './repository/waitlist.repository';
import { ArtistLeadService } from './service/artist-lead.service';
import { ContactService } from './service/contact.service';
import { PartnerLeadService } from './service/partner-lead.service';
import { WaitlistService } from './service/waitlist.service';

export interface LeadsModule {
    router: Router;
}

/**
 * No deps needed today — this module owns its own PrismaClient (a separate
 * database from the mobile platform's), unlike every other module in this
 * monorepo which receives a shared PrismaClient from bootstrap.
 */
export function createLeadsModule(): LeadsModule {
    const waitlist = new WaitlistService(new WaitlistRepository(leadsPrisma));
    const contact = new ContactService(new ContactRepository(leadsPrisma));
    const artistLead = new ArtistLeadService(new ArtistLeadRepository(leadsPrisma));
    const partnerLead = new PartnerLeadService(new PartnerLeadRepository(leadsPrisma));

    const controller = new LeadCaptureController({ waitlist, contact, artistLead, partnerLead });

    const router = Router();
    router.post('/waitlist', controller.waitlist);
    router.post('/contact', controller.contact);
    router.post('/artist-inquiry', controller.artistInquiry);
    router.post('/business-inquiry', controller.businessInquiry);

    return { router };
}

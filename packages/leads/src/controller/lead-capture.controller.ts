import type { Request, RequestHandler } from 'express';
import { asyncHandler, createModuleLogger, env } from '@hitbox/shared';
import { CURRENT_CONSENT_VERSION } from '../constants/leads.constant';
import { artistInquirySubmitSchema } from '../dto/artist-lead.dto';
import type { ServerContext } from '../dto/common.dto';
import { contactSubmitSchema } from '../dto/contact.dto';
import { businessInquirySubmitSchema } from '../dto/partner-lead.dto';
import { waitlistSubmitSchema } from '../dto/waitlist.dto';
import type { ArtistLeadService } from '../service/artist-lead.service';
import type { ContactService } from '../service/contact.service';
import type { PartnerLeadService } from '../service/partner-lead.service';
import type { WaitlistService } from '../service/waitlist.service';
import { extractClientIp, hashIp } from '../utils/ip-hash';
import { summarizeUserAgent } from '../utils/user-agent-summary';

const logger = createModuleLogger('leads:controller');

let warnedMissingSalt = false;
function ipSalt(): string {
    if (env.IP_HASH_SALT) return env.IP_HASH_SALT;
    if (!warnedMissingSalt) {
        logger.warn('IP_HASH_SALT is not set — using an insecure dev-only fallback. Set it before production.');
        warnedMissingSalt = true;
    }
    return 'dev-only-insecure-salt';
}

function buildServerContext(req: Request): ServerContext {
    const ip = extractClientIp(req);
    return {
        ipHash: hashIp(ip, ipSalt()),
        userAgentSummary: summarizeUserAgent(req.header('user-agent')),
        consentVersion: CURRENT_CONSENT_VERSION,
        consentTimestamp: new Date(),
        refererFallback: req.header('referer') ?? null,
    };
}

interface LeadCaptureControllerDeps {
    waitlist: WaitlistService;
    contact: ContactService;
    artistLead: ArtistLeadService;
    partnerLead: PartnerLeadService;
}

export class LeadCaptureController {
    constructor(private readonly deps: LeadCaptureControllerDeps) { }

    /** POST /waitlist */
    waitlist: RequestHandler = asyncHandler(async (req, res) => {
        const dto = waitlistSubmitSchema.parse(req.body);
        const subscriber = await this.deps.waitlist.subscribe(dto, buildServerContext(req), req.body);
        res.status(201).json({ data: { id: subscriber.id, status: subscriber.status } });
    });

    /** POST /contact */
    contact: RequestHandler = asyncHandler(async (req, res) => {
        const dto = contactSubmitSchema.parse(req.body);
        const submission = await this.deps.contact.submit(dto, buildServerContext(req), req.body);
        res.status(201).json({ data: { id: submission.id } });
    });

    /** POST /artist-inquiry */
    artistInquiry: RequestHandler = asyncHandler(async (req, res) => {
        const dto = artistInquirySubmitSchema.parse(req.body);
        const lead = await this.deps.artistLead.submit(dto, buildServerContext(req), req.body);
        res.status(201).json({ data: { id: lead.id } });
    });

    /** POST /business-inquiry */
    businessInquiry: RequestHandler = asyncHandler(async (req, res) => {
        const dto = businessInquirySubmitSchema.parse(req.body);
        const lead = await this.deps.partnerLead.submit(dto, buildServerContext(req), req.body);
        res.status(201).json({ data: { id: lead.id } });
    });
}

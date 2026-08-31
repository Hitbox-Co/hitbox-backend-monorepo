import type { ContactSubmission } from '../client';
import type { ContactSubmitDto } from '../dto/contact.dto';
import type { ServerContext } from '../dto/common.dto';
import type { ContactRepository } from '../repository/contact.repository';

export class ContactService {
    constructor(private readonly repo: ContactRepository) { }

    submit(dto: ContactSubmitDto, ctx: ServerContext, rawBody: unknown): Promise<ContactSubmission> {
        return this.repo.create({
            name: dto.name,
            email: dto.email,
            company: dto.company,
            phone: dto.phone,
            // Form field is `subject` — schema column is `topic`.
            topic: dto.subject,
            message: dto.message,
            sourcePage: dto.sourcePage ?? ctx.refererFallback ?? undefined,
            ipHash: ctx.ipHash,
            consentVersion: ctx.consentVersion,
            consentTimestamp: ctx.consentTimestamp,
            rawPayload: rawBody as object,
        });
    }
}

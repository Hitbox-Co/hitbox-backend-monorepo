import type { Prisma, PrismaClient, PartnerLead } from '../client';

export class PartnerLeadRepository {
    constructor(private readonly prisma: PrismaClient) { }

    create(data: Prisma.PartnerLeadCreateInput): Promise<PartnerLead> {
        return this.prisma.partnerLead.create({ data });
    }
}

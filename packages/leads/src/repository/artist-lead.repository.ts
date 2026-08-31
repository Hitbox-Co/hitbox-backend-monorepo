import type { ArtistLead, Prisma, PrismaClient } from '../client';

export class ArtistLeadRepository {
    constructor(private readonly prisma: PrismaClient) { }

    create(data: Prisma.ArtistLeadCreateInput): Promise<ArtistLead> {
        return this.prisma.artistLead.create({ data });
    }
}

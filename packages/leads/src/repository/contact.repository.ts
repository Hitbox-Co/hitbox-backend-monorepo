import type { ContactSubmission, Prisma, PrismaClient } from '../client';

export class ContactRepository {
    constructor(private readonly prisma: PrismaClient) { }

    create(data: Prisma.ContactSubmissionCreateInput): Promise<ContactSubmission> {
        return this.prisma.contactSubmission.create({ data });
    }
}

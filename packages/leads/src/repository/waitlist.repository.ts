import type { Prisma, PrismaClient, WaitlistSubscriber } from '../client';

export class WaitlistRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /**
     * Open decision (docs §6.2, resolved): upsert rather than reject on a
     * duplicate email. A marketing waitlist silently refreshing a repeat
     * signup's interests/name is the common, low-friction default (and
     * avoids surfacing a raw unique-constraint error to the visitor);
     * switch to reject-with-a-friendly-message here if product wants that
     * instead — it's a one-method change.
     */
    upsertByEmail(
        emailNormalized: string,
        create: Prisma.WaitlistSubscriberCreateInput,
        update: Prisma.WaitlistSubscriberUpdateInput,
    ): Promise<WaitlistSubscriber> {
        return this.prisma.waitlistSubscriber.upsert({
            where: { emailNormalized },
            create,
            update,
        });
    }
}

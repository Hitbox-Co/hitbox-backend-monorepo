import type { PrismaClient } from '@hitbox/database';

/**
 * Finance's side of the `IPayoutLookup` port that @hitbox/tax declares.
 *
 * It exists because of one rule, and the rule is worth restating where the
 * query lives: **Form 16A and 1099-NEC report royalty income that was *paid*,
 * not royalty that accrued** (compliance guide §8.3, ratified 2026-09-15).
 *
 * So both filters below key on `status: 'PAID'` and on `paidAt`, never on the
 * royalty ledger and never on `scheduledAt`. A quarter that is approved but
 * whose transfer has not executed is not reportable; a quarter still pending
 * approval, or rejected, is excluded from the filing entirely and carries
 * forward to the next approved cycle.
 *
 * The interface is not imported — it is structural, because finance is the
 * provider here. Bootstrap checks the shapes by assignment.
 */
export class PayoutReportingAdapter {
    constructor(private readonly prisma: PrismaClient) { }

    async findById(payoutId: string) {
        const payout = await this.prisma.royaltyPayout.findUnique({
            where: { id: payoutId },
            select: SELECT,
        });
        return payout ? present(payout) : null;
    }

    async findPaidForArtist(input: { artistId: string; from: Date; to: Date }) {
        const payouts = await this.prisma.royaltyPayout.findMany({
            where: {
                payeeArtistId: input.artistId,
                status: 'PAID',
                // Half-open on `paidAt`: "paid in the calendar year" is what
                // the form says, so a payout approved in December and executed
                // in January belongs to January's year.
                paidAt: { gte: input.from, lt: input.to },
            },
            select: SELECT,
            orderBy: { paidAt: 'asc' },
        });
        return payouts.map(present);
    }
}

const SELECT = {
    id: true,
    payeeArtistId: true,
    amount: true,
    currency: true,
    status: true,
    approvedById: true,
    approvedAt: true,
    paidAt: true,
} as const;

function present(payout: {
    id: string;
    payeeArtistId: string | null;
    amount: { toFixed(places: number): string };
    currency: string;
    status: string;
    approvedById: string | null;
    approvedAt: Date | null;
    paidAt: Date | null;
}) {
    return {
        payoutId: payout.id,
        payeeArtistId: payout.payeeArtistId,
        amount: payout.amount.toFixed(2),
        currency: payout.currency,
        status: payout.status,
        approvedById: payout.approvedById,
        approvedAt: payout.approvedAt,
        paidAt: payout.paidAt,
    };
}

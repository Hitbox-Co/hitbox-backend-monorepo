import type { PrismaClient } from '@hitbox/database';

/**
 * Artist's side of the `IArtistOwnership` port that @hitbox/tax declares.
 *
 * The question it answers is small but load-bearing: `payment-royalty:read:own`
 * grants a caller "your own records", and the records in the tax module belong
 * to an **artist**, not to a user. Somebody has to translate one into the other,
 * and the module that owns the `Artist` table is the only one that should.
 *
 * The interface is not imported — it is structural, because artist is the
 * provider here and a provider importing its consumer's types has the
 * dependency arrow backwards. Bootstrap checks the two shapes by assignment.
 *
 * Returns an array even though `Artist.userId` is unique and it can therefore
 * hold at most one id today. That is deliberate: the caller's question is "which
 * artists may this user act for", and the day a manager acts for several
 * artists, the answer changes here and nowhere else.
 */
export class ArtistOwnershipAdapter {
    constructor(private readonly prisma: PrismaClient) { }

    async findArtistIdsForUser(userId: string): Promise<string[]> {
        const artists = await this.prisma.artist.findMany({
            // An archived artist's tax paperwork stays readable by them: a
            // 1099-NEC for last year is still their filing evidence, whatever
            // the state of the profile today.
            where: { userId },
            select: { id: true },
        });
        return artists.map((artist) => artist.id);
    }
}

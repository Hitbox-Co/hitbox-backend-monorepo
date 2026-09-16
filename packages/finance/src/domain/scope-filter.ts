import type { Prisma } from '@hitbox/database';
import type { FinanceAccess } from './finance-access';
import { FinanceScope } from './finance-access';

/**
 * The caller's grant, turned into a WHERE clause.
 *
 * One implementation for every finance read, because the rule is identical
 * everywhere and the cost of getting it wrong in one place is another party's
 * revenue on someone's screen. The three tables differ only in the column
 * names, so the shape is generated rather than retyped.
 *
 * `NO_MATCH` is the deliberate fail-closed value: an OWN-scoped caller with no
 * artist profile gets a filter that matches nothing, not an empty filter that
 * matches everything. A refactor that loses the artist lookup therefore
 * returns zero rows instead of the whole platform's earnings.
 */
const NO_MATCH = '00000000-0000-0000-0000-000000000000';

export type ArtistIdResolver = (userId: string) => Promise<string | null>;

/**
 * ORG scope reaches two things: royalties owed to the organization itself, and
 * royalties owed to artists that organization manages (`Artist.organizationId`).
 * A brand that signed an artist can see what that artist has earned on the
 * brand's own drops — that is the point of a brand dashboard — but nothing
 * about an artist it does not manage.
 */
export async function royaltyEntryScope(
    access: FinanceAccess,
    resolveArtistId: ArtistIdResolver,
): Promise<Prisma.RoyaltyLedgerEntryWhereInput> {
    if (access.scope === FinanceScope.GLOBAL) return {};
    if (access.scope === FinanceScope.ORGANIZATION) {
        const orgIds = access.organizationIds ?? [];
        return {
            OR: [
                { payeeOrganizationId: { in: orgIds } },
                { payeeArtist: { organizationId: { in: orgIds } } },
            ],
        };
    }
    const artistId = await resolveArtistId(access.userId);
    return { payeeArtistId: artistId ?? NO_MATCH };
}

export async function payoutScope(
    access: FinanceAccess,
    resolveArtistId: ArtistIdResolver,
): Promise<Prisma.RoyaltyPayoutWhereInput> {
    if (access.scope === FinanceScope.GLOBAL) return {};
    if (access.scope === FinanceScope.ORGANIZATION) {
        const orgIds = access.organizationIds ?? [];
        return {
            OR: [
                { payeeOrganizationId: { in: orgIds } },
                { payeeArtist: { organizationId: { in: orgIds } } },
            ],
        };
    }
    const artistId = await resolveArtistId(access.userId);
    return { payeeArtistId: artistId ?? NO_MATCH };
}

/**
 * The platform ledger and adjustments are HitBox's own books: gateway fees,
 * chargebacks, margin. There is no per-artist slice of them that would mean
 * anything, so anything less than GLOBAL is confined to the caller's own
 * organizations through the order — and an OWN-scoped caller sees none of it.
 */
export function financeEntryScope(
    access: FinanceAccess,
): Prisma.FinanceLedgerEntryWhereInput {
    if (access.scope === FinanceScope.GLOBAL) return {};
    if (access.scope === FinanceScope.ORGANIZATION) {
        return { order: { organizationId: { in: access.organizationIds ?? [] } } };
    }
    return { id: NO_MATCH };
}

export function adjustmentScope(access: FinanceAccess): Prisma.AdjustmentEntryWhereInput {
    if (access.scope === FinanceScope.GLOBAL) return {};
    if (access.scope === FinanceScope.ORGANIZATION) {
        return { order: { organizationId: { in: access.organizationIds ?? [] } } };
    }
    return { id: NO_MATCH };
}

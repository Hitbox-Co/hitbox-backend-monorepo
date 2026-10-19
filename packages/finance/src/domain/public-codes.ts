import type { PrismaClient } from '@hitbox/database';

/**
 * The models whose `publicCode` finance responses carry. Every one of them has
 * a nullable `publicCode` column; a row without a code resolves to null, and
 * the console falls back.
 */
export type CodedModel =
    | 'order'
    | 'royaltyLedgerEntry'
    | 'financeLedgerEntry'
    | 'paymentTransaction'
    | 'royaltyPayout'
    | 'artist'
    | 'organization'
    | 'drop'
    | 'artistCollection'
    | 'royaltyRule';

export type CodeLookup = Partial<Record<CodedModel, (string | null | undefined)[]>>;

/** id → publicCode, per model. Missing ids and uncoded rows both read as null. */
export class ResolvedCodes {
    constructor(private readonly maps: Partial<Record<CodedModel, Map<string, string | null>>>) { }

    get(model: CodedModel, id: string | null | undefined): string | null {
        if (!id) return null;
        return this.maps[model]?.get(id) ?? null;
    }
}

/**
 * Batch publicCode lookups for response shaping.
 *
 * Views are built from rows that carry internal ids (some of them plain ids
 * with no relation, like `adjustsEntryId` or an adjustment's polymorphic
 * `targetId`), so the codes are resolved here, once per page, in one query per
 * model — never one query per row.
 */
export class PublicCodeResolver {
    constructor(private readonly prisma: PrismaClient) { }

    async resolve(lookup: CodeLookup): Promise<ResolvedCodes> {
        const maps: Partial<Record<CodedModel, Map<string, string | null>>> = {};
        const prisma = this.prisma as unknown as Record<
            CodedModel,
            {
                findMany(args: {
                    where: { id: { in: string[] } };
                    select: { id: true; publicCode: true };
                }): Promise<{ id: string; publicCode: string | null }[]>;
            }
        >;

        await Promise.all(
            (Object.keys(lookup) as CodedModel[]).map(async (model) => {
                const ids = [...new Set((lookup[model] ?? []).filter((id): id is string => !!id))];
                const map = new Map<string, string | null>();
                maps[model] = map;
                if (ids.length === 0) return;
                const rows = await prisma[model].findMany({
                    where: { id: { in: ids } },
                    select: { id: true, publicCode: true },
                });
                for (const row of rows) map.set(row.id, row.publicCode);
            }),
        );
        return new ResolvedCodes(maps);
    }
}

/** Maps an adjustment's polymorphic `targetType` to the model that holds the target. */
export const ADJUSTMENT_TARGET_MODEL: Record<string, CodedModel> = {
    ROYALTY_LEDGER_ENTRY: 'royaltyLedgerEntry',
    FINANCE_LEDGER_ENTRY: 'financeLedgerEntry',
    ORDER: 'order',
    PAYMENT_TRANSACTION: 'paymentTransaction',
    ROYALTY_PAYOUT: 'royaltyPayout',
};

/**
 * Retires a market, the same way `DELETE /admin/markets/:id` does.
 *
 *   pnpm db:remove-market -- UK            # report only
 *   pnpm db:remove-market -- UK --apply    # do it
 *
 * ── Retired, not deleted ────────────────────────────────────────────────────
 *
 * A market is archived, never removed: `Market` carries `isActive` and
 * `archivedAt` precisely so it can stop being sellable while the orders placed
 * in it still resolve. Deleting the row would break every historical order that
 * names it — and you cannot un-sell something. `MarketService.archive` is the
 * authority here and this mirrors it exactly:
 *
 *   - the default market is refused (promote another one first);
 *   - `isActive=false`, `isDefault=false`, `archivedAt=now`;
 *   - the country mappings are **deleted**, which frees those country codes to
 *     be remapped to a live market — otherwise buyers there resolve to a market
 *     nobody can reach.
 *
 * ── Why the prices have to go first ─────────────────────────────────────────
 *
 * The service refuses to archive while any `DropPrice` still points at the
 * market, and the reason is in its own comment: a price row on an unreachable
 * market reads to an operator as "this drop has no price" rather than as a
 * misconfiguration. Marking them DISABLED is not enough — the guard counts
 * rows, not statuses — so they are deleted here, which is the operator action
 * the service is telling you to take.
 *
 * ── What is deliberately left alone ─────────────────────────────────────────
 *
 * `Order.marketId` keeps pointing at the archived market. Those are snapshots
 * of what was actually sold, in the currency it was actually sold in, and the
 * royalty and finance ledgers are denominated against them. Rewriting or
 * deleting them would make the books disagree with themselves.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/index';

const APPLY = process.argv.includes('--apply');
const code = process.argv.slice(2).find((a) => !a.startsWith('--'))?.toUpperCase();

async function main(): Promise<void> {
    if (!code) {
        console.error('Usage: pnpm db:remove-market -- <MARKET_CODE> [--apply]\n');
        const all = await prisma.market.findMany({
            select: { code: true, name: true, isDefault: true, archivedAt: true },
            orderBy: { code: 'asc' },
        });
        console.error('Markets in this database:');
        for (const m of all) {
            console.error(
                `  ${m.code.padEnd(5)} ${m.name.padEnd(18)}` +
                `${m.isDefault ? ' (default)' : ''}${m.archivedAt ? ' (archived)' : ''}`,
            );
        }
        process.exitCode = 1;
        return;
    }

    const market = await prisma.market.findFirst({
        where: { code },
        include: { _count: { select: { dropPrices: true, orders: true, marketCountrys: true } } },
    });

    if (!market) {
        console.error(`No market with code "${code}".`);
        process.exitCode = 1;
        return;
    }
    if (market.archivedAt) {
        console.log(`✔ ${market.code} (${market.name}) is already archived — nothing to do.`);
        return;
    }
    // Same refusal as the service: something has to be sellable.
    if (market.isDefault) {
        console.error(
            `${market.code} is the default market and cannot be retired.\n` +
            'Promote another market to default first.',
        );
        process.exitCode = 1;
        return;
    }

    const countries = await prisma.marketCountry.findMany({
        where: { marketId: market.id },
        select: { countryCode: true },
    });
    const preferring = await prisma.user.count({ where: { preferredMarketId: market.id } });
    const ordersByStatus = await prisma.order.groupBy({
        by: ['status'],
        where: { marketId: market.id },
        _count: true,
    });

    console.log(`${APPLY ? 'Retiring' : 'Would retire'} ${market.code} — ${market.name} (${market.currency})\n`);
    console.log(`  drop prices deleted      ${market._count.dropPrices}`);
    console.log(`  countries freed          ${countries.map((c) => c.countryCode).join(', ') || 'none'}`);
    console.log(`  users' preference clear  ${preferring}`);
    console.log(`  orders KEPT              ${market._count.orders}` +
        (ordersByStatus.length
            ? `  (${ordersByStatus.map((o) => `${o._count} ${o.status}`).join(', ')})`
            : ''));

    if (!APPLY) {
        console.log('\nNothing was written. Re-run with --apply to make these changes.');
        return;
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
        // Prices first — the archive guard counts them, and a price on an
        // unreachable market is worse than no price at all.
        await tx.dropPrice.deleteMany({ where: { marketId: market.id } });
        // Nobody should be filed under a market that no longer sells: null
        // means "no preference", which falls back to the default market.
        await tx.user.updateMany({
            where: { preferredMarketId: market.id },
            data: { preferredMarketId: null },
        });
        await tx.market.update({
            where: { id: market.id },
            data: { isActive: false, isDefault: false, archivedAt: now, updatedAt: now },
        });
        // Free the country codes so they can be remapped to a live market.
        await tx.marketCountry.deleteMany({ where: { marketId: market.id } });
    });

    const after = await prisma.market.findUnique({
        where: { id: market.id },
        include: { _count: { select: { dropPrices: true, orders: true, marketCountrys: true } } },
    });
    console.log(`\n✔ ${market.code} retired`);
    console.log(`  isActive=${after?.isActive}  isDefault=${after?.isDefault}  archivedAt=${after?.archivedAt?.toISOString()}`);
    console.log(`  prices=${after?._count.dropPrices}  countries=${after?._count.marketCountrys}  orders=${after?._count.orders} (kept)`);
    console.log('\nIt no longer appears in market listings, and those country codes are free to remap.');
}

main()
    .catch((error) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
            console.error(
                '✖ a foreign key still references this market.\n' +
                '  Nothing was changed — the whole retirement runs in one transaction.',
            );
        } else {
            console.error('✖ remove-market failed:', error);
        }
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

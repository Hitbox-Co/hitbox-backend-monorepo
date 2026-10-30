/**
 * Puts a claimed TEST unit back to "unclaimed", so its tag can be claimed again.
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/reset-test-claim.ts            # dry run
 *   pnpm --filter @hitbox/backend exec tsx scripts/reset-test-claim.ts --apply    # do it
 *   ... --sku NFC-TEST-786-000001                                                 # which unit (default)
 *
 * DELETES NOTHING. It runs the platform's own claim revocation — the same path a
 * refund uses — which:
 *   - stamps the claim as revoked (the claim row stays: it happened),
 *   - clears the owner and sets the unit back to UNCLAIMED,
 *   - closes the ownership period and archives the owner's shelf entry,
 *   - appends a FLAG row to the ledger (the CLAIM row stays; history is kept).
 *
 * Deliberately NOT reset:
 *   - the chip's tap counter. Rolling it back would make URLs the server has
 *     already seen valid again. A fresh tap always has a higher counter, so the
 *     next tap works without it.
 *   - the keys. They stay exactly as they are, on the chip and in the database.
 *
 * Only units of the NFC-TEST-… dummy product are accepted, so this cannot be
 * pointed at a real customer's item by mistake. Refuses to run in production.
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
config({ path: resolve(root, '.env.local'), quiet: true });
config({ path: resolve(root, '.env'), quiet: true });

if (process.env.NODE_ENV === 'production') {
    console.error('\n✗ Refusing to run with NODE_ENV=production.\n');
    process.exit(1);
}
process.env.NODE_ENV = 'qa'; // quiet query logging

const { prisma } = await import('@hitbox/database');
const { eventBus } = await import('@hitbox/shared');
const { createClaimsModule } = await import('@hitbox/claims');

const APPLY = process.argv.includes('--apply');
const skuArg = process.argv.indexOf('--sku');
const skuCode = skuArg > -1 ? process.argv[skuArg + 1] : 'NFC-TEST-786-000001';
const TEST_PREFIX = 'NFC-TEST-';

const mask = (email: string | null | undefined) => (email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : '—');

async function describe(label: string) {
    const sku = await prisma.sku.findFirst({
        where: { skuCode },
        select: {
            id: true,
            skuCode: true,
            claimedStatus: true,
            owner: { select: { email: true } },
            currentNfcTag: { select: { nfcTagCode: true, lifecycleState: true, lastTapCounter: true } },
            skuClaims: { select: { claimedNo: true, revokedAt: true } },
        },
    });
    if (!sku) return null;
    console.log(`\n${label}`);
    console.log(`  unit     ${sku.skuCode}  →  ${sku.claimedStatus}, owner ${mask(sku.owner?.email)}`);
    console.log(
        `  claims   ${sku.skuClaims.length} total, ${sku.skuClaims.filter((c) => !c.revokedAt).length} active`,
    );
    if (sku.currentNfcTag) {
        const t = sku.currentNfcTag;
        console.log(`  chip     ${t.nfcTagCode}  ${t.lifecycleState}, last accepted counter ${t.lastTapCounter} (kept)`);
    }
    return sku;
}

try {
    if (!skuCode?.startsWith(TEST_PREFIX)) {
        console.error(`\n✗ Only test units (${TEST_PREFIX}…) can be reset with this script. Got "${skuCode}".\n`);
        process.exitCode = 1;
    } else {
        const before = await describe(APPLY ? 'BEFORE' : 'DRY RUN — current state');
        if (!before) {
            console.error(`\n✗ No unit with code ${skuCode}.\n`);
            process.exitCode = 1;
        } else if (before.claimedStatus !== 'CLAIMED') {
            console.log('\nNothing to reset: the unit is not claimed.\n');
        } else if (!APPLY) {
            console.log('\nWould revoke the active claim (nothing deleted). Re-run with --apply.\n');
        } else {
            const claims = createClaimsModule({ prisma, eventBus });
            const result = await claims.service.revokeClaim({
                skuId: before.id,
                reason: 'Test reset (scripts/reset-test-claim.ts)',
                actorId: null,
                resaleBlockedUntil: null,
            });
            await describe(result.revoked ? 'AFTER — reset done' : 'AFTER — nothing was revoked');
            console.log('\nThe tag can be claimed again with the next tap.\n');
        }
    }
} catch (error) {
    const lines = String((error as Error)?.message ?? error).split('\n').map((l) => l.trim()).filter(Boolean);
    console.error('\n✗', lines.slice(-2).join(' | ').slice(0, 300), '\n');
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}

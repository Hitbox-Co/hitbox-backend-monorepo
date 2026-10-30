/**
 * What the SERVER decided about recent taps. Read-only.
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/recent-taps.ts [how-many]
 *
 * Every tap that reaches the server writes one NfcVerification row. This prints
 * them newest first, with the reason a tap was refused (the app can never show
 * that reason, on purpose — only this log has it). Prints no UID, no e, no c and
 * no keys: the table does not hold any.
 *
 *   VERIFIED            e decrypted, the chip was found, the CMAC matched, and the
 *                       counter was higher than the last one → accepted
 *   BAD_PICC            e did not decrypt under Key 01
 *   BAD_CMAC            e decrypted, but c did not match under Key 02
 *   UNKNOWN_TAG         decrypted fine, but that UID is not a registered chip
 *   BATCH_MISMATCH      the chip belongs to a different key set than b names
 *   REPLAY              a genuine tap, but its counter was not higher than the last
 *   UNKNOWN_BATCH       no key set has that b
 *   KEY_SET_RETIRED     the key set was retired
 *   TAG_NOT_ACTIVE      the chip is not BOUND / ACTIVE
 *   NO_ITEM             the chip is not embedded in a unit yet
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
config({ path: resolve(root, '.env.local'), quiet: true });
config({ path: resolve(root, '.env'), quiet: true });
process.env.NODE_ENV = 'qa'; // quiet query logging

const { prisma } = await import('@hitbox/database');
const take = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;

const rows = await prisma.nfcVerification.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
        createdAt: true,
        result: true,
        reasonCode: true,
        counter: true,
        keySetId: true,
        nfcTag: { select: { nfcTagCode: true, lastTapCounter: true } },
    },
});

if (rows.length === 0) {
    console.log('\nNo taps have reached the server yet.\n');
} else {
    console.log('');
    console.table(
        rows.map((r) => ({
            time: r.createdAt.toISOString().replace('T', ' ').slice(0, 19),
            result: r.result,
            reason: r.reasonCode ?? '—',
            counter: r.counter ?? '—',
            chip: r.nfcTag?.nfcTagCode ?? '—',
            'last accepted counter': r.nfcTag?.lastTapCounter ?? '—',
        })),
    );
}
await prisma.$disconnect();

/**
 * Read-only: did a consignment's chip keys reach the database properly?
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/check-chip-keys.ts <batchRef or batch id>
 *
 * For every chip of the consignment it checks that there is exactly one
 * ACTIVE NfcTagKey row, that the row belongs to the same UID (hash match), and
 * that all three wrapped keys unwrap with this deployment's wrapping key. It
 * writes nothing and prints no key and no UID — only chip codes and counts.
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@hitbox/database';
import { createLocalKeyWrapper } from '../src/adapters/kms-key-wrapper';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env') });

const ref = process.argv[2];
if (!ref) {
    console.error('Usage: tsx scripts/check-chip-keys.ts <batchRef or batch id>');
    process.exit(2);
}

async function main() {
    const wrapper = createLocalKeyWrapper(process.env);
    if (!wrapper) throw new Error('NFC_LOCAL_WRAP_KEY is not set in .env.');
    const prisma = new PrismaClient();
    try {
        const isUuid = /^[0-9a-f-]{36}$/i.test(ref!);
        const batch = await prisma.supplyBatch.findFirst({
            where: isUuid ? { id: ref } : { batchRef: ref },
            select: { id: true, batchRef: true, status: true, quantity: true, rowsReceived: true },
        });
        if (!batch) throw new Error(`No consignment with batchRef or id "${ref}".`);
        console.log(`Consignment ${batch.batchRef ?? batch.id}: ${batch.status}, ${batch.rowsReceived} of ${batch.quantity} chips uploaded.`);

        const tags = await prisma.nfcTag.findMany({
            where: { supplyBatchId: batch.id },
            orderBy: { nfcTagCode: 'asc' },
            select: {
                nfcTagCode: true,
                tagUidHash: true,
                keys: {
                    where: { status: 'ACTIVE' },
                    select: { tagUidHash: true, kmsKeyRef: true, key0Wrapped: true, key1Wrapped: true, key2Wrapped: true, personalizedAt: true },
                },
            },
        });

        let good = 0;
        const noKeys: string[] = [];
        const broken: string[] = [];
        for (const tag of tags) {
            const row = tag.keys[0];
            if (!row) {
                noKeys.push(tag.nfcTagCode);
                continue;
            }
            const problems: string[] = [];
            if (tag.keys.length > 1) problems.push('more than one ACTIVE key row');
            if (row.tagUidHash !== tag.tagUidHash) problems.push('key row names a different UID');
            for (const [name, blob] of [['Key 00', row.key0Wrapped], ['Key 01', row.key1Wrapped], ['Key 02', row.key2Wrapped]] as const) {
                try {
                    const plain = await wrapper.unwrap(Buffer.from(blob), row.kmsKeyRef);
                    if (plain.length !== 16) problems.push(`${name} is not 16 bytes`);
                    plain.fill(0);
                } catch {
                    problems.push(`${name} does not unwrap`);
                }
            }
            if (problems.length) broken.push(`${tag.nfcTagCode}: ${problems.join(', ')}`);
            else good += 1;
        }

        console.log(`Chips: ${tags.length}. Keys stored and readable: ${good}. No keys: ${noKeys.length}. Problems: ${broken.length}.`);
        if (noKeys.length) console.log(`  without keys: ${noKeys.slice(0, 20).join(', ')}${noKeys.length > 20 ? ' …' : ''}`);
        for (const line of broken) console.log(`  ✗ ${line}`);
        console.log(broken.length === 0 ? 'RESULT: every stored key row is correct.' : 'RESULT: some key rows need attention.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});

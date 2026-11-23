/**
 * Registers ONE chip whose keys YOU supplied (UID + Key 00/01/02), the same way
 * the supply upload does: through SupplyRepository.registerTags, so the chip,
 * its NfcTagKey row and the consignment counters change together in one
 * transaction. Inserts only; nothing is updated or deleted.
 *
 *   npx tsx scripts/register-test-tag.ts <secrets-file> <batchRef> [--apply]
 *
 * Without --apply it only checks and reports. Prints no key and no UID.
 * Development database only (refuses NODE_ENV=production).
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@hitbox/database';
import { SupplyRepository } from '../../../packages/supply/src/repository/supply.repository';
import { createLocalKeyWrapper } from '../src/adapters/kms-key-wrapper';
import { createTagCipher } from '../src/adapters/tag-cipher';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env') });

const apply = process.argv.includes('--apply');
const [file, batchRef, variantCode] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const hex = (value: unknown, bytes: number, name: string): Buffer => {
    const clean = String(value ?? '').replace(/[\s:-]/g, '');
    if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(clean)) throw new Error(`${name} must be ${bytes * 2} hex characters.`);
    return Buffer.from(clean, 'hex');
};

async function main() {
    if (!file || !batchRef) throw new Error('Usage: tsx scripts/register-test-tag.ts <secrets-file> <batchRef> [--apply]');
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
    console.log(`Database host: ${new URL(process.env.DATABASE_URL ?? '').host}`);

    const input = JSON.parse(readFileSync(resolve(here, file), 'utf8')) as Record<string, unknown>;
    const uid = hex(input.tagUid, 7, 'tagUid').toString('hex').toUpperCase();
    const keys = [hex(input.key0, 16, 'key0'), hex(input.key1, 16, 'key1'), hex(input.key2, 16, 'key2')];

    const wrapper = createLocalKeyWrapper(process.env);
    const cipher = createTagCipher(process.env);
    if (!wrapper || !cipher) throw new Error('NFC_LOCAL_WRAP_KEY and NFC_TAG_UID_KEY must be set in .env.');
    const kmsKeyRef = process.env.NFC_KMS_KEY_REF ?? 'local-dev';

    // The dev database is remote; the default 5 s interactive-transaction limit is too tight.
    const prisma = new PrismaClient({ transactionOptions: { maxWait: 30_000, timeout: 120_000 } });
    try {
        const batch = await prisma.supplyBatch.findFirst({
            where: { batchRef },
            select: { id: true, status: true, quantity: true, rowsReceived: true, itemType: true, lines: { select: { id: true } } },
        });
        if (!batch) throw new Error(`No consignment with batchRef "${batchRef}".`);
        console.log(`Consignment ${batchRef}: ${batch.status}, ${batch.rowsReceived} of ${batch.quantity} chips, ${batch.lines.length} variant line(s).`);
        let variantId: string | undefined;
        if (batch.lines.length > 0) {
            if (!variantCode) throw new Error('This consignment has variant lines: pass a variantCode.');
            const line = await prisma.supplyBatchLine.findFirst({
                where: { batchId: batch.id, variant: { variantCode } },
                select: { variantId: true },
            });
            if (!line) throw new Error(`Variant ${variantCode} is not a line of this consignment.`);
            variantId = line.variantId;
        }
        if (batch.status !== 'UPLOADED') throw new Error(`Consignment is ${batch.status}, expected UPLOADED.`);
        if (batch.rowsReceived + 1 > batch.quantity) throw new Error('Consignment is full.');

        const hash = cipher.hash(uid);
        const taken = await prisma.nfcTag.findFirst({ where: { tagUidHash: hash }, select: { nfcTagCode: true } });
        if (taken) throw new Error(`This UID is already registered as ${taken.nfcTagCode}. Nothing changed.`);
        console.log('UID is not registered yet.');
        if (!apply) {
            console.log('Dry run: nothing changed. Re-run with --apply.');
            return;
        }

        const wrapped = await Promise.all(keys.map((k) => wrapper.wrap(k, kmsKeyRef)));
        const result = await new SupplyRepository(prisma).registerTags({
            batchId: batch.id,
            createdById: null,
            tags: [{
                uidHash: hash,
                uidEncrypted: cipher.encrypt(uid),
                keyReference: cipher.keyReference,
                qcStatus: 'PASSED' as never,
                qcNotes: 'Test chip, user-supplied keys',
                variantId,
                keys: { key0Wrapped: Buffer.from(wrapped[0]!), key1Wrapped: Buffer.from(wrapped[1]!), key2Wrapped: Buffer.from(wrapped[2]!), kmsKeyRef },
            }],
        });
        const tag = await prisma.nfcTag.findFirst({ where: { tagUidHash: hash }, select: { nfcTagCode: true } });
        console.log(`Registered chip ${tag?.nfcTagCode} (created ${result.created}, with keys ${result.keysCreated}).`);
        console.log('No key or UID was printed.');
    } finally {
        keys.forEach((k) => k.fill(0));
        await prisma.$disconnect();
    }
}

main().catch((e) => { console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

/**
 * Stores the keys YOU supplied for a chip as its per-tag key row (NfcTagKey).
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/import-test-tag-keys.ts [secrets-file] [--apply]
 *
 * Reads tagUid, key0, key1, key2 from scripts/secrets/nfc-test-tag.json (or the
 * file you name; git-ignored). Nothing is generated: these are the keys that
 * are already on the chip. Without --apply it only checks and reports.
 *
 * With --apply, on the development database only:
 *   1. the UID must hash to the registered chip's tagUidHash, or it aborts;
 *   2. an ACTIVE row that was never written to the chip (personalizedAt null,
 *      e.g. a generated set you did not use) is REVOKED: a status change, no
 *      row is deleted. An ACTIVE row that WAS written aborts instead;
 *   3. one new ACTIVE row is added with your keys wrapped by the local dev
 *      wrapper, and marked personalized (the keys are already on the chip).
 * Prints no key and no UID.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@hitbox/database';
import { NfcTagKeyRepository } from '../../../packages/supply/src/repository/nfc-tag-key.repository';
import { createLocalKeyWrapper } from '../src/adapters/kms-key-wrapper';
import { createTagCipher } from '../src/adapters/tag-cipher';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env') });

const apply = process.argv.includes('--apply');
const file = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'secrets/nfc-test-tag.json';
const CODE = 'NT00000001';

const hex = (value: unknown, bytes: number, name: string): Buffer => {
    const clean = String(value ?? '').replace(/[\s:-]/g, '');
    if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(clean)) {
        throw new Error(`${name} in the secrets file must be ${bytes * 2} hex characters.`);
    }
    return Buffer.from(clean, 'hex');
};

async function main() {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
    console.log(`Database host: ${new URL(process.env.DATABASE_URL ?? '').host}`);

    const input = JSON.parse(readFileSync(resolve(here, file), 'utf8')) as Record<string, unknown>;
    const uid = hex(input.tagUid, 7, 'tagUid');
    const key0 = hex(input.key0, 16, 'key0');
    const key1 = hex(input.key1, 16, 'key1');
    const key2 = hex(input.key2, 16, 'key2');

    const keyWrapper = createLocalKeyWrapper(process.env);
    const tagCipher = createTagCipher(process.env);
    if (!keyWrapper || !tagCipher) throw new Error('NFC_LOCAL_WRAP_KEY and NFC_TAG_UID_KEY must be set in .env.');
    const kmsKeyRef = process.env.NFC_KMS_KEY_REF ?? 'local-dev';

    const prisma = new PrismaClient();
    try {
        const tag = await prisma.nfcTag.findUnique({
            where: { nfcTagCode: CODE },
            select: {
                id: true,
                tagUidHash: true,
                tagUidEncrypted: true,
                keys: { select: { id: true, status: true, personalizedAt: true } },
            },
        });
        if (!tag) throw new Error(`No chip with code ${CODE}.`);

        const uidHex = uid.toString('hex').toUpperCase();
        if (tagCipher.hash(uidHex) !== tag.tagUidHash) {
            throw new Error('The UID in the secrets file is not the registered chip. Nothing changed.');
        }
        console.log('UID matches the registered chip.');

        const active = tag.keys.filter((k) => k.status === 'ACTIVE');
        console.log(`Key rows: ${tag.keys.length}, active: ${active.length}.`);
        if (active.some((k) => k.personalizedAt)) {
            throw new Error('The ACTIVE key row was already written to the chip. Revoke it deliberately first.');
        }
        console.log(
            active.length
                ? `Will revoke ${active.length} unused ACTIVE row(s) (status change only), then add one ACTIVE row with your keys.`
                : 'Will add one ACTIVE row with your keys.',
        );
        if (!apply) {
            console.log('Dry run: nothing changed. Re-run with --apply.');
            return;
        }

        const repo = new NfcTagKeyRepository(prisma);
        if (active.length) {
            const revoked = await repo.revokeActive({
                nfcTagId: tag.id,
                reason: 'Replaced by the keys supplied for the chip (generated set was never written to it).',
                now: new Date(),
            });
            if (!revoked) throw new Error('Could not revoke the unused row.');
        }
        const wrapped = await Promise.all([key0, key1, key2].map((key) => keyWrapper.wrap(key, kmsKeyRef)));
        const row = await repo.create({
            nfcTagId: tag.id,
            tagUidEncrypted: tag.tagUidEncrypted,
            tagUidHash: tag.tagUidHash,
            key0Wrapped: wrapped[0]!,
            key1Wrapped: wrapped[1]!,
            key2Wrapped: wrapped[2]!,
            kmsKeyRef,
            createdById: null,
        });
        await repo.markPersonalized(row.id, new Date());
        console.log(`Key row ${row.id} created (ACTIVE, marked as written to the chip).`);
        console.log('No key or UID was printed.');
    } finally {
        key0.fill(0);
        key1.fill(0);
        key2.fill(0);
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});

/**
 * Generates Key 00/01/02 for ONE chip (per-tag keys) and writes them to a
 * git-ignored file, so they never appear in a terminal, a log or a chat.
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/generate-test-tag-keys.ts [NT00000001] [--apply]
 *
 * Without --apply it only checks and reports (dry run). With --apply it adds
 * ONE row to NfcTagKey (ACTIVE, keys wrapped by the local dev wrapper) through
 * the same service the admin route uses. It changes no existing row and
 * deletes nothing. A chip that already has ACTIVE keys is refused.
 *
 * Output: scripts/secrets/nfc-test-tag-pertag.json with the three keys, the
 * UID and the URL to write onto the chip. Delete it once the chip is written.
 * Development database only (it refuses NODE_ENV=production).
 */
import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@hitbox/database';
import { buildSupplyAccess } from '../../../packages/supply/src/domain/supply-access';
import { NfcTagKeyRepository } from '../../../packages/supply/src/repository/nfc-tag-key.repository';
import { NfcTagKeyService } from '../../../packages/supply/src/service/nfc-tag-key.service';
import { createLocalKeyWrapper } from '../src/adapters/kms-key-wrapper';
import { createTagCipher } from '../src/adapters/tag-cipher';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env') });

const apply = process.argv.includes('--apply');
const code = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'NT00000001';
const OUT = resolve(here, 'secrets/nfc-test-tag-pertag.json');

async function main() {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
    const host = new URL(process.env.DATABASE_URL ?? '').host;
    console.log(`Database host: ${host}`);

    const keyWrapper = createLocalKeyWrapper(process.env);
    const tagCipher = createTagCipher(process.env);
    if (!keyWrapper || !tagCipher) {
        throw new Error('NFC_LOCAL_WRAP_KEY and NFC_TAG_UID_KEY must both be set in .env.');
    }

    const prisma = new PrismaClient();
    try {
        const tag = await prisma.nfcTag.findUnique({
            where: { nfcTagCode: code },
            select: { id: true, nfcTagCode: true, lifecycleState: true, keys: { select: { status: true } } },
        });
        if (!tag) throw new Error(`No chip with code ${code}.`);
        const active = tag.keys.filter((k) => k.status === 'ACTIVE').length;
        console.log(`Chip ${tag.nfcTagCode}: ${tag.lifecycleState}, ${tag.keys.length} key row(s), ${active} active.`);
        if (active > 0) throw new Error('This chip already has ACTIVE keys. Revoke them first to re-key.');
        if (existsSync(OUT) && apply) {
            throw new Error(`${OUT} already exists. Move or delete it first (it may hold keys you still need).`);
        }
        if (!apply) {
            console.log('Dry run: nothing written. Re-run with --apply to generate the keys.');
            return;
        }

        const service = new NfcTagKeyService({
            keys: new NfcTagKeyRepository(prisma),
            eventBus: { publish() { }, subscribe() { } } as never,
            audit: { record: async () => { } },
            logger: { error() { }, warn() { }, info() { }, debug() { } } as never,
            keyWrapper,
            kmsKeyRef: process.env.NFC_KMS_KEY_REF ?? 'local-dev',
            tagCipher,
        });
        const access = buildSupplyAccess({
            userId: null as never,
            permissions: ['nfc-tag-claim:manage:global'],
            roles: [],
        });
        const out = await service.generateTagKeys({ access, correlationId: 'script' }, tag.id);

        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(
            OUT,
            JSON.stringify(
                {
                    nfcTagCode: out.nfcTagCode,
                    nfcTagKeyId: out.key.id,
                    tagUid: out.uid,
                    key0: out.keys.key0,
                    key1: out.keys.key1,
                    key2: out.keys.key2,
                    url: out.url,
                },
                null,
                2,
            ),
            { mode: 0o600 },
        );
        console.log(`Key row ${out.key.publicCode ?? out.key.id} created (ACTIVE, not yet written to the chip).`);
        console.log(`Keys, UID and URL are in: ${OUT}`);
        console.log('Nothing secret was printed. Delete that file after the chip is programmed.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});

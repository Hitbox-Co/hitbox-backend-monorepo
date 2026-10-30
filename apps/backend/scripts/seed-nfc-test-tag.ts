/**
 * One-off: register ONE test chip end to end, so the tap flow can be tried on a
 * real tag.
 *
 *   pnpm --filter @hitbox/backend tsx scripts/seed-nfc-test-tag.ts          # dry run
 *   pnpm --filter @hitbox/backend tsx scripts/seed-nfc-test-tag.ts --apply  # write
 *
 * Reads the chip UID and Key 00/01/02 from scripts/secrets/nfc-test-tag.json
 * (git-ignored), never from code that gets committed.
 *
 * ADDS rows only — it never updates or deletes an existing one, and it refuses
 * to run if any row it would create already exists:
 *
 *   Drop         a DRAFT dummy product (not visible to shoppers)
 *   SupplyBatch  the consignment (batchRef from the input file)
 *   NfcKeySet    the three keys, WRAPPED — no plaintext key is stored
 *   NfcTag       the chip, hashed + encrypted, BOUND to the key set
 *   Sku          one unclaimed unit embedding the chip
 *
 * Everything is written in one transaction: all or nothing.
 */
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../');
config({ path: resolve(root, '.env.local') });
config({ path: resolve(root, '.env') });

const { prisma } = await import('@hitbox/database');
const { createTagCipher } = await import('../src/adapters/tag-cipher');
const { createLocalKeyWrapper } = await import('../src/adapters/kms-key-wrapper');

const APPLY = process.argv.includes('--apply');
const KMS_REF = process.env.NFC_KMS_KEY_REF ?? 'local-dev';
const GROUP_CODE = 'NFC-TEST-786';

function fail(message: string): never {
    console.error(`\n✗ ${message}\n`);
    process.exit(1);
}

if (process.env.NODE_ENV === 'production') fail('Refusing to run with NODE_ENV=production.');

// ── input ──────────────────────────────────────────────────────────────────
let input: Record<string, string>;
try {
    input = JSON.parse(readFileSync(resolve(here, 'secrets/nfc-test-tag.json'), 'utf8'));
} catch {
    fail('Could not read scripts/secrets/nfc-test-tag.json');
}
const hex = (name: string, length: number): string => {
    const value = (input[name] ?? '').replace(/[\s:-]/g, '');
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) {
        fail(`"${name}" must be ${length} hex characters.`);
    }
    return value.toLowerCase();
};
const keySetCode = input.keySetCode ?? fail('"keySetCode" is missing.');
const batchRef = input.batchRef ?? fail('"batchRef" is missing.');
const uid = hex('tagUid', 14).toUpperCase();
const key0 = Buffer.from(hex('key0', 32), 'hex');
const key1 = Buffer.from(hex('key1', 32), 'hex');
const key2 = Buffer.from(hex('key2', 32), 'hex');
if (new Set([key0, key1, key2].map((k) => k.toString('hex'))).size !== 3) {
    fail('Key 00, Key 01 and Key 02 must all be different.');
}

// ── environment ────────────────────────────────────────────────────────────
const cipher = createTagCipher({
    NFC_TAG_UID_KEY: process.env.NFC_TAG_UID_KEY,
    NFC_TAG_KEY_REFERENCE: process.env.NFC_TAG_KEY_REFERENCE,
});
if (!cipher) fail('NFC_TAG_UID_KEY is not set (32+ characters). It hashes the chip UID.');
const wrapper = createLocalKeyWrapper({
    NODE_ENV: process.env.NODE_ENV,
    NFC_LOCAL_WRAP_KEY: process.env.NFC_LOCAL_WRAP_KEY,
});
if (!wrapper) fail('NFC_LOCAL_WRAP_KEY is not set (32+ characters). It wraps the keys.');

// ── refuse to touch anything that exists ───────────────────────────────────
const tagUidHash = cipher.hash(uid);
const [keySetExists, batchExists, dropExists, tagExists] = await Promise.all([
    prisma.nfcKeySet.findUnique({ where: { keySetCode }, select: { id: true } }),
    prisma.supplyBatch.findFirst({ where: { batchRef }, select: { id: true } }),
    prisma.drop.findUnique({ where: { groupCode: GROUP_CODE }, select: { id: true } }),
    prisma.nfcTag.findUnique({ where: { tagUidHash }, select: { id: true } }),
]);
const clashes = [
    keySetExists && `a key set with code "${keySetCode}"`,
    batchExists && `a consignment with batchRef "${batchRef}"`,
    dropExists && `a drop with groupCode "${GROUP_CODE}"`,
    tagExists && 'a chip with this UID',
].filter(Boolean);
if (clashes.length > 0) fail(`Already exists, nothing written: ${clashes.join('; ')}.`);

// ── who the consignment is attached to (existing rows, only referenced) ────
const vendor = await prisma.vendor.findFirst({
    where: { isActive: true, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
});
const user = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, handle: true },
});
if (!vendor) fail('No active vendor exists to attach the consignment to.');
if (!user) fail('No user exists to record as the person who entered the consignment.');

const last = await prisma.nfcTag.findFirst({
    orderBy: { nfcTagCode: 'desc' },
    select: { nfcTagCode: true },
});
const parsed = last ? Number.parseInt(last.nfcTagCode.slice(2), 10) : 0;
const nfcTagCode = `NT${String((Number.isFinite(parsed) ? parsed : 0) + 1).padStart(8, '0')}`;
const skuCode = `${GROUP_CODE}-000001`;

console.log(`
${APPLY ? 'APPLYING' : 'DRY RUN'} — rows that will be ADDED (nothing is updated or deleted):

  Drop         ${GROUP_CODE}  "NFC Test Collectible (786)"  status DRAFT (hidden from shoppers)
  SupplyBatch  batchRef "${batchRef}"  ACCEPTED, 1 unit
                 attached to existing vendor "${vendor.name}" and user "${user.handle ?? user.id}"
  NfcKeySet    code "${keySetCode}"  ACTIVE  keys wrapped under "${KMS_REF}" (no plaintext stored)
  NfcTag       ${nfcTagCode}  BOUND to that key set, counter -1, UID stored hashed + encrypted only
  Sku          ${skuCode}  UNCLAIMED, embeds the chip
`);

if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write.\n');
    await prisma.$disconnect();
    process.exit(0);
}

// ── write ──────────────────────────────────────────────────────────────────
const now = new Date();
const dropId = randomUUID();
const batchId = randomUUID();
const skuId = randomUUID();
const tagId = randomUUID();

try {
    const [w0, w1, w2] = await Promise.all(
        [key0, key1, key2].map((key) => wrapper.wrap(key, KMS_REF)),
    );

    const result = await prisma.$transaction(
        async (tx) => {
            await tx.drop.create({
                data: {
                    id: dropId,
                    groupCode: GROUP_CODE,
                    name: 'NFC Test Collectible (786)',
                    description: 'Dummy product for testing the NFC tap flow. Safe to remove.',
                    rarity: 'RARE',
                    totalSupply: 1,
                    status: 'DRAFT',
                    complianceStatus: 'CLEARED',
                    isAgeSpecific: false,
                    isActive: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await tx.supplyBatch.create({
                data: {
                    id: batchId,
                    vendorId: vendor.id,
                    itemType: 'MERCHANDISE',
                    quantity: 1,
                    batchRef,
                    receivedAt: now,
                    enteredById: user.id,
                    notes: 'NFC tap-flow test consignment.',
                    createdAt: now,
                    dropId,
                    status: 'ACCEPTED',
                    rowsReceived: 1,
                    rowsAccepted: 1,
                },
            });
            const keySet = await tx.nfcKeySet.create({
                data: {
                    keySetCode,
                    supplyBatchId: batchId,
                    key0Wrapped: new Uint8Array(w0!),
                    key1Wrapped: new Uint8Array(w1!),
                    key2Wrapped: new Uint8Array(w2!),
                    kmsKeyRef: KMS_REF,
                    createdById: user.id,
                },
                select: { id: true, publicCode: true },
            });
            await tx.nfcTag.create({
                data: {
                    id: tagId,
                    nfcTagCode,
                    supplyBatchId: batchId,
                    tagUidHash,
                    tagUidEncrypted: cipher.encrypt(uid),
                    keyReference: cipher.keyReference,
                    qcStatus: 'PASSED',
                    qcReportedAt: now,
                    lifecycleState: 'BOUND',
                    keySetId: keySet.id,
                    personalizedAt: now,
                    boundAt: now,
                    lastTapCounter: -1,
                },
            });
            await tx.sku.create({
                data: {
                    id: skuId,
                    skuCode,
                    productId: dropId,
                    serialNumber: 1,
                    claimedStatus: 'UNCLAIMED',
                    tagLifecycleState: 'BOUND',
                    currentNfcTagId: tagId,
                    supplyBatchId: batchId,
                    resaleBlocked: false,
                    lastTapCounter: 0,
                    isActive: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await tx.nfcTag.update({ where: { id: tagId }, data: { skuId } });
            return keySet;
        },
        { maxWait: 10_000, timeout: 30_000 },
    );

    console.log(`✓ Written.

  b (batch code for the tag URL):  ${result.publicCode}
  tag ${nfcTagCode}  →  unit ${skuCode}  (UNCLAIMED)

Write this URL to the tag (TagWriter / NTAG 424 DNA SDM):
  https://hitboxcollectibles.com/verify?b=${result.publicCode}&e=<PICC data>&c=<CMAC>
  SDM Meta Read = Key 01, CMAC key = Key 02, counter retrieval = 0E.
`);
} finally {
    key0.fill(0);
    key1.fill(0);
    key2.fill(0);
    await prisma.$disconnect();
}

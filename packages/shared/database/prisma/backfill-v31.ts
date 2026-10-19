/**
 * v3.1 data backfill — run once after the v3.1 migration.
 *
 *   pnpm db:backfill:v31
 *
 * The migration is additive, so it could only give pre-existing rows a *column
 * default*. For several of the new columns that default is mechanically
 * correct and factually wrong — `BlockchainLedger.occurredAt` defaulting to
 * `now()` says a claim from July happened on the day we ran the migration,
 * which is exactly the sort of thing a provenance chain must not say. Part A
 * repairs those.
 *
 * Part B populates the four new tables from the data that is already there, so
 * `NfcTag`, `NfcVerification`, `CogsReconciliation` and `ExceptionCase` are not
 * empty on a demo database.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * **Idempotent.** Part A is scoped to rows that existed when the migration ran
 * (`createdAt < migration.finished_at`), so re-running is a no-op and rows
 * written afterwards are never touched. Part B uses deterministic ids and
 * upserts.
 *
 * **Additive.** Nothing is deleted. `Sku`'s deprecated tag columns are read and
 * left exactly as they are — this script does not migrate off them, it mirrors
 * them into `NfcTag` so both representations agree.
 *
 * ── The dev key, stated plainly ─────────────────────────────────────────────
 *
 * `NfcTag.tagUidHash` / `tagUidEncrypted` are real HMAC-SHA256 and AES-256-GCM,
 * computed with a key derived from a constant in this file. That is fine for a
 * demo database and **is not a production backfill**: production needs the KMS
 * key, and `keyReference` here says `dev-local:v1` so a row written by this
 * script can never be mistaken for one written against a real key.
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { ClaimedStatus, Prisma, TagLifecycleState } from '@prisma/client';
import { prisma } from '../src/index';

const MIGRATION = '20260925000000_v31_nfc_tag_master_cogs_exceptions_and_approvals';

/** Same scheme as seed-demo.ts, so ids stay stable across runs. */
function id(label: string): string {
    const h = createHash('sha1').update(`hitbox-demo:${label}`).digest('hex');
    return [
        h.slice(0, 8), h.slice(8, 12),
        `4${h.slice(13, 16)}`,
        ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
        h.slice(20, 32),
    ].join('-');
}

/** `NT00000001` — two-letter prefix plus an ordinal, inside VarChar(10). */
const code = (prefix: string, n: number) => `${prefix}${String(n).padStart(8, '0')}`;

// ── Dev-only tag crypto ─────────────────────────────────────────────────────

const DEV_KEY_REFERENCE = 'dev-local:v1';
const DEV_KEY = createHash('sha256').update('hitbox-dev-nfc-key:v1').digest();

/** Lookup key. Deterministic by design — that is what makes it a lookup key. */
const hashUid = (uid: string) =>
    createHmac('sha256', DEV_KEY).update(uid.toUpperCase()).digest('hex');

/** `iv.authTag.ciphertext`, all base64. Non-deterministic, hence the upsert guard. */
function encryptUid(uid: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', DEV_KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(uid.toUpperCase(), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}

// ────────────────────────────────────────────────────────────────────────────

async function migrationAppliedAt(): Promise<Date> {
    const rows = await prisma.$queryRaw<{ finished_at: Date | null }[]>`
        SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = ${MIGRATION}
    `;
    const at = rows[0]?.finished_at;
    if (!at) throw new Error(`${MIGRATION} has not been applied — run pnpm db:deploy first.`);
    return at;
}

/**
 * Part A — repair the defaults that are wrong for historical rows.
 *
 * Raw SQL rather than the client: each of these is "copy one column onto
 * another across the whole table", which is one statement in SQL and N round
 * trips through Prisma.
 */
async function repairDefaults(cutoff: Date): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    // A claim that happened in July did not occur on migration day. This is the
    // one that matters most: the ledger is the provenance record.
    counts['BlockchainLedger.occurredAt'] = await prisma.$executeRaw`
        UPDATE "BlockchainLedger" SET "occurredAt" = "createdAt"
        WHERE "createdAt" < ${cutoff} AND "occurredAt" <> "createdAt"
    `;

    // A price has been in force since it was written, not since the migration.
    // Safe against the new 4-column unique: one row per triple exists today, so
    // moving `effectiveFrom` cannot collide with a sibling.
    counts['DropPrice.effectiveFrom'] = await prisma.$executeRaw`
        UPDATE "DropPrice" SET "effectiveFrom" = "createdAt"
        WHERE "createdAt" < ${cutoff} AND "effectiveFrom" <> "createdAt"
    `;

    // These consignments were received and accepted long ago; `quantity` is the
    // row count the new columns split three ways.
    counts['SupplyBatch'] = await prisma.$executeRaw`
        UPDATE "SupplyBatch"
        SET "batchDate" = "receivedAt"::date,
            "status" = 'ACCEPTED',
            "rowsReceived" = "quantity",
            "rowsAccepted" = "quantity",
            "rowsRejected" = 0,
            "updatedAt" = "receivedAt"
        WHERE "createdAt" < ${cutoff} AND "status" = 'UPLOADED' AND "rowsReceived" = 0
    `;

    // Nothing has edited these, so "last updated" is "created".
    counts['Vendor.updatedAt'] = await prisma.$executeRaw`
        UPDATE "Vendor" SET "updatedAt" = "createdAt"
        WHERE "createdAt" < ${cutoff} AND "updatedAt" <> "createdAt"
    `;

    // Revenue is recognised on `paidAt`, so every order past PENDING_PAYMENT
    // needs one. The gateway's own settlement time where we have it, the order
    // date otherwise — never a guess that post-dates the order.
    counts['Order.paidAt'] = await prisma.$executeRaw`
        UPDATE "Order" o
        SET "paidAt" = COALESCE(
            (SELECT MIN(p."settledAt") FROM "PaymentTransaction" p
              WHERE p."orderId" = o.id AND p."settledAt" IS NOT NULL),
            o."placedAt")
        WHERE o."placedAt" < ${cutoff}
          AND o."paidAt" IS NULL
          AND o."status" NOT IN ('PENDING_PAYMENT', 'CANCELLED')
    `;

    return counts;
}

/**
 * Part B1 — mirror the deprecated `Sku` tag columns into `NfcTag`.
 *
 * `NfcTag.supplyBatchId` is required, and the only link we have is
 * `Sku.provisioningBatchId`, which is free text matched against
 * `SupplyBatch.batchRef`. A unit whose batch reference resolves to nothing is
 * skipped and reported rather than attached to an arbitrary batch — an invented
 * consignment is worse than a missing one.
 */
async function backfillNfcTags(): Promise<{ created: number; linked: number; skipped: string[] }> {
    const batches = await prisma.supplyBatch.findMany({
        where: { batchRef: { not: null } },
        select: { id: true, batchRef: true, receivedAt: true },
    });
    const byRef = new Map(batches.map((b) => [b.batchRef as string, b]));

    const skus = await prisma.sku.findMany({
        where: { tagId: { not: null } },
        orderBy: { skuCode: 'asc' },
        select: {
            id: true, skuCode: true, tagId: true, tagLifecycleState: true,
            provisioningBatchId: true, vendorAuthenticatedAt: true,
            lastTapCounter: true, tamperStatus: true, claimedStatus: true,
            createdAt: true, currentNfcTagId: true,
        },
    });

    const skipped: string[] = [];
    let created = 0;
    let linked = 0;
    let ordinal = 0;

    for (const sku of skus) {
        ordinal += 1;
        const batch = sku.provisioningBatchId ? byRef.get(sku.provisioningBatchId) : undefined;
        if (!batch) {
            skipped.push(`${sku.skuCode} (batchRef ${sku.provisioningBatchId ?? 'none'})`);
            continue;
        }

        const uid = sku.tagId as string;
        const tagId = id(`nfc-tag:${sku.skuCode}`);
        // The lifecycle timestamps the old columns never had, inferred from the
        // state they do have. Nothing is invented forward of the unit's own
        // creation date.
        const boundAt = sku.createdAt;
        const activatedAt =
            sku.tagLifecycleState === TagLifecycleState.ACTIVE ? sku.createdAt : null;

        const common = {
            supplyBatchId: batch.id,
            skuId: sku.id,
            tagUidHash: hashUid(uid),
            // QC passed: these chips were bound and, in most cases, tapped.
            qcStatus: 'PASSED' as const,
            qcReportedAt: batch.receivedAt,
            lifecycleState: sku.tagLifecycleState,
            keyReference: DEV_KEY_REFERENCE,
            lastTapCounter: sku.lastTapCounter,
            tamperStatus: sku.tamperStatus,
            personalizedAt: batch.receivedAt,
            boundAt,
            activatedAt,
            updatedAt: sku.createdAt,
        };

        await prisma.nfcTag.upsert({
            where: { id: tagId },
            // `tagUidEncrypted` is only written on create: re-encrypting on
            // every run would churn the ciphertext for no reason, and the hash
            // is the column anything actually looks up by.
            create: {
                id: tagId,
                nfcTagCode: code('NT', ordinal),
                tagUidEncrypted: encryptUid(uid),
                createdAt: sku.createdAt,
                ...common,
            },
            update: common,
        });
        created += 1;

        if (sku.currentNfcTagId !== tagId) {
            await prisma.sku.update({
                where: { id: sku.id },
                data: { currentNfcTagId: tagId, supplyBatchId: batch.id },
            });
            linked += 1;
        }
    }

    return { created, linked, skipped };
}

/**
 * Part B2 — a verification per tap the old counter already claims happened.
 *
 * `lastTapCounter` says a chip has been read N times; the log of those reads is
 * what `NfcVerification` is for. Reconstructing them makes the counter and the
 * log agree, which is the invariant anything reading both will assume.
 */
async function backfillVerifications(): Promise<number> {
    const tags = await prisma.nfcTag.findMany({
        where: { lastTapCounter: { gt: 0 } },
        orderBy: { nfcTagCode: 'asc' },
        select: { id: true, nfcTagCode: true, skuId: true, lastTapCounter: true, boundAt: true },
    });

    let ordinal = 0;
    let written = 0;
    for (const tag of tags) {
        for (let counter = 1; counter <= tag.lastTapCounter; counter += 1) {
            ordinal += 1;
            const rowId = id(`nfc-verification:${tag.nfcTagCode}:${counter}`);
            const at = new Date((tag.boundAt ?? new Date()).getTime() + counter * 86_400_000);
            await prisma.nfcVerification.upsert({
                where: { id: rowId },
                create: {
                    id: rowId,
                    verificationCode: code('NV', ordinal),
                    nfcTagId: tag.id,
                    skuId: tag.skuId,
                    counter,
                    result: 'VERIFIED',
                    requestId: id(`nfc-request:${tag.nfcTagCode}:${counter}`),
                    createdAt: at,
                },
                update: {},
            });
            written += 1;
        }
    }
    return written;
}

/**
 * Part B3 — one COGS review per drop that has a cost to review, for the most
 * recent complete month.
 */
async function backfillReconciliations(month: Date): Promise<number> {
    const prices = await prisma.dropPrice.findMany({
        where: { costOfGoods: { not: null } },
        distinct: ['dropId'],
        orderBy: [{ dropId: 'asc' }],
        select: { dropId: true, costOfGoods: true },
    });

    let ordinal = 0;
    for (const price of prices) {
        ordinal += 1;
        const recorded = price.costOfGoods as Prisma.Decimal;
        // A small, deterministic variance so the screen has something to show.
        const actual = recorded.mul(ordinal % 3 === 0 ? '1.08' : '0.97').toDecimalPlaces(2);
        const variance = actual.minus(recorded).toDecimalPlaces(2);
        const rowId = id(`cogs:${price.dropId}:${month.toISOString().slice(0, 7)}`);

        await prisma.cogsReconciliation.upsert({
            where: { id: rowId },
            create: {
                id: rowId,
                reconciliationNumber: code('CR', ordinal),
                reconciliationMonth: month,
                dropId: price.dropId,
                recordedCost: recorded,
                actualCost: actual,
                varianceAmount: variance,
                variancePercentage: variance.div(recorded).mul(100).toDecimalPlaces(2),
                varianceReason: variance.isNegative()
                    ? 'Volume discount applied on the second production run.'
                    : 'Air freight substituted for sea after a factory delay.',
                status: ordinal % 3 === 0 ? 'PENDING_REVIEW' : 'APPROVED',
                notes: 'Seeded by db:backfill:v31 — demo data.',
            },
            update: {},
        });
    }
    return ordinal;
}

/** Part B4 — a few queue entries in each state, pointed at real records. */
async function backfillExceptions(): Promise<number> {
    const now = new Date();
    const claims = await prisma.skuClaim.findMany({
        take: 2, orderBy: { claimCode: 'asc' }, select: { id: true },
    });
    const orders = await prisma.order.findMany({
        take: 2, orderBy: { placedAt: 'desc' }, select: { id: true },
    });
    const ledger = await prisma.blockchainLedger.findMany({
        take: 1, orderBy: { createdAt: 'desc' }, select: { id: true },
    });

    const seeds = [
        ...claims.map((row, i) => ({
            key: `claim-recon:${row.id}`,
            caseType: 'CLAIM_RECONCILIATION',
            referenceType: 'SkuClaim',
            referenceId: row.id,
            status: i === 0 ? ('RETRY_QUEUED' as const) : ('RESOLVED' as const),
            attempts: i === 0 ? 2 : 1,
        })),
        ...orders.map((row, i) => ({
            key: `webhook-failure:${row.id}`,
            caseType: 'WEBHOOK_FAILURE',
            referenceType: 'Order',
            referenceId: row.id,
            status: i === 0 ? ('NEEDS_REVIEW' as const) : ('RETRY_QUEUED' as const),
            attempts: i === 0 ? 5 : 1,
        })),
        ...ledger.map((row) => ({
            key: `provenance:${row.id}`,
            caseType: 'PROVENANCE_INTEGRITY',
            referenceType: 'BlockchainLedger',
            referenceId: row.id,
            status: 'NEEDS_REVIEW' as const,
            attempts: 3,
        })),
    ];

    let ordinal = 0;
    for (const seed of seeds) {
        ordinal += 1;
        const rowId = id(`exception:${seed.key}`);
        await prisma.exceptionCase.upsert({
            where: { id: rowId },
            create: {
                id: rowId,
                exceptionCode: code('EX', ordinal),
                caseType: seed.caseType,
                referenceType: seed.referenceType,
                referenceId: seed.referenceId,
                status: seed.status,
                attempts: seed.attempts,
                // Overdue for the ones still queued, so the SLA index has
                // something to find.
                slaDeadline: new Date(now.getTime() + (seed.attempts > 2 ? -1 : 2) * 86_400_000),
                ...(seed.status === 'RESOLVED'
                    ? { resolution: 'Re-driven successfully on retry.', resolvedAt: now }
                    : {}),
            },
            update: {},
        });
    }
    return ordinal;
}

async function main(): Promise<void> {
    const cutoff = await migrationAppliedAt();
    console.log(`v3.1 backfill — migration applied ${cutoff.toISOString()}`);

    console.log('\nPart A — repairing migration-time defaults');
    for (const [what, n] of Object.entries(await repairDefaults(cutoff))) {
        console.log(`  ${what.padEnd(28)} ${n} row(s)`);
    }

    console.log('\nPart B — populating the new tables');
    const tags = await backfillNfcTags();
    console.log(`  NfcTag                       ${tags.created} written, ${tags.linked} linked to a Sku`);
    if (tags.skipped.length > 0) {
        console.log(`  ⚠ skipped ${tags.skipped.length} unit(s) with no resolvable supply batch:`);
        for (const line of tags.skipped.slice(0, 5)) console.log(`      ${line}`);
        if (tags.skipped.length > 5) console.log(`      … and ${tags.skipped.length - 5} more`);
    }

    console.log(`  NfcVerification              ${await backfillVerifications()} row(s)`);

    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
    console.log(`  CogsReconciliation           ${await backfillReconciliations(month)} row(s)`);
    console.log(`  ExceptionCase                ${await backfillExceptions()} row(s)`);

    const pending = await prisma.adjustmentEntry.count({ where: { status: 'PENDING_APPROVAL' } });
    if (pending > 0) {
        console.log(
            `\n⚠ ${pending} AdjustmentEntry row(s) read PENDING_APPROVAL. This script does NOT\n` +
            '  touch them: they were posted before an approval step existed and are almost\n' +
            '  certainly executed, but that is a statement about money that already moved and\n' +
            '  finance has to make it. See docs/schema-v3.1-changes.md §8.',
        );
    }

    console.log('\n✔ v3.1 backfill complete');
}

main()
    .catch((error) => {
        console.error('✖ v3.1 backfill failed');
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

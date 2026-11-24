import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, QcStatus, TagLifecycleState } from '@hitbox/database';
import { AppError, KEYED_CHIP_UID_HEX_LENGTH } from '@hitbox/shared';
import type { Logger } from 'pino';
import { SUPPLY_ERROR_CODES } from '../constants/supply.constant';
import type { IKeyWrapper } from '../domain/interfaces/key-wrapper.interface';
import type { ITagCipher } from '../domain/interfaces/tag-cipher.interface';
import { formatTagCode, nextTagOrdinal } from '../repository/supply.repository';

/**
 * Chips that reach a unit outside a consignment.
 *
 * The consignment manifest was the only path that wrote the rows a tap needs
 * (an `NfcTag` found by UID hash, and an ACTIVE `NfcTagKey`). The SKU routes
 * took a bare UID, wrote `Sku.tagId` and stopped, so every tap on such a chip
 * answered UNKNOWN_TAG / NO_KEYS. This is the supply module's side of the fix:
 * skus calls it, inside its own transaction, through a port it declares.
 *
 * Everything here runs on the caller's transaction client, so a bind that fails
 * after the chip rows are written rolls them back with it.
 *
 * Keys are secrets. They arrive as hex, are wrapped before they touch a query,
 * and are never logged, returned or placed in an error. A UID is likewise only
 * ever hashed or encrypted: an error names the row's position, never the UID.
 */

export interface ChipToAttach {
    /** Canonical (upper-case, no separators) 7-byte UID. */
    uid: string;
    key0: string;
    key1: string;
    key2: string;
    /** The variant of the goods the chip sits in; checked against a chip already on file. */
    variantId?: string | null | undefined;
}

export interface AttachedChip {
    nfcTagId: string;
    /** True when the chip had no `NfcTag` row yet and one was created. */
    created: boolean;
    /** True when ACTIVE keys were written (false when the chip already had these keys). */
    keysWritten: boolean;
}

export interface ChipRegistryDeps {
    cipher: ITagCipher | undefined;
    wrapper: IKeyWrapper | undefined;
    kmsKeyRef: string | undefined;
    logger: Logger;
}

const UNUSABLE_STATES: ReadonlySet<TagLifecycleState> = new Set([
    TagLifecycleState.LOST,
    TagLifecycleState.REVOKED,
    TagLifecycleState.DISPUTED,
]);

/** Key wrap calls in flight at once. */
const WRAP_CHUNK = 25;

async function mapInChunks<T, R>(
    items: readonly T[],
    size: number,
    work: (item: T) => Promise<R>,
): Promise<R[]> {
    const out: R[] = [];
    for (let start = 0; start < items.length; start += size) {
        out.push(...(await Promise.all(items.slice(start, start + size).map(work))));
    }
    return out;
}

function hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex, 'hex');
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002'
    );
}

export class ChipRegistryService {
    constructor(private readonly deps: ChipRegistryDeps) { }

    /**
     * Creates or links the `NfcTag` for each chip (found by UID hash) and makes
     * sure it has ACTIVE keys. Returns one result per chip, in input order.
     *
     * `forSkuIds[i]` is the unit the chip is about to be bound to, when that unit
     * already exists (a bind). A chip that is already some other unit's current
     * chip is refused; the same unit's own chip is accepted (an idempotent re-send).
     */
    async attachWithin(
        tx: Prisma.TransactionClient,
        input: {
            chips: ChipToAttach[];
            forSkuIds?: (string | null)[] | undefined;
            createdById: string | null;
        },
    ): Promise<AttachedChip[]> {
        const { cipher, wrapper, kmsKeyRef } = this.requireConfigured();
        const { chips } = input;
        if (chips.length === 0) return [];

        // The DTO already checked this; repeated here because the registry is
        // reachable from places that did not parse a request.
        chips.forEach((chip, index) => {
            if (chip.uid.length !== KEYED_CHIP_UID_HEX_LENGTH) {
                throw AppError.badRequest(
                    `Row ${index + 1}: an NTAG 424 DNA UID is ${KEYED_CHIP_UID_HEX_LENGTH} hex characters (7 bytes).`,
                    SUPPLY_ERROR_CODES.TAG_UID_INVALID,
                );
            }
        });

        const hashes = chips.map((chip) => cipher.hash(chip.uid));
        if (new Set(hashes).size !== hashes.length) {
            throw AppError.badRequest(
                'The same chip appears more than once in this request.',
                SUPPLY_ERROR_CODES.TAG_UID_DUPLICATED,
            );
        }

        const existingRows = await tx.nfcTag.findMany({
            where: { tagUidHash: { in: hashes } },
            select: {
                id: true,
                tagUidHash: true,
                lifecycleState: true,
                qcStatus: true,
                variantId: true,
                currentFor: { select: { id: true } },
                keys: {
                    where: { status: 'ACTIVE' },
                    select: { key0Wrapped: true, key1Wrapped: true, key2Wrapped: true, kmsKeyRef: true },
                    take: 1,
                },
            },
        });
        const byHash = new Map(existingRows.map((row) => [row.tagUidHash, row]));

        const last = await tx.nfcTag.findFirst({
            orderBy: { nfcTagCode: 'desc' },
            select: { nfcTagCode: true },
        });
        let ordinal = nextTagOrdinal(last?.nfcTagCode);

        const newTags: Prisma.NfcTagUncheckedCreateInput[] = [];
        // Keys to write, wrapped after the loop in parallel chunks: against a
        // cloud KMS each wrap is a network call, and 1000 chips x 3 keys one
        // after another would outlast any sensible transaction.
        const keyJobs: { nfcTagId: string; chip: ChipToAttach; hash: string }[] = [];
        const results: AttachedChip[] = [];
        const now = new Date();

        for (const [index, chip] of chips.entries()) {
            const row = index + 1;
            const hash = hashes[index]!;
            const existing = byHash.get(hash);

            if (existing) {
                const forSku = input.forSkuIds?.[index] ?? null;
                if (existing.currentFor && existing.currentFor.id !== forSku) {
                    throw AppError.conflict(
                        `Row ${row}: this chip is already the chip of another unit.`,
                        SUPPLY_ERROR_CODES.TAG_UID_TAKEN,
                        { row },
                    );
                }
                if (UNUSABLE_STATES.has(existing.lifecycleState) || existing.qcStatus === QcStatus.FAILED) {
                    throw AppError.conflict(
                        `Row ${row}: this chip is ${
                            existing.qcStatus === QcStatus.FAILED ? 'recorded as failed QC' : existing.lifecycleState
                        } and cannot be bound.`,
                        SUPPLY_ERROR_CODES.TAG_UNUSABLE,
                        { row },
                    );
                }
                if (existing.variantId && chip.variantId && existing.variantId !== chip.variantId) {
                    throw AppError.conflict(
                        `Row ${row}: this chip was registered for a different variant.`,
                        SUPPLY_ERROR_CODES.TAG_VARIANT_MISMATCH,
                        { row },
                    );
                }

                const active = existing.keys[0];
                if (active) {
                    // Same keys: an idempotent re-send. Different keys: refuse, so
                    // the chip on file keeps the keys it was written with.
                    if (!(await this.sameKeys(active, chip))) {
                        throw AppError.conflict(
                            `Row ${row}: this chip already has different keys on file.`,
                            SUPPLY_ERROR_CODES.TAG_KEYS_MISMATCH,
                            { row },
                        );
                    }
                    results.push({ nfcTagId: existing.id, created: false, keysWritten: false });
                    continue;
                }

                // Known chip, no keys yet (registered keyless): add them.
                keyJobs.push({ nfcTagId: existing.id, chip, hash });
                results.push({ nfcTagId: existing.id, created: false, keysWritten: true });
                continue;
            }

            const id = randomUUID();
            newTags.push({
                id,
                nfcTagCode: formatTagCode(ordinal++),
                // No consignment: the chip came straight to a unit.
                supplyBatchId: null,
                tagUidHash: hash,
                tagUidEncrypted: cipher.encrypt(chip.uid),
                keyReference: cipher.keyReference,
                qcStatus: QcStatus.PENDING,
                lifecycleState: TagLifecycleState.UNPROVISIONED,
                ...(chip.variantId ? { variantId: chip.variantId } : {}),
            });
            keyJobs.push({ nfcTagId: id, chip, hash });
            results.push({ nfcTagId: id, created: true, keysWritten: true });
        }

        const keyRows = await mapInChunks(keyJobs, WRAP_CHUNK, (job) =>
            this.keyRow(job.nfcTagId, job.chip, job.hash, cipher, wrapper, kmsKeyRef, input.createdById, now),
        );

        try {
            if (newTags.length > 0) await tx.nfcTag.createMany({ data: newTags });
            if (keyRows.length > 0) await tx.nfcTagKey.createMany({ data: keyRows });
        } catch (error) {
            // A concurrent registration took the same chip, or the same chip code.
            if (isUniqueViolation(error)) {
                throw AppError.conflict(
                    'A chip in this request was registered by another request just now. Send it again.',
                    SUPPLY_ERROR_CODES.TAG_UID_TAKEN,
                );
            }
            throw error;
        }
        return results;
    }

    /**
     * Gives already linked chips their keys, in one batch. Refused (nothing is
     * written) when any chip is unknown, unusable, or already has ACTIVE keys:
     * those keys are never overwritten.
     */
    async addKeysManyWithin(
        tx: Prisma.TransactionClient,
        input: {
            items: { nfcTagId: string; key0: string; key1: string; key2: string }[];
            createdById: string | null;
        },
    ): Promise<void> {
        const { wrapper, kmsKeyRef } = this.requireConfigured();
        if (input.items.length === 0) return;

        const tags = await tx.nfcTag.findMany({
            where: { id: { in: input.items.map((item) => item.nfcTagId) } },
            select: {
                id: true,
                tagUidHash: true,
                tagUidEncrypted: true,
                lifecycleState: true,
                keys: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
            },
        });
        const byId = new Map(tags.map((tag) => [tag.id, tag]));

        const rows: { tag: (typeof tags)[number]; item: (typeof input.items)[number]; row: number }[] = [];
        input.items.forEach((item, index) => {
            const row = index + 1;
            const tag = byId.get(item.nfcTagId);
            if (!tag) {
                throw AppError.notFound(`Row ${row}: chip not found.`, SUPPLY_ERROR_CODES.TAG_NOT_FOUND);
            }
            if (UNUSABLE_STATES.has(tag.lifecycleState)) {
                throw AppError.conflict(
                    `Row ${row}: this chip is ${tag.lifecycleState} and cannot be given keys.`,
                    SUPPLY_ERROR_CODES.TAG_UNUSABLE,
                    { row },
                );
            }
            if (tag.keys.length > 0) {
                throw AppError.conflict(
                    `Row ${row}: this chip already has keys. They are never overwritten; re-tag the unit with replace if the chip was re-keyed.`,
                    SUPPLY_ERROR_CODES.TAG_KEYS_EXIST,
                    { row },
                );
            }
            rows.push({ tag, item, row });
        });

        const now = new Date();
        const keyRows = await mapInChunks(rows, WRAP_CHUNK, async ({ tag, item }) => {
            const [key0Wrapped, key1Wrapped, key2Wrapped] = await Promise.all(
                [item.key0, item.key1, item.key2].map((hex) => this.wrap(wrapper, kmsKeyRef, hex)),
            );
            return {
                nfcTagId: tag.id,
                tagUidEncrypted: tag.tagUidEncrypted,
                tagUidHash: tag.tagUidHash,
                key0Wrapped: new Uint8Array(key0Wrapped!),
                key1Wrapped: new Uint8Array(key1Wrapped!),
                key2Wrapped: new Uint8Array(key2Wrapped!),
                kmsKeyRef,
                personalizedAt: now,
                createdById: input.createdById,
            } satisfies Prisma.NfcTagKeyUncheckedCreateInput;
        });
        await tx.nfcTagKey.createMany({ data: keyRows });
    }

    /**
     * Takes a chip out of service (its unit was re-tagged): the chip becomes
     * REVOKED and its ACTIVE keys are revoked, so a tap on the old chip no
     * longer verifies.
     */
    async revokeWithin(
        tx: Prisma.TransactionClient,
        input: { nfcTagId: string; reason: string },
    ): Promise<void> {
        const now = new Date();
        await tx.nfcTag.update({
            where: { id: input.nfcTagId },
            data: { lifecycleState: TagLifecycleState.REVOKED, retiredAt: now },
        });
        await tx.nfcTagKey.updateMany({
            where: { nfcTagId: input.nfcTagId, status: 'ACTIVE' },
            data: { status: 'REVOKED', revokedAt: now, revokeReason: input.reason.slice(0, 500) },
        });
    }

    // ── internals ───────────────────────────────────────────────────────────

    private requireConfigured(): { cipher: ITagCipher; wrapper: IKeyWrapper; kmsKeyRef: string } {
        const { cipher, wrapper, kmsKeyRef } = this.deps;
        if (!cipher) {
            throw new AppError(
                'Chip registration is not configured on this deployment (no tag UID key).',
                503,
                SUPPLY_ERROR_CODES.TAG_KEY_UNAVAILABLE,
            );
        }
        if (!wrapper || !kmsKeyRef) {
            throw new AppError(
                'Chip keys cannot be stored: no key wrapper is configured on this deployment.',
                503,
                SUPPLY_ERROR_CODES.KEY_WRAPPER_UNAVAILABLE,
            );
        }
        return { cipher, wrapper, kmsKeyRef };
    }

    private async wrap(wrapper: IKeyWrapper, kmsKeyRef: string, hex: string): Promise<Buffer> {
        const plain = hexToBuffer(hex);
        try {
            return await wrapper.wrap(plain, kmsKeyRef);
        } finally {
            plain.fill(0);
        }
    }

    private async keyRow(
        nfcTagId: string,
        chip: ChipToAttach,
        hash: string,
        cipher: ITagCipher,
        wrapper: IKeyWrapper,
        kmsKeyRef: string,
        createdById: string | null,
        now: Date,
    ): Promise<Prisma.NfcTagKeyUncheckedCreateInput> {
        const [key0Wrapped, key1Wrapped, key2Wrapped] = await Promise.all(
            [chip.key0, chip.key1, chip.key2].map((hex) => this.wrap(wrapper, kmsKeyRef, hex)),
        );
        return {
            nfcTagId,
            tagUidEncrypted: cipher.encrypt(chip.uid),
            tagUidHash: hash,
            key0Wrapped: new Uint8Array(key0Wrapped!),
            key1Wrapped: new Uint8Array(key1Wrapped!),
            key2Wrapped: new Uint8Array(key2Wrapped!),
            kmsKeyRef,
            // The vendor already wrote them onto the chip.
            personalizedAt: now,
            createdById,
        };
    }

    /** Constant-time comparison of the supplied keys with the ACTIVE wrapped ones. */
    private async sameKeys(
        active: { key0Wrapped: Uint8Array; key1Wrapped: Uint8Array; key2Wrapped: Uint8Array; kmsKeyRef: string },
        chip: ChipToAttach,
    ): Promise<boolean> {
        const { wrapper } = this.deps;
        if (!wrapper) return false;
        const pairs: [Uint8Array, string][] = [
            [active.key0Wrapped, chip.key0],
            [active.key1Wrapped, chip.key1],
            [active.key2Wrapped, chip.key2],
        ];
        let same = true;
        for (const [wrapped, hex] of pairs) {
            const stored = await wrapper.unwrap(Buffer.from(wrapped), active.kmsKeyRef);
            const given = hexToBuffer(hex);
            try {
                if (stored.length !== given.length || !timingSafeEqual(stored, given)) same = false;
            } finally {
                stored.fill(0);
                given.fill(0);
            }
        }
        return same;
    }
}

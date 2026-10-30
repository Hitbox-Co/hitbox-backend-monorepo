import { randomBytes } from 'node:crypto';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    SUPPLY_AUDIT_EVENTS,
    SUPPLY_ERROR_CODES,
    SUPPLY_EVENTS,
} from '../constants/supply.constant';
import type { IKeyWrapper } from '../domain/interfaces/key-wrapper.interface';
import type { ISupplyAudit } from '../domain/interfaces/supply-audit.interface';
import type { ITagCipher } from '../domain/interfaces/tag-cipher.interface';
import { requireTagAccess, requireWrite } from '../domain/supply-access';
import type { SupplyAccess } from '../domain/supply-access';
import type {
    GenerateBatchTagKeysDto,
    GeneratedBatchTagKeys,
    GeneratedTagKeys,
    RevokeTagKeysDto,
    TagKeyView,
} from '../dto/nfc-tag-key.dto';
import type {
    KeyableTag,
    NewTagKey,
    NfcTagKeyRepository,
    TagKeyRow,
} from '../repository/nfc-tag-key.repository';

/** What the chip's URL starts as; `e` and `c` are zero placeholders the chip overwrites. */
export const DEFAULT_TAP_URL_BASE = 'https://hitboxcollectibles.com/verify';
const E_PLACEHOLDER = '0'.repeat(32);
const C_PLACEHOLDER = '0'.repeat(16);

interface NfcTagKeyServiceDeps {
    keys: NfcTagKeyRepository;
    eventBus: IEventBus;
    audit: ISupplyAudit;
    logger: Logger;
    /** Absent: key generation answers 503. There is no unwrapped fallback. */
    keyWrapper?: IKeyWrapper | undefined;
    /** Which KMS key wraps new rows. Stored on the row, so it can be rotated. */
    kmsKeyRef?: string | undefined;
    /** Needed to read the chip UID for the URL / CSV. */
    tagCipher?: ITagCipher | undefined;
    tapUrlBase?: string | undefined;
}

export interface TagKeyMutationContext {
    access: SupplyAccess;
    correlationId: string;
}

/**
 * Per-tag keys for NTAG 424 DNA chips: every chip has its own Key 00/01/02.
 *
 * What this service never does: log a key or a UID, return a key other than in
 * the generate responses, write one to an audit row or an event, or keep one in
 * a field. Plaintext keys exist as local Buffers and are zeroed afterwards.
 * It never updates or deletes an `NfcTag` column.
 */
export class NfcTagKeyService {
    constructor(private readonly deps: NfcTagKeyServiceDeps) { }

    async getActiveKey(access: SupplyAccess, nfcTagId: string): Promise<TagKeyView | null> {
        requireTagAccess(access);
        const row = await this.deps.keys.findActiveForTag(nfcTagId);
        return row ? toView(row) : null;
    }

    /**
     * Generates Key 00/01/02 for one chip, wraps them, stores one ACTIVE row
     * and returns the plaintext once, with the URL to write onto the chip.
     */
    async generateTagKeys(
        context: TagKeyMutationContext,
        nfcTagId: string,
    ): Promise<GeneratedTagKeys> {
        requireWrite(context.access);
        requireTagAccess(context.access);
        const { keyWrapper, kmsKeyRef, tagCipher } = this.requireConfigured();

        const tag = await this.deps.keys.findTag(nfcTagId);
        if (!tag) {
            throw AppError.notFound('No chip with that id', SUPPLY_ERROR_CODES.TAG_NOT_FOUND);
        }
        if (await this.deps.keys.hasActiveKey(tag.id)) {
            throw keysExistError();
        }

        const plain = generateDistinctKeys();
        try {
            const wrapped = await wrapAll(keyWrapper, plain, kmsKeyRef);
            let row: TagKeyRow;
            try {
                row = await this.deps.keys.create(
                    toNewKey(tag, wrapped, kmsKeyRef, context.access.userId),
                );
            } catch (error) {
                if (isUniqueViolation(error)) throw keysExistError();
                throw error;
            }

            await this.deps.audit.record({
                eventType: SUPPLY_AUDIT_EVENTS.TAG_KEYS_GENERATE,
                actorId: context.access.userId,
                organizationId: null,
                resourceType: 'NfcTagKey',
                resourceId: row.id,
                result: 'SUCCESS',
                correlationId: context.correlationId,
                // Identifiers only. No key, no UID.
                metadata: { nfcTagId: tag.id, kmsKeyRef, keyVersion: row.keyVersion },
            });
            this.deps.eventBus.publish(SUPPLY_EVENTS.TAG_KEYS_GENERATED, {
                nfcTagKeyId: row.id,
                nfcTagId: tag.id,
                count: 1,
            });

            const uid = tagCipher.decrypt(tag.tagUidEncrypted);
            return {
                key: toView(row),
                nfcTagCode: tag.nfcTagCode,
                uid,
                keys: {
                    key0: plain[0].toString('hex'),
                    key1: plain[1].toString('hex'),
                    key2: plain[2].toString('hex'),
                },
                url: this.urlFor(uid),
            };
        } finally {
            wipe(plain);
        }
    }

    /**
     * Keys up to `limit` of a consignment's chips that have no ACTIVE row, for
     * the programming station. All rows are generated, wrapped and inserted in
     * one transaction before anything is returned, so a failure never leaves a
     * chip keyed with keys nobody received.
     */
    async generateKeysForBatch(
        context: TagKeyMutationContext,
        supplyBatchId: string,
        dto: GenerateBatchTagKeysDto,
    ): Promise<GeneratedBatchTagKeys> {
        requireWrite(context.access);
        requireTagAccess(context.access);
        const { keyWrapper, kmsKeyRef, tagCipher } = this.requireConfigured();

        if (!(await this.deps.keys.batchExists(supplyBatchId))) {
            throw AppError.notFound('No consignment with that id', SUPPLY_ERROR_CODES.BATCH_NOT_FOUND);
        }
        const tags = await this.deps.keys.tagsNeedingKeys(supplyBatchId, dto.limit);
        if (tags.length === 0) {
            throw AppError.conflict(
                'Every chip in this consignment already has active keys.',
                SUPPLY_ERROR_CODES.NO_TAGS_NEED_KEYS,
            );
        }

        const allPlain: Buffer[] = [];
        try {
            const inputs: NewTagKey[] = [];
            const lines: string[] = ['nfcTagCode,uid,key00,key01,key02,url'];
            for (const tag of tags) {
                const plain = generateDistinctKeys();
                allPlain.push(...plain);
                inputs.push(
                    toNewKey(
                        tag,
                        await wrapAll(keyWrapper, plain, kmsKeyRef),
                        kmsKeyRef,
                        context.access.userId,
                    ),
                );
                const uid = tagCipher.decrypt(tag.tagUidEncrypted);
                lines.push(
                    [
                        tag.nfcTagCode,
                        uid,
                        plain[0].toString('hex'),
                        plain[1].toString('hex'),
                        plain[2].toString('hex'),
                        this.urlFor(uid),
                    ].join(','),
                );
            }

            let rows: TagKeyRow[];
            try {
                rows = await this.deps.keys.createMany(inputs);
            } catch (error) {
                // Another request keyed one of these chips between our read and write.
                if (isUniqueViolation(error)) throw keysExistError();
                throw error;
            }

            await this.deps.audit.record({
                eventType: SUPPLY_AUDIT_EVENTS.TAG_KEYS_GENERATE,
                actorId: context.access.userId,
                organizationId: null,
                resourceType: 'SupplyBatch',
                resourceId: supplyBatchId,
                result: 'SUCCESS',
                correlationId: context.correlationId,
                // A count, never UIDs or keys.
                metadata: { generated: rows.length, kmsKeyRef },
            });
            this.deps.eventBus.publish(SUPPLY_EVENTS.TAG_KEYS_GENERATED, {
                supplyBatchId,
                count: rows.length,
            });

            return {
                supplyBatchId,
                generated: rows.length,
                remaining: await this.deps.keys.countTagsNeedingKeys(supplyBatchId),
                filename: `tag-keys-${supplyBatchId}.csv`,
                csv: lines.join('\n') + '\n',
                warning:
                    'This file contains secret keys and chip UIDs. It is shown once and cannot be ' +
                    'fetched again. Delete it as soon as the chips are programmed.',
            };
        } finally {
            wipe(allPlain);
        }
    }

    /** Records that the keys were written onto the chip. Touches that key row only. */
    async markTagPersonalized(
        context: TagKeyMutationContext,
        nfcTagKeyId: string,
    ): Promise<TagKeyView> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const before = await this.requireKey(nfcTagKeyId);
        const updated = await this.deps.keys.markPersonalized(nfcTagKeyId, new Date());
        if (!updated) {
            throw before.status !== 'ACTIVE'
                ? AppError.conflict(
                    'These keys are revoked.',
                    SUPPLY_ERROR_CODES.TAG_KEYS_NOT_ACTIVE,
                )
                : AppError.conflict(
                    'These keys were already recorded as written to the chip.',
                    SUPPLY_ERROR_CODES.TAG_KEYS_ALREADY_PERSONALIZED,
                );
        }
        const after = await this.requireKey(nfcTagKeyId);

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAG_KEYS_PERSONALIZE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'NfcTagKey',
            resourceId: nfcTagKeyId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            metadata: { nfcTagId: after.nfcTagId },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.TAG_KEYS_PERSONALIZED, {
            nfcTagKeyId,
            nfcTagId: after.nfcTagId,
        });
        return toView(after);
    }

    /**
     * Revokes the chip's ACTIVE keys: it fails verification (NO_KEYS) until it
     * is re-keyed. Re-keying creates a new row; the old row is kept.
     */
    async revokeTagKeys(
        context: TagKeyMutationContext,
        nfcTagId: string,
        dto: RevokeTagKeysDto,
    ): Promise<TagKeyView> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        if (!(await this.deps.keys.findTag(nfcTagId))) {
            throw AppError.notFound('No chip with that id', SUPPLY_ERROR_CODES.TAG_NOT_FOUND);
        }
        const active = await this.deps.keys.findActiveForTag(nfcTagId);
        const revoked = await this.deps.keys.revokeActive({
            nfcTagId,
            reason: dto.reason,
            now: new Date(),
        });
        if (!revoked || !active) {
            throw AppError.conflict(
                'This chip has no active keys to revoke.',
                SUPPLY_ERROR_CODES.TAG_KEYS_NOT_ACTIVE,
            );
        }
        const after = await this.requireKey(active.id);

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAG_KEYS_REVOKE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'NfcTagKey',
            resourceId: active.id,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { status: 'ACTIVE' },
            after: { status: after.status },
            metadata: { nfcTagId, reason: dto.reason },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.TAG_KEYS_REVOKED, {
            nfcTagKeyId: active.id,
            nfcTagId,
        });
        this.deps.logger.warn({ nfcTagId }, 'NFC tag keys revoked');
        return toView(after);
    }

    private requireConfigured() {
        const { keyWrapper, kmsKeyRef, tagCipher } = this.deps;
        if (!keyWrapper || !kmsKeyRef) {
            throw new AppError(
                'Key generation is unavailable: no key wrapper is configured on this deployment.',
                503,
                SUPPLY_ERROR_CODES.KEY_WRAPPER_UNAVAILABLE,
            );
        }
        if (!tagCipher) {
            throw new AppError(
                'Key generation is unavailable: no tag UID key is configured on this deployment.',
                503,
                SUPPLY_ERROR_CODES.TAG_UID_KEY_UNAVAILABLE,
            );
        }
        return { keyWrapper, kmsKeyRef, tagCipher };
    }

    private async requireKey(id: string): Promise<TagKeyRow> {
        const row = await this.deps.keys.findById(id);
        if (!row) {
            throw AppError.notFound('No key row with that id', SUPPLY_ERROR_CODES.TAG_KEY_NOT_FOUND);
        }
        return row;
    }

    private urlFor(uid: string): string {
        const base = this.deps.tapUrlBase ?? DEFAULT_TAP_URL_BASE;
        return `${base}?u=${uid}&e=${E_PLACEHOLDER}&c=${C_PLACEHOLDER}`;
    }
}

/** Three random AES-128 keys, all different from each other. */
function generateDistinctKeys(): [Buffer, Buffer, Buffer] {
    for (;;) {
        const keys: [Buffer, Buffer, Buffer] = [randomBytes(16), randomBytes(16), randomBytes(16)];
        if (
            !keys[0].equals(keys[1]) &&
            !keys[0].equals(keys[2]) &&
            !keys[1].equals(keys[2])
        ) {
            return keys;
        }
        wipe(keys);
    }
}

async function wrapAll(
    wrapper: IKeyWrapper,
    plain: [Buffer, Buffer, Buffer],
    kmsKeyRef: string,
): Promise<[Buffer, Buffer, Buffer]> {
    const [k0, k1, k2] = await Promise.all(plain.map((key) => wrapper.wrap(key, kmsKeyRef)));
    return [k0!, k1!, k2!];
}

function toNewKey(
    tag: KeyableTag,
    wrapped: [Buffer, Buffer, Buffer],
    kmsKeyRef: string,
    createdById: string | null,
): NewTagKey {
    return {
        nfcTagId: tag.id,
        tagUidEncrypted: tag.tagUidEncrypted,
        tagUidHash: tag.tagUidHash,
        key0Wrapped: wrapped[0],
        key1Wrapped: wrapped[1],
        key2Wrapped: wrapped[2],
        kmsKeyRef,
        createdById,
    };
}

function wipe(buffers: Buffer[]): void {
    for (const buffer of buffers) buffer.fill(0);
}

function keysExistError(): AppError {
    return AppError.conflict(
        'This chip already has active keys. Revoke them before generating new ones.',
        SUPPLY_ERROR_CODES.TAG_KEYS_EXIST,
    );
}

function toView(row: TagKeyRow): TagKeyView {
    return {
        id: row.id,
        publicCode: row.publicCode,
        nfcTagId: row.nfcTagId,
        kmsKeyRef: row.kmsKeyRef,
        keyVersion: row.keyVersion,
        status: row.status,
        lastTapCounter: row.lastTapCounter,
        lastTapAt: row.lastTapAt?.toISOString() ?? null,
        personalizedAt: row.personalizedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        revokeReason: row.revokeReason,
        createdAt: row.createdAt.toISOString(),
    };
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'P2002'
    );
}

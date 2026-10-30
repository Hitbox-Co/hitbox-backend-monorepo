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
import { requireTagAccess, requireWrite } from '../domain/supply-access';
import type { SupplyAccess } from '../domain/supply-access';
import type {
    CreatedKeySet,
    CreateKeySetDto,
    KeySetView,
    ListKeySetsQuery,
    PersonaliseResult,
    PersonaliseTagsDto,
    RetireKeySetDto,
} from '../dto/nfc-key-set.dto';
import type { KeySetRow, NfcKeySetRepository } from '../repository/nfc-key-set.repository';

interface NfcKeySetServiceDeps {
    keys: NfcKeySetRepository;
    eventBus: IEventBus;
    audit: ISupplyAudit;
    logger: Logger;
    /**
     * Absent when no wrapper is configured. Creating a key set is then refused
     * with a 503: keys must never be stored unwrapped, and there is no
     * fallback that would make that safe.
     */
    keyWrapper?: IKeyWrapper | undefined;
    /** Which KMS key wraps new sets. Stored on the row, so it can be rotated. */
    kmsKeyRef?: string | undefined;
}

export interface KeySetMutationContext {
    access: SupplyAccess;
    correlationId: string;
}

/**
 * Batch keys for NTAG 424 DNA chips.
 *
 * What this service never does: log a key, return one other than in the single
 * `createKeySet` response, write one to an audit row or an event, or keep one
 * in a field. Plaintext keys exist as local Buffers inside `createKeySet` and
 * are zeroed before it returns.
 */
export class NfcKeySetService {
    constructor(private readonly deps: NfcKeySetServiceDeps) { }

    async listKeySets(access: SupplyAccess, query: ListKeySetsQuery): Promise<KeySetView[]> {
        requireTagAccess(access);
        return (await this.deps.keys.list(query)).map(toView);
    }

    /**
     * Generates Key 00, 01 and 02, wraps each, stores the wrapped blobs, and
     * returns the plaintext keys in this response only — for the person
     * programming the chips. Calling it again makes a new set; the old
     * plaintext cannot be fetched again by anyone.
     */
    async createKeySet(
        context: KeySetMutationContext,
        dto: CreateKeySetDto,
    ): Promise<CreatedKeySet> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const { keyWrapper, kmsKeyRef } = this.deps;
        if (!keyWrapper || !kmsKeyRef) {
            throw new AppError(
                'Key creation is unavailable: no key wrapper is configured on this deployment.',
                503,
                SUPPLY_ERROR_CODES.KEY_WRAPPER_UNAVAILABLE,
            );
        }

        if (dto.supplyBatchId && !(await this.deps.keys.batchExists(dto.supplyBatchId))) {
            throw AppError.notFound('No consignment with that id', SUPPLY_ERROR_CODES.BATCH_NOT_FOUND);
        }

        const plain = generateDistinctKeys();
        try {
            const [key0Wrapped, key1Wrapped, key2Wrapped] = await Promise.all(
                plain.map((key) => keyWrapper.wrap(key, kmsKeyRef)),
            );

            let row: KeySetRow;
            try {
                row = await this.deps.keys.create({
                    keySetCode: dto.keySetCode,
                    supplyBatchId: dto.supplyBatchId ?? null,
                    key0Wrapped: key0Wrapped!,
                    key1Wrapped: key1Wrapped!,
                    key2Wrapped: key2Wrapped!,
                    kmsKeyRef,
                    createdById: context.access.userId,
                });
            } catch (error) {
                if (isUniqueViolation(error)) {
                    throw AppError.conflict(
                        'A key set with that code already exists.',
                        SUPPLY_ERROR_CODES.KEY_SET_CODE_TAKEN,
                    );
                }
                throw error;
            }

            await this.deps.audit.record({
                eventType: SUPPLY_AUDIT_EVENTS.KEY_SET_CREATE,
                actorId: context.access.userId,
                organizationId: null,
                resourceType: 'NfcKeySet',
                resourceId: row.id,
                result: 'SUCCESS',
                correlationId: context.correlationId,
                // Identifiers only. No key, wrapped or plain, ever goes here.
                metadata: {
                    keySetCode: row.keySetCode,
                    supplyBatchId: row.supplyBatchId,
                    kmsKeyRef: row.kmsKeyRef,
                    keyVersion: row.keyVersion,
                },
            });
            this.deps.eventBus.publish(SUPPLY_EVENTS.KEY_SET_CREATED, {
                keySetId: row.id,
                supplyBatchId: row.supplyBatchId,
            });

            return {
                ...toView(row),
                keys: {
                    key0: plain[0]!.toString('hex'),
                    key1: plain[1]!.toString('hex'),
                    key2: plain[2]!.toString('hex'),
                },
            };
        } finally {
            for (const key of plain) key.fill(0);
        }
    }

    /**
     * Gives a consignment's not-yet-keyed chips this key set. Only an ACTIVE
     * set can be handed out, and only to a consignment that exists.
     */
    async personaliseBatchTags(
        context: KeySetMutationContext,
        keySetId: string,
        dto: PersonaliseTagsDto,
    ): Promise<PersonaliseResult> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const keySet = await this.requireKeySet(keySetId);
        if (keySet.status !== 'ACTIVE') {
            throw AppError.conflict(
                'This key set is retired and cannot be given to chips.',
                SUPPLY_ERROR_CODES.KEY_SET_RETIRED,
            );
        }
        if (!(await this.deps.keys.batchExists(dto.supplyBatchId))) {
            throw AppError.notFound('No consignment with that id', SUPPLY_ERROR_CODES.BATCH_NOT_FOUND);
        }

        const personalised = await this.deps.keys.personaliseBatch({
            keySetId,
            supplyBatchId: dto.supplyBatchId,
            now: new Date(),
        });

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.TAGS_PERSONALISE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'SupplyBatch',
            resourceId: dto.supplyBatchId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            // A count, never UIDs.
            metadata: { keySetId, personalised },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.TAGS_PERSONALISED, {
            keySetId,
            supplyBatchId: dto.supplyBatchId,
            personalised,
        });

        return { keySetId, supplyBatchId: dto.supplyBatchId, personalised };
    }

    /**
     * The response to a leaked key: every chip in the set fails verification
     * from now on. One-way — there is no un-retire; make a new set and
     * re-personalise the chips instead.
     */
    async retireKeySet(
        context: KeySetMutationContext,
        keySetId: string,
        dto: RetireKeySetDto,
    ): Promise<KeySetView> {
        requireWrite(context.access);
        requireTagAccess(context.access);

        const before = await this.requireKeySet(keySetId);
        const retired = await this.deps.keys.retire({
            id: keySetId,
            reason: dto.reason,
            now: new Date(),
        });
        if (!retired) {
            throw AppError.conflict(
                'This key set is already retired.',
                SUPPLY_ERROR_CODES.KEY_SET_RETIRED,
            );
        }
        const after = await this.requireKeySet(keySetId);

        await this.deps.audit.record({
            eventType: SUPPLY_AUDIT_EVENTS.KEY_SET_RETIRE,
            actorId: context.access.userId,
            organizationId: null,
            resourceType: 'NfcKeySet',
            resourceId: keySetId,
            result: 'SUCCESS',
            correlationId: context.correlationId,
            before: { status: before.status },
            after: { status: after.status },
            metadata: { keySetCode: after.keySetCode, reason: dto.reason },
        });
        this.deps.eventBus.publish(SUPPLY_EVENTS.KEY_SET_RETIRED, { keySetId });
        this.deps.logger.warn({ keySetId }, 'NFC key set retired');

        return toView(after);
    }

    private async requireKeySet(id: string): Promise<KeySetRow> {
        const row = await this.deps.keys.findById(id);
        if (!row) {
            throw AppError.notFound('No key set with that id', SUPPLY_ERROR_CODES.KEY_SET_NOT_FOUND);
        }
        return row;
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
        for (const key of keys) key.fill(0);
    }
}

function toView(row: KeySetRow): KeySetView {
    return {
        id: row.id,
        publicCode: row.publicCode,
        keySetCode: row.keySetCode,
        supplyBatchId: row.supplyBatchId,
        kmsKeyRef: row.kmsKeyRef,
        keyVersion: row.keyVersion,
        status: row.status,
        retiredAt: row.retiredAt?.toISOString() ?? null,
        retireReason: row.retireReason,
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

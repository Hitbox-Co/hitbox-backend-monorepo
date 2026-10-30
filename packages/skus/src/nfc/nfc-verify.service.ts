import { randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '@hitbox/shared';
import { Prisma } from '@hitbox/database';
import type { PrismaClient } from '@hitbox/database';
import type { Logger } from 'pino';
import type { KeyWrapper } from '../domain/interfaces/key-wrapper.interface';
import { decryptPicc, verifySdmMac } from './sun-crypto';

/**
 * Why a tap was refused. Written to `NfcVerification.reasonCode` and read by
 * people investigating — and NEVER returned to the caller. Telling a prober
 * which step failed tells them which part of a forged URL to fix next.
 */
export const NFC_TAP_REASON = {
    UNKNOWN_BATCH: 'UNKNOWN_BATCH',
    KEY_SET_RETIRED: 'KEY_SET_RETIRED',
    BAD_PICC: 'BAD_PICC',
    UNKNOWN_TAG: 'UNKNOWN_TAG',
    BATCH_MISMATCH: 'BATCH_MISMATCH',
    TAG_NOT_ACTIVE: 'TAG_NOT_ACTIVE',
    BAD_CMAC: 'BAD_CMAC',
    /** The chip is genuine but is not embedded in any unit yet. */
    NO_ITEM: 'NO_ITEM',
    REPLAY: 'REPLAY',
    // Per-tag keys (`u` in the URL).
    BAD_FORMAT: 'BAD_FORMAT',
    /** The chip has no ACTIVE NfcTagKey row (never keyed, or revoked). */
    NO_KEYS: 'NO_KEYS',
    /** `e` decrypted to a different UID than the one written in `u`. */
    UID_MISMATCH: 'UID_MISMATCH',
} as const;
export type NfcTapReason = (typeof NFC_TAP_REASON)[keyof typeof NFC_TAP_REASON];

interface NfcTapBase {
    /** 32 hex — encrypted PICC data. */
    e: string;
    /** 16 hex — the SDM MAC. */
    c: string;
    requestId: string;
}

/**
 * A tap URL carries either `u` (per-tag keys) or `b` (batch keys), never both.
 */
export type NfcTapInput = NfcTapBase &
    (
        | {
            /**
             * The chip UID, 14 hex, written into the URL as plain text. A lookup
             * hint only: anyone can edit it, so it is never trusted on its own —
             * the UID inside `e` must match it.
             */
            u: string;
            b?: undefined;
        }
        | {
            /**
             * Which batch's keys to use: either the long `NfcKeySet.publicCode`
             * (`nks…`) or the short operator-chosen `NfcKeySet.keySetCode` (e.g. `101`).
             * A lookup label only — knowing it grants nothing, the keys do the work.
             */
            b: string;
            u?: undefined;
        }
    );

export type TapVerification =
    | {
        ok: true;
        nfcTagId: string;
        /** The unit the chip is embedded in (`Sku.currentNfcTagId`). */
        skuId: string;
        /** Set for a batch-key (`b`) tap. */
        keySetId?: string;
        /** Set for a per-tag-key (`u`) tap. */
        nfcTagKeyId?: string;
        counter: number;
    }
    | { ok: false; reason: NfcTapReason };

/** The shape claims depends on — verification, as a function. */
export interface INfcTapVerifier {
    verifyTap(input: NfcTapInput): Promise<TapVerification>;
}

interface NfcVerifyDeps {
    prisma: PrismaClient;
    keyWrapper: KeyWrapper;
    /** `ITagCipher.hash` — the existing chip-UID hash. No second hash key. */
    tagUidHash: (uid: string) => string;
    logger: Logger;
}

/** `nks` + 19 Crockford base32 characters — see packages/shared/database/src/public-code.ts. */
const PUBLIC_CODE = /^nks[0-9a-hjkmnp-tv-z]{19}$/;
const UID_HEX = /^[0-9A-Fa-f]{14}$/;
const E_HEX = /^[0-9A-Fa-f]{32}$/;
const C_HEX = /^[0-9A-Fa-f]{16}$/;
const ACCEPTED_LIFECYCLE = new Set(['BOUND', 'ACTIVE']);
const CODE_ATTEMPTS = 5;

/**
 * Authenticates one tap of an NTAG 424 DNA chip.
 *
 * The checks run in a fixed order, cheapest and least revealing first, and
 * each failure is logged with its reason:
 *
 *   batch → key set active → unwrap keys → decrypt `e` → chip by UID hash →
 *   chip belongs to that batch → chip BOUND/ACTIVE → MAC `c` → chip is in a
 *   unit → counter strictly higher than the last (atomic).
 *
 * The counter is consumed only after everything else has passed, so a forged
 * URL can never burn a real chip's counter. Plaintext keys live in local
 * Buffers for the length of one call and are zeroed afterwards.
 */
export class NfcVerifyService implements INfcTapVerifier {
    constructor(private readonly deps: NfcVerifyDeps) { }

    async verifyTap(input: NfcTapInput): Promise<TapVerification> {
        if (input.u !== undefined) return this.verifyPerTag(input, input.u);
        return this.verifyBatch(input, input.b);
    }

    /**
     * Per-tag keys (`u`): every chip has its own Key 01 / Key 02.
     *
     *   format → chip by UID hash → BOUND/ACTIVE → ACTIVE key row → unwrap →
     *   decrypt `e` → UID in `e` equals `u` → MAC `c` → chip is in a unit →
     *   counter strictly higher (atomic, on the key row).
     *
     * The counter lives on `NfcTagKey`, not `NfcTag`, so a new key row starts at
     * -1 and no existing NfcTag value is touched.
     */
    private async verifyPerTag(input: NfcTapInput, uRaw: string): Promise<TapVerification> {
        const { prisma } = this.deps;

        if (!UID_HEX.test(uRaw) || !E_HEX.test(input.e) || !C_HEX.test(input.c)) {
            return this.reject(input, NFC_TAP_REASON.BAD_FORMAT, {});
        }
        const u = uRaw.toUpperCase();

        const tag = await prisma.nfcTag.findUnique({
            where: { tagUidHash: this.deps.tagUidHash(u) },
            select: {
                id: true,
                tagUidHash: true,
                lifecycleState: true,
                currentFor: { select: { id: true } },
            },
        });
        if (!tag) return this.reject(input, NFC_TAP_REASON.UNKNOWN_TAG, {});
        const tagLog: LogFields = { nfcTagId: tag.id };
        if (!ACCEPTED_LIFECYCLE.has(tag.lifecycleState)) {
            return this.reject(input, NFC_TAP_REASON.TAG_NOT_ACTIVE, tagLog);
        }

        const keyRow = await prisma.nfcTagKey.findFirst({
            where: { nfcTagId: tag.id, status: 'ACTIVE' },
            select: {
                id: true,
                tagUidHash: true,
                kmsKeyRef: true,
                key1Wrapped: true,
                key2Wrapped: true,
            },
        });
        // A key row recording a different chip's UID is as unusable as none.
        if (!keyRow || (keyRow.tagUidHash && keyRow.tagUidHash !== tag.tagUidHash)) {
            return this.reject(input, NFC_TAP_REASON.NO_KEYS, tagLog);
        }
        const keyLog: LogFields = { ...tagLog, nfcTagKeyId: keyRow.id };

        let key1: Buffer | undefined;
        let key2: Buffer | undefined;
        try {
            try {
                [key1, key2] = await Promise.all([
                    this.deps.keyWrapper.unwrap(Buffer.from(keyRow.key1Wrapped), keyRow.kmsKeyRef),
                    this.deps.keyWrapper.unwrap(Buffer.from(keyRow.key2Wrapped), keyRow.kmsKeyRef),
                ]);
            } catch (error) {
                this.deps.logger.error(
                    { nfcTagKeyId: keyRow.id, err: error instanceof Error ? error.name : 'unknown' },
                    'could not unwrap NFC tag keys',
                );
                throw new AppError('Verification is temporarily unavailable.', 500);
            }

            const picc = decryptPicc(input.e, key1);
            if (!picc) return this.reject(input, NFC_TAP_REASON.BAD_PICC, keyLog);
            const counterLog = { ...keyLog, counter: picc.counter };

            // `u` is plain text anyone can edit; the UID the chip encrypted into
            // `e` is the one that counts. Constant time, as with the MAC.
            if (!timingSafeEqual(picc.uid, Buffer.from(u, 'hex'))) {
                return this.reject(input, NFC_TAP_REASON.UID_MISMATCH, counterLog);
            }
            if (!verifySdmMac(input.c, key2, picc)) {
                return this.reject(input, NFC_TAP_REASON.BAD_CMAC, counterLog);
            }
            if (!tag.currentFor) {
                return this.reject(input, NFC_TAP_REASON.NO_ITEM, counterLog);
            }
            const skuLog = { ...counterLog, skuId: tag.currentFor.id };

            // The one write that decides a replay. Atomic: two simultaneous taps
            // with the same counter cannot both update the row.
            const advanced = await prisma.nfcTagKey.updateMany({
                where: { id: keyRow.id, lastTapCounter: { lt: picc.counter } },
                data: { lastTapCounter: picc.counter, lastTapAt: new Date() },
            });
            if (advanced.count !== 1) return this.reject(input, NFC_TAP_REASON.REPLAY, skuLog);

            await this.log(input, { ...skuLog, result: 'VERIFIED', reasonCode: null });
            return {
                ok: true,
                nfcTagId: tag.id,
                skuId: tag.currentFor.id,
                nfcTagKeyId: keyRow.id,
                counter: picc.counter,
            };
        } finally {
            key1?.fill(0);
            key2?.fill(0);
        }
    }

    /** Batch keys (`b`): one key set shared by every chip of a batch. */
    private async verifyBatch(input: NfcTapInput, b: string): Promise<TapVerification> {
        const { prisma } = this.deps;

        const keySet = await prisma.nfcKeySet.findUnique({
            where: PUBLIC_CODE.test(b) ? { publicCode: b } : { keySetCode: b },
            select: {
                id: true,
                status: true,
                kmsKeyRef: true,
                key1Wrapped: true,
                key2Wrapped: true,
            },
        });
        if (!keySet) return this.reject(input, NFC_TAP_REASON.UNKNOWN_BATCH, {});
        const log = { keySetId: keySet.id };
        if (keySet.status !== 'ACTIVE') {
            return this.reject(input, NFC_TAP_REASON.KEY_SET_RETIRED, log);
        }

        let key1: Buffer | undefined;
        let key2: Buffer | undefined;
        try {
            try {
                [key1, key2] = await Promise.all([
                    this.deps.keyWrapper.unwrap(Buffer.from(keySet.key1Wrapped), keySet.kmsKeyRef),
                    this.deps.keyWrapper.unwrap(Buffer.from(keySet.key2Wrapped), keySet.kmsKeyRef),
                ]);
            } catch (error) {
                // A server-side fault, not a tampered URL: not logged as a
                // rejection, and nothing about the cause reaches the caller.
                this.deps.logger.error(
                    { keySetId: keySet.id, err: error instanceof Error ? error.name : 'unknown' },
                    'could not unwrap NFC batch keys',
                );
                throw new AppError('Verification is temporarily unavailable.', 500);
            }

            const picc = decryptPicc(input.e, key1);
            if (!picc) return this.reject(input, NFC_TAP_REASON.BAD_PICC, log);

            const tag = await prisma.nfcTag.findUnique({
                where: { tagUidHash: this.deps.tagUidHash(picc.uidHex) },
                select: {
                    id: true,
                    keySetId: true,
                    lifecycleState: true,
                    currentFor: { select: { id: true } },
                },
            });
            if (!tag) return this.reject(input, NFC_TAP_REASON.UNKNOWN_TAG, log);
            const tagLog = { ...log, nfcTagId: tag.id, counter: picc.counter };

            if (tag.keySetId !== keySet.id) {
                return this.reject(input, NFC_TAP_REASON.BATCH_MISMATCH, tagLog);
            }
            if (!ACCEPTED_LIFECYCLE.has(tag.lifecycleState)) {
                return this.reject(input, NFC_TAP_REASON.TAG_NOT_ACTIVE, tagLog);
            }
            if (!verifySdmMac(input.c, key2, picc)) {
                return this.reject(input, NFC_TAP_REASON.BAD_CMAC, tagLog);
            }
            if (!tag.currentFor) {
                return this.reject(input, NFC_TAP_REASON.NO_ITEM, tagLog);
            }
            const skuLog = { ...tagLog, skuId: tag.currentFor.id };

            // The one write that decides a replay: only a strictly higher
            // counter updates the row, and the database makes that atomic, so
            // two simultaneous taps with the same counter cannot both pass.
            const advanced = await prisma.nfcTag.updateMany({
                where: { id: tag.id, lastTapCounter: { lt: picc.counter } },
                data: { lastTapCounter: picc.counter },
            });
            if (advanced.count !== 1) return this.reject(input, NFC_TAP_REASON.REPLAY, skuLog);

            await this.log(input, { ...skuLog, result: 'VERIFIED', reasonCode: null });
            return {
                ok: true,
                nfcTagId: tag.id,
                skuId: tag.currentFor.id,
                keySetId: keySet.id,
                counter: picc.counter,
            };
        } finally {
            key1?.fill(0);
            key2?.fill(0);
        }
    }

    private async reject(
        input: NfcTapInput,
        reason: NfcTapReason,
        fields: LogFields,
    ): Promise<TapVerification> {
        await this.log(input, { ...fields, result: 'REJECTED', reasonCode: reason });
        return { ok: false, reason };
    }

    /**
     * One `NfcVerification` row per attempt. Stores ids, the counter and the
     * outcome — never `e`, `c`, the UID or a key. A failed write is reported
     * and swallowed: refusing a genuine tap because its log row could not be
     * written would turn a logging fault into an outage.
     */
    private async log(
        input: NfcTapInput,
        row: LogFields & { result: 'VERIFIED' | 'REJECTED'; reasonCode: string | null },
    ): Promise<void> {
        for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
            try {
                await this.deps.prisma.nfcVerification.create({
                    data: {
                        verificationCode: verificationCode(),
                        nfcTagId: row.nfcTagId ?? null,
                        skuId: row.skuId ?? null,
                        keySetId: row.keySetId ?? null,
                        nfcTagKeyId: row.nfcTagKeyId ?? null,
                        counter: row.counter ?? null,
                        result: row.result,
                        reasonCode: row.reasonCode,
                        requestId: input.requestId,
                    },
                });
                return;
            } catch (error) {
                const collision =
                    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
                if (collision && attempt < CODE_ATTEMPTS) continue;
                this.deps.logger.error(
                    { requestId: input.requestId, result: row.result, reasonCode: row.reasonCode },
                    'could not write the NfcVerification row',
                );
                return;
            }
        }
    }
}

interface LogFields {
    keySetId?: string;
    nfcTagKeyId?: string;
    nfcTagId?: string;
    skuId?: string;
    counter?: number;
}

/** "NV" + 8 digits — fits `NfcVerification.verificationCode` VarChar(10). */
function verificationCode(): string {
    let digits = '';
    for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
    return `NV${digits}`;
}

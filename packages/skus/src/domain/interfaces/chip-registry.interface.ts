import type { Prisma } from '@hitbox/database';

/**
 * Port: "make this chip verifiable and give me its NfcTag id."
 *
 * Verifying a tap needs an `NfcTag` found by UID hash and an ACTIVE
 * `NfcTagKey`, both owned by the supply module. The SKU routes used to write a
 * bare UID to `Sku.tagId` and stop, so a chip added that way could never be
 * verified. Every route that adds a chip now goes through this port, inside its
 * own transaction.
 *
 * Declared here, implemented by @hitbox/supply's `ChipRegistryService`, and
 * connected in apps/backend/src/bootstrap.ts. This module never imports supply.
 * Optional on the service only so a test harness can build it without one; a
 * request that needs it then fails with a clear 503 instead of falling back to
 * writing an unverifiable chip.
 *
 * Keys are secrets: they pass through here in memory, are wrapped by the
 * implementation, and are never logged or returned.
 */
export interface ChipToAttach {
    /** Canonical (upper-case, no separators) 7-byte UID. */
    uid: string;
    key0: string;
    key1: string;
    key2: string;
    /** The variant of the unit the chip goes on; checked against a chip already on file. */
    variantId?: string | null | undefined;
}

export interface AttachedChip {
    nfcTagId: string;
    /** A new `NfcTag` was created (false when an existing chip was linked). */
    created: boolean;
    /** ACTIVE keys were written (false when the chip already had these keys). */
    keysWritten: boolean;
}

export interface ISkuChipRegistry {
    /**
     * Creates or links the `NfcTag` for each chip (by UID hash) and ensures it
     * has ACTIVE keys. One result per chip, in order. `forSkuIds[i]` is the unit
     * the chip is about to be bound to, when it exists already.
     */
    attachWithin(
        tx: Prisma.TransactionClient,
        input: {
            chips: ChipToAttach[];
            forSkuIds?: (string | null)[] | undefined;
            createdById: string | null;
        },
    ): Promise<AttachedChip[]>;

    /**
     * Gives already linked chips their keys, in one batch. Nothing is written
     * when any chip is unknown, unusable or already has ACTIVE keys.
     */
    addKeysManyWithin(
        tx: Prisma.TransactionClient,
        input: {
            items: { nfcTagId: string; key0: string; key1: string; key2: string }[];
            createdById: string | null;
        },
    ): Promise<void>;

    /** Takes a chip out of service (its unit was re-tagged): REVOKED, keys revoked. */
    revokeWithin(
        tx: Prisma.TransactionClient,
        input: { nfcTagId: string; reason: string },
    ): Promise<void>;
}

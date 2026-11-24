import { TagLifecycleState } from '@hitbox/database';

/**
 * Whether a tap on a unit's chip can be verified, and if not, why.
 *
 * `Sku.currentNfcTagId` is the source of truth for a unit's chip. Verification
 * (nfc-verify.service.ts) finds the chip's `NfcTag`, requires it to be BOUND or
 * ACTIVE, then requires an ACTIVE `NfcTagKey`. This mirrors those rules so the
 * admin console can show the answer without anyone tapping a chip.
 *
 *   NONE            no chip at all
 *   UID_ONLY        a bare UID on `Sku.tagId` and no NfcTag: it can never verify
 *   LINKED_NO_KEYS  an NfcTag with no ACTIVE keys: every tap answers NO_KEYS
 *   INACTIVE        the chip is not BOUND / ACTIVE (LOST, REVOKED, DISPUTED, never bound)
 *   VERIFIABLE      BOUND or ACTIVE, with ACTIVE keys
 */
export type ChipState = 'NONE' | 'UID_ONLY' | 'LINKED_NO_KEYS' | 'INACTIVE' | 'VERIFIABLE';

export interface ChipFacts {
    tagId: string | null;
    currentNfcTagId?: string | null | undefined;
    currentNfcTag?:
        | { lifecycleState: TagLifecycleState; keys: readonly unknown[] }
        | null
        | undefined;
}

export interface ChipStatus {
    state: ChipState;
    verifiable: boolean;
}

export function chipStatusOf(facts: ChipFacts): ChipStatus {
    const tag = facts.currentNfcTag;
    if (tag) {
        const usable =
            tag.lifecycleState === TagLifecycleState.BOUND ||
            tag.lifecycleState === TagLifecycleState.ACTIVE;
        if (!usable) return { state: 'INACTIVE', verifiable: false };
        return tag.keys.length > 0
            ? { state: 'VERIFIABLE', verifiable: true }
            : { state: 'LINKED_NO_KEYS', verifiable: false };
    }
    // A link with no readable row (a stale cache, a test double): treat as unkeyed.
    if (facts.currentNfcTagId) return { state: 'LINKED_NO_KEYS', verifiable: false };
    return facts.tagId ? { state: 'UID_ONLY', verifiable: false } : { state: 'NONE', verifiable: false };
}

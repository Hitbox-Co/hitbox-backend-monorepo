import { ClaimedStatus, TagLifecycleState } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import { SKUS_ERROR_CODES } from '../constants/skus.constant';
import type { SkuAccess } from './sku-access';

/**
 * What an operator may change about a serialized unit, and what the unit's own
 * state still refuses.
 *
 * Pure: no Prisma, no request, no clock beyond one injected `now`. Every rule
 * below is the same rule whether it is applied to one unit through
 * `PATCH /admin/skus/:skuId` or to 800 through the batch endpoint — which is
 * the reason it lives here rather than in either controller.
 *
 * ## The shape of the rules
 *
 * Three questions, asked in this order, because each is cheaper than the next:
 *
 *   1. **May this caller write these fields at all?** Decided from grants, once
 *      per request. `tagLifecycleState` needs tag custody; `resaleBlocked`
 *      needs the unit capability. A caller who holds one and not the other gets
 *      a 403 naming exactly which fields they were refused.
 *   2. **Does the edit contradict itself?** `archived: true` with
 *      `isActive: true` is not a state; it is two instructions.
 *   3. **Does the unit's current state allow it?** Archiving a unit somebody
 *      is holding, or re-BOUNDing a tag that was REVOKED, are refused here.
 *
 * ## What is deliberately not editable
 *
 * | Column | Why not |
 * |---|---|
 * | `skuCode`, `serialNumber`, `productId` | The unit's identity. `#014 of 500` is printed on an object in someone's hands; changing it in the database does not change the object |
 * | `ownerId` | Ownership moves through the claims module, which writes the hash chain as it goes. An admin write here would move an item without provenance |
 * | `claimToken*` | Never read, never written, never returned — a live one-shot token is a claim someone else can make |
 * | `lastTapCounter` | Monotonic anti-replay counter. Its only value is that nothing can lower it |
 * | `createdAt` | — |
 *
 * `claimedStatus` is editable only through `flagged`, and only for the freeze
 * a fraud investigation needs — see `applyFlag`.
 */

/** The unit as the update path reads it. */
export interface SkuUpdateTarget {
    id: string;
    skuCode: string;
    serialNumber: number;
    productId: string;
    variantId: string | null;
    claimedStatus: ClaimedStatus;
    ownerId: string | null;
    tagId: string | null;
    tagLifecycleState: TagLifecycleState;
    vendorId: string | null;
    provisioningBatchId: string | null;
    vendorAuthenticatedAt: Date | null;
    resaleBlocked: boolean;
    resaleBlockedReason: string | null;
    tamperStatus: string | null;
    isActive: boolean;
    archivedAt: Date | null;
}

/** The editable surface, as the DTO parses it. Every key optional. */
export interface SkuUpdateChanges {
    variantId?: string | null | undefined;
    isActive?: boolean | undefined;
    archived?: boolean | undefined;
    resaleBlocked?: boolean | undefined;
    resaleBlockedReason?: string | null | undefined;
    tamperStatus?: string | null | undefined;
    flagged?: boolean | undefined;
    tagLifecycleState?: TagLifecycleState | undefined;
    vendorId?: string | null | undefined;
    provisioningBatchId?: string | null | undefined;
    vendorAuthenticated?: boolean | undefined;
    /** Free text kept in the audit trail. Not a column on `Sku`. */
    reason?: string | undefined;
}

/** Fields gated on `nfc-tag-claim:manage`; everything else on the unit itself. */
export const TAG_CUSTODY_FIELDS = [
    'tagLifecycleState',
    'vendorId',
    'provisioningBatchId',
    'vendorAuthenticated',
] as const;

/** Every editable key, tag custody included. `reason` is not one of them. */
export const EDITABLE_FIELDS = [
    'variantId',
    'isActive',
    'archived',
    'resaleBlocked',
    'resaleBlockedReason',
    'tamperStatus',
    'flagged',
    ...TAG_CUSTODY_FIELDS,
] as const;

/**
 * Edits that must carry a `reason`.
 *
 * All four freeze or retire something: the unit stops being sellable, stops
 * being listed, or its tag stops being trusted. Six months later the only
 * question anybody asks about one of these rows is *why*, and a trail that
 * cannot answer it is a log, not an audit.
 *
 * `resaleBlocked` is absent because it carries its own reason column —
 * requiring both would be the same sentence typed twice.
 */
const REASON_REQUIRED_WHEN = (changes: SkuUpdateChanges): boolean =>
    changes.flagged === true ||
    changes.archived === true ||
    changes.tagLifecycleState === TagLifecycleState.REVOKED ||
    changes.tagLifecycleState === TagLifecycleState.LOST;

/**
 * Which lifecycle states an operator may write, and from where.
 *
 * `UNPROVISIONED` and `ACTIVE` are absent as *targets* on purpose:
 * UNPROVISIONED means no tag was ever written to this unit, which is a fact
 * about the past, and ACTIVE is reached on first claim by the claims module.
 * Letting an operator declare either would make the column describe an
 * intention rather than the tag.
 *
 * `REVOKED` has no outbound edge. A revoked tag is one the platform has
 * decided not to trust — cloned, compromised, destroyed. If it could be walked
 * back, "revoked" would mean "revoked for now", and the whole point of the
 * state is that it does not.
 */
const TAG_STATE_TRANSITIONS: Record<TagLifecycleState, TagLifecycleState[]> = {
    [TagLifecycleState.UNPROVISIONED]: [],
    [TagLifecycleState.BOUND]: [
        TagLifecycleState.LOST,
        TagLifecycleState.REVOKED,
        TagLifecycleState.DISPUTED,
    ],
    [TagLifecycleState.ACTIVE]: [
        TagLifecycleState.LOST,
        TagLifecycleState.REVOKED,
        TagLifecycleState.DISPUTED,
    ],
    // The tag turned up, or the dispute was resolved in the holder's favour.
    [TagLifecycleState.LOST]: [TagLifecycleState.BOUND, TagLifecycleState.REVOKED, TagLifecycleState.DISPUTED],
    [TagLifecycleState.DISPUTED]: [TagLifecycleState.BOUND, TagLifecycleState.LOST, TagLifecycleState.REVOKED],
    [TagLifecycleState.REVOKED]: [],
};

/** A planned write, plus the two snapshots the audit trail needs. */
export interface SkuUpdatePlan {
    /** Prisma `data`. Contains only columns that actually change. */
    patch: Record<string, unknown>;
    /** Prior values of exactly those columns. */
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    /** Non-null when the service must confirm the variant belongs to the drop. */
    variantToVerify: string | null;
}

export type SkuUpdateOutcome =
    | { ok: true; plan: SkuUpdatePlan }
    | { ok: false; problem: string };

/**
 * Refuses, once per request, every field the caller's grants do not cover.
 *
 * Checked before any unit is loaded: a caller who may not write
 * `tagLifecycleState` should be told so, not told it about 800 units.
 */
export function assertFieldsWritable(changes: SkuUpdateChanges, access: SkuAccess): void {
    const refused: string[] = [];

    const touchesTagCustody = TAG_CUSTODY_FIELDS.some((field) => changes[field] !== undefined);
    if (touchesTagCustody && !access.canManageTags) {
        refused.push(...TAG_CUSTODY_FIELDS.filter((field) => changes[field] !== undefined));
    }

    const unitFields = EDITABLE_FIELDS.filter(
        (field) =>
            !(TAG_CUSTODY_FIELDS as readonly string[]).includes(field) &&
            changes[field] !== undefined,
    );
    if (unitFields.length > 0 && !access.canManageUnits) {
        refused.push(...unitFields);
    }

    if (refused.length === 0) return;
    throw AppError.forbidden(
        `You may not change ${refused.join(', ')} on a serialized unit. ` +
        'Tag custody fields require nfc-tag-claim:manage; the rest require ' +
        'collectible-instance:manage.',
        SKUS_ERROR_CODES.UPDATE_FORBIDDEN,
    );
}

/** Refuses a body that names no editable field, or omits a required reason. */
export function assertChangesUsable(changes: SkuUpdateChanges): void {
    if (!EDITABLE_FIELDS.some((field) => changes[field] !== undefined)) {
        throw AppError.badRequest(
            'Nothing to change. Send at least one of: ' + EDITABLE_FIELDS.join(', '),
            SKUS_ERROR_CODES.NO_CHANGES,
        );
    }
    if (REASON_REQUIRED_WHEN(changes) && !changes.reason?.trim()) {
        throw AppError.badRequest(
            'This change requires a `reason`: freezing a unit, archiving one, or ' +
            'marking a tag LOST or REVOKED is a decision somebody has to be able ' +
            'to account for later.',
            SKUS_ERROR_CODES.UPDATE_REFUSED,
        );
    }
}

/**
 * Turns "what was asked for" into "what will be written to this unit", or says
 * why it cannot be.
 *
 * Returns rather than throws so the batch path can collect every refusal and
 * report them together — an operator editing 400 units wants the whole list,
 * not the first row that failed.
 */
export function planSkuUpdate(
    target: SkuUpdateTarget,
    changes: SkuUpdateChanges,
    now: Date,
): SkuUpdateOutcome {
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    let variantToVerify: string | null = null;

    const set = <T>(column: string, current: T, next: T): void => {
        if (Object.is(current, next)) return;
        patch[column] = next;
        before[column] = serialise(current);
        after[column] = serialise(next);
    };

    // ── Archival ────────────────────────────────────────────────────────────
    // Ordered first because archiving also settles `isActive`, and an explicit
    // contradiction in the same body should be refused rather than resolved by
    // whichever assignment happened to run last.
    if (changes.archived !== undefined) {
        if (changes.archived) {
            if (target.claimedStatus !== ClaimedStatus.UNCLAIMED) {
                return {
                    ok: false,
                    problem:
                        `is ${target.claimedStatus} — a unit somebody is holding cannot be ` +
                        'archived. Archiving hides a real object from the platform while its ' +
                        'owner still has it in their hands.',
                };
            }
            if (changes.isActive === true) {
                return { ok: false, problem: 'cannot be archived and active at once' };
            }
            set('archivedAt', target.archivedAt, now);
            // Archived implies delisted. Left to the caller, half the archived
            // rows in the table would still be active and nobody could say
            // which state the column actually means.
            set('isActive', target.isActive, false);
        } else {
            set('archivedAt', target.archivedAt, null);
        }
    }

    if (changes.isActive !== undefined && changes.archived !== true) {
        set('isActive', target.isActive, changes.isActive);
    }

    // ── Trust flags ─────────────────────────────────────────────────────────
    if (changes.resaleBlocked !== undefined) {
        if (changes.resaleBlocked) {
            const reason = changes.resaleBlockedReason ?? target.resaleBlockedReason;
            if (!reason?.trim()) {
                return {
                    ok: false,
                    problem:
                        'blocking resale needs `resaleBlockedReason` — a unit frozen for no ' +
                        'recorded reason is one nobody can safely unfreeze',
                };
            }
            set('resaleBlocked', target.resaleBlocked, true);
            set('resaleBlockedReason', target.resaleBlockedReason, reason.trim());
        } else {
            if (changes.resaleBlockedReason) {
                return {
                    ok: false,
                    problem: 'cannot unblock resale and set a block reason in one request',
                };
            }
            set('resaleBlocked', target.resaleBlocked, false);
            // The reason described a block that no longer exists.
            set('resaleBlockedReason', target.resaleBlockedReason, null);
        }
    } else if (changes.resaleBlockedReason !== undefined) {
        const next = changes.resaleBlockedReason?.trim() || null;
        if (next !== null && !target.resaleBlocked) {
            return {
                ok: false,
                problem: 'is not resale-blocked, so there is no block for this reason to explain',
            };
        }
        set('resaleBlockedReason', target.resaleBlockedReason, next);
    }

    if (changes.tamperStatus !== undefined) {
        set('tamperStatus', target.tamperStatus, changes.tamperStatus?.trim() || null);
    }

    // ── Freeze / unfreeze ───────────────────────────────────────────────────
    if (changes.flagged !== undefined) {
        const outcome = applyFlag(target, changes.flagged);
        if (!outcome.ok) return outcome;
        set('claimedStatus', target.claimedStatus, outcome.next);
    }

    // ── Variant ─────────────────────────────────────────────────────────────
    if (changes.variantId !== undefined) {
        const next = changes.variantId ?? null;
        if (next !== null && next !== target.variantId) variantToVerify = next;
        set('variantId', target.variantId, next);
    }

    // ── Tag custody ─────────────────────────────────────────────────────────
    if (changes.tagLifecycleState !== undefined) {
        const next = changes.tagLifecycleState;
        if (next !== target.tagLifecycleState) {
            if (target.tagId === null) {
                return {
                    ok: false,
                    problem:
                        'carries no tag, so its lifecycle state describes nothing. Bind a tag ' +
                        'first through the tag endpoints.',
                };
            }
            const allowed = TAG_STATE_TRANSITIONS[target.tagLifecycleState] ?? [];
            if (!allowed.includes(next)) {
                return {
                    ok: false,
                    problem:
                        `cannot go ${target.tagLifecycleState} → ${next}` +
                        (allowed.length === 0
                            ? ` (${target.tagLifecycleState} is terminal)`
                            : ` (allowed from here: ${allowed.join(', ')})`),
                };
            }
            set('tagLifecycleState', target.tagLifecycleState, next);
        }
    }

    if (changes.vendorId !== undefined) {
        set('vendorId', target.vendorId, changes.vendorId ?? null);
    }
    if (changes.provisioningBatchId !== undefined) {
        set(
            'provisioningBatchId',
            target.provisioningBatchId,
            changes.provisioningBatchId?.trim() || null,
        );
    }
    if (changes.vendorAuthenticated !== undefined) {
        if (changes.vendorAuthenticated && target.tagId === null) {
            return {
                ok: false,
                problem: 'carries no tag for a vendor to have authenticated',
            };
        }
        set(
            'vendorAuthenticatedAt',
            target.vendorAuthenticatedAt,
            changes.vendorAuthenticated ? now : null,
        );
    }

    return { ok: true, plan: { patch, before, after, variantToVerify } };
}

/**
 * The only route by which `claimedStatus` is writable, and it is deliberately
 * narrow.
 *
 * `FLAGGED` is the investigation freeze: it stops claims and resale while
 * somebody works out whether a unit is what it says it is. Unflagging does not
 * restore "whatever it was before" — that value is not recorded anywhere, and
 * guessing it would be a fabrication. It derives the state from the one column
 * that is authoritative about it: a unit with an owner is CLAIMED, one without
 * is UNCLAIMED.
 *
 * `IN_TRANSFER` is refused in both directions. A transfer in flight is a
 * half-written ownership change owned by the claims module; freezing it from
 * the outside would strand it, and there is no state to return it to.
 */
function applyFlag(
    target: SkuUpdateTarget,
    flagged: boolean,
): { ok: true; next: ClaimedStatus } | { ok: false; problem: string } {
    if (target.claimedStatus === ClaimedStatus.IN_TRANSFER) {
        return {
            ok: false,
            problem:
                'is IN_TRANSFER — let the transfer settle or be aborted in the claims ' +
                'module before freezing it',
        };
    }
    if (flagged) return { ok: true, next: ClaimedStatus.FLAGGED };

    if (target.claimedStatus !== ClaimedStatus.FLAGGED) {
        return { ok: false, problem: `is ${target.claimedStatus}, not FLAGGED` };
    }
    return {
        ok: true,
        next: target.ownerId === null ? ClaimedStatus.UNCLAIMED : ClaimedStatus.CLAIMED,
    };
}

/** Dates into ISO strings so both snapshots are JSON by construction. */
function serialise(value: unknown): unknown {
    return value instanceof Date ? value.toISOString() : value;
}

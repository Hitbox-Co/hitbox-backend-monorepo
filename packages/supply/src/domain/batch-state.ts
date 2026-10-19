import { SupplyBatchStatus } from '@hitbox/database';

/**
 * The intake state machine.
 *
 *   UPLOADED ──▶ VALIDATED ──▶ ACCEPTED
 *      │              │
 *      └──────────────┴──────▶ REJECTED
 *
 * ACCEPTED and REJECTED are terminal. A consignment that was accepted in error
 * is not walked backwards — the stock is physically in the building by then,
 * and pretending otherwise loses the record that it ever arrived. The correction
 * is a second consignment with a negative-quantity note, which keeps both facts.
 *
 * VALIDATED may be skipped: a small consignment keyed in by hand is checked by
 * the person keying it, and forcing a no-op transition through the API buys
 * nothing.
 */
export const BATCH_TRANSITIONS: Record<SupplyBatchStatus, SupplyBatchStatus[]> = {
    [SupplyBatchStatus.UPLOADED]: [
        SupplyBatchStatus.VALIDATED,
        SupplyBatchStatus.ACCEPTED,
        SupplyBatchStatus.REJECTED,
    ],
    [SupplyBatchStatus.VALIDATED]: [
        SupplyBatchStatus.ACCEPTED,
        SupplyBatchStatus.REJECTED,
    ],
    [SupplyBatchStatus.ACCEPTED]: [],
    [SupplyBatchStatus.REJECTED]: [],
};

export function canTransition(
    from: SupplyBatchStatus,
    to: SupplyBatchStatus,
): boolean {
    return (BATCH_TRANSITIONS[from] ?? []).includes(to);
}

/** Terminal states — nothing may be registered into one. */
export function isTerminal(status: SupplyBatchStatus): boolean {
    return (BATCH_TRANSITIONS[status] ?? []).length === 0;
}

/**
 * Whether a manifest may still be registered into this consignment.
 *
 * Deliberately *not* "is it accepted": rows are registered while the
 * consignment is still under review, and the acceptance decision is taken with
 * the registered rows in front of the reviewer. Registering into an already
 * accepted consignment is what is refused — the counts on it have been signed
 * off, and appending to them silently changes a decision someone made.
 */
export function acceptsRows(status: SupplyBatchStatus): boolean {
    return (
        status === SupplyBatchStatus.UPLOADED ||
        status === SupplyBatchStatus.VALIDATED
    );
}

export { SupplyBatchStatus };

import type { NfcTagCondition, RefundStatus } from '@hitbox/database';
import { RESALE_BLOCK_DAYS } from '../constants/payments.constant';

/**
 * The refund workflow, as a state machine.
 *
 * Straight out of the design document (D4-35):
 *
 *   1. Buyer or support requests a refund
 *   2. Physical return must be confirmed received
 *   3. A HitBox admin manually triggers approval
 *   4. If claimed before return: ownership revoked, tag flagged
 *   5. Refund executed via the payment gateway
 *   6. Royalty ledger entry reversed via an adjustment entry
 *
 * Steps 1–3 are these transitions. Steps 4–6 are what `RefundService.approve`
 * and `.process` do once the state machine allows them.
 *
 * The thing worth being stubborn about: **money never moves before the item is
 * back.** A refund on a physical collectible is not a card reversal, it is an
 * exchange, and the platform has no leverage once the money is gone. So
 * AWAITING_RETURN is not a status someone can skip by pressing approve.
 */
export const REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
    REQUESTED: ['AWAITING_RETURN', 'APPROVED', 'REJECTED'],
    AWAITING_RETURN: ['APPROVED', 'REJECTED'],
    APPROVED: ['PROCESSED', 'REJECTED'],
    PROCESSED: [],
    REJECTED: [],
};

export function canTransition(from: RefundStatus, to: RefundStatus): boolean {
    return REFUND_TRANSITIONS[from].includes(to);
}

/** Terminal states: nothing further happens to the request itself. */
export function isTerminal(status: RefundStatus): boolean {
    return REFUND_TRANSITIONS[status].length === 0;
}

/**
 * Whether a returned unit may go back on sale.
 *
 * A tag that came back damaged, missing or tampered with is quarantined for 90
 * days. The reasoning is anti-counterfeiting rather than stock control: a tag
 * that "stopped responding" may equally have been cloned, and the worst
 * outcome is the original re-entering circulation beside its copy. INTACT gets
 * no block — the item is genuinely fine and holding it off sale costs the
 * platform a unit for nothing.
 */
export function resaleBlockUntil(
    condition: NfcTagCondition | null,
    now: Date,
    days = RESALE_BLOCK_DAYS,
): Date | null {
    if (condition === null || condition === 'INTACT') return null;
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** A returned tag in any state other than INTACT is a quality signal worth counting. */
export function isDefectiveReturn(condition: NfcTagCondition | null): boolean {
    return condition !== null && condition !== 'INTACT';
}

/**
 * The buttons a refund screen should offer — derived from the same conditions
 * RefundService enforces, so the UI never offers an action that would fail.
 *
 *  - CONFIRM_RETURN         the item still has to come back and hasn't
 *  - APPROVE                approvable, and nothing is outstanding
 *  - APPROVE_WITH_OVERRIDE  approvable, but the return isn't confirmed — needs
 *                           `overridePhysicalReturn: true` and a reason
 *  - REJECT                 any open refund
 *  - PROCESS                approved, ready to pay out
 *
 * Empty for a caller without `order:refund:global`: they may look, not act.
 * docs/orders/order-payments-and-refunds-api.md.
 */
export type RefundAction = 'CONFIRM_RETURN' | 'APPROVE' | 'APPROVE_WITH_OVERRIDE' | 'REJECT' | 'PROCESS';

export function refundActions(
    refund: {
        status: RefundStatus;
        physicalReturnRequired: boolean;
        physicalReturnConfirmedAt: Date | null;
    },
    canRefund: boolean,
): RefundAction[] {
    if (!canRefund) return [];
    const actions: RefundAction[] = [];
    const returnOutstanding = refund.physicalReturnRequired && refund.physicalReturnConfirmedAt === null;

    if ((refund.status === 'REQUESTED' || refund.status === 'AWAITING_RETURN') && returnOutstanding) {
        actions.push('CONFIRM_RETURN');
    }
    if (canTransition(refund.status, 'APPROVED')) {
        actions.push(returnOutstanding ? 'APPROVE_WITH_OVERRIDE' : 'APPROVE');
    }
    if (refund.status === 'APPROVED') actions.push('PROCESS');
    if (canTransition(refund.status, 'REJECTED')) actions.push('REJECT');
    return actions;
}

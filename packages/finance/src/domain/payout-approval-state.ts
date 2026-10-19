/**
 * The approval-workflow label for a payout batch.
 *
 * The built `PayoutStatus` enum has no PENDING or REJECTED value and is left
 * exactly as it is. The workflow states the admin console shows are derived:
 *
 *   SCHEDULED                       → PENDING_APPROVAL
 *   CANCELLED with a rejection trail → REJECTED
 *   anything else                   → the status itself
 *
 * A CANCELLED row without a rejection trail stays CANCELLED (cancelled by some
 * other path), so the two are never conflated.
 */
export type PayoutApprovalState =
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'REJECTED'
    | 'PAID'
    | 'FAILED'
    | 'CANCELLED';

export function approvalStateOf(row: {
    status: string;
    rejectedAt: Date | null;
}): PayoutApprovalState {
    if (row.status === 'SCHEDULED') return 'PENDING_APPROVAL';
    if (row.status === 'CANCELLED' && row.rejectedAt !== null) return 'REJECTED';
    return row.status as PayoutApprovalState;
}

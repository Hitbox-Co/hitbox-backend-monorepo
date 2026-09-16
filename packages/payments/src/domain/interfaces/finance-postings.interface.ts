/**
 * The finance side of a money movement.
 *
 * Payments decides *that* a sale settled, a refund went out or a dispute was
 * lost. Finance decides what each of those means for the books and for the
 * artist's royalties. Keeping the two apart is what stops two modules writing
 * the ledger, and it is why this is a port rather than payments holding a
 * Prisma client over `FinanceLedgerEntry`.
 *
 * Both ports are consumer-defined here and implemented by @hitbox/finance;
 * bootstrap connects them.
 */

export interface IFinancePostings {
    /** Books revenue for a settled charge. Idempotent on the transaction id. */
    postSaleRevenue(input: {
        orderId: string;
        paymentTransactionId: string;
        amount: string;
        currency: string;
        costOfGoods?: string | null;
        gatewayFee?: string | null;
        description?: string;
    }): Promise<{ posted: boolean; entryId: string | null }>;

    /** Books a refund. Idempotent on the refund request id. */
    postRefund(input: {
        orderId: string;
        refundRequestId: string;
        amount: string;
        currency: string;
        description?: string;
    }): Promise<{ posted: boolean; entryId: string | null }>;

    /** Books a lost dispute (and its fee). Idempotent on the dispute id. */
    postChargeback(input: {
        orderId: string;
        disputeCaseId: string;
        amount: string;
        feeAmount?: string | null;
        currency: string;
        description?: string;
    }): Promise<{ posted: boolean }>;

    /** Records a correction against a financial record. */
    postAdjustment(input: {
        targetType:
        | 'ROYALTY_LEDGER_ENTRY'
        | 'FINANCE_LEDGER_ENTRY'
        | 'ORDER'
        | 'PAYMENT_TRANSACTION'
        | 'ROYALTY_PAYOUT';
        targetId: string;
        orderId?: string | null;
        amountAdjustment: string;
        currency: string;
        reasonCode:
        | 'REFUND_REVERSAL'
        | 'DISPUTE_LOSS'
        | 'CHARGEBACK_FEE'
        | 'CALCULATION_ERROR'
        | 'RULE_CORRECTION'
        | 'GOODWILL'
        | 'MANUAL_CORRECTION';
        reason: string;
        actorId?: string | null;
        refundRequestId?: string | null;
        disputeCaseId?: string | null;
    }): Promise<{ adjustmentId: string }>;
}

/**
 * Reversing what an order accrued.
 *
 * Separate from the postings port because it is a different question with a
 * different answer shape: "un-earn the artist's royalty on this order" is not
 * a book entry, it is a decision about somebody else's money that finance
 * makes in two different ways depending on whether that money has already been
 * paid out. See RoyaltyAccrualService.reverseForOrder.
 */
export interface IRoyaltyReversal {
    reverseForOrder(input: {
        orderId: string;
        reason: string;
        reasonCode:
        | 'REFUND_REVERSAL'
        | 'DISPUTE_LOSS'
        | 'CALCULATION_ERROR'
        | 'RULE_CORRECTION'
        | 'MANUAL_CORRECTION';
        actorId: string | null;
        refundRequestId?: string | null;
        disputeCaseId?: string | null;
        correlationId?: string;
    }): Promise<{
        reversedEntryIds: string[];
        clawbackEntryIds: string[];
        adjustmentIds: string[];
    }>;
}

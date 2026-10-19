import { describe, expect, it } from '@jest/globals';
import {
    REFUND_TRANSITIONS,
    canTransition,
    isDefectiveReturn,
    isTerminal,
    resaleBlockUntil,
} from '../src/domain/refund-workflow';

/**
 * The refund state machine, checked against the design document's D4-35
 * sequence: request → physical return confirmed → admin approval → execution.
 */
describe('refund transitions', () => {
    it('cannot jump from REQUESTED straight to PROCESSED', () => {
        expect(canTransition('REQUESTED', 'PROCESSED')).toBe(false);
    });

    it('allows the documented path through to execution', () => {
        expect(canTransition('REQUESTED', 'AWAITING_RETURN')).toBe(true);
        expect(canTransition('AWAITING_RETURN', 'APPROVED')).toBe(true);
        expect(canTransition('APPROVED', 'PROCESSED')).toBe(true);
    });

    it('allows a rejection at every stage before execution', () => {
        expect(canTransition('REQUESTED', 'REJECTED')).toBe(true);
        expect(canTransition('AWAITING_RETURN', 'REJECTED')).toBe(true);
        expect(canTransition('APPROVED', 'REJECTED')).toBe(true);
    });

    it('treats PROCESSED and REJECTED as terminal', () => {
        expect(isTerminal('PROCESSED')).toBe(true);
        expect(isTerminal('REJECTED')).toBe(true);
        expect(REFUND_TRANSITIONS.PROCESSED).toHaveLength(0);
    });

    it('never allows a processed refund to be reopened', () => {
        for (const to of ['REQUESTED', 'AWAITING_RETURN', 'APPROVED', 'REJECTED'] as const) {
            expect(canTransition('PROCESSED', to)).toBe(false);
        }
    });
});

/**
 * The tag quarantine: *"NFC tag flagged against resale for 90 days"* on a
 * damaged return. The reasoning is anti-counterfeiting — a tag that stopped
 * responding may equally have been cloned.
 */
describe('resaleBlockUntil', () => {
    const now = new Date('2026-09-16T00:00:00Z');

    it('quarantines a damaged tag for 90 days', () => {
        const until = resaleBlockUntil('DAMAGED', now);
        expect(until?.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    });

    it('quarantines a missing or tampered tag the same way', () => {
        expect(resaleBlockUntil('MISSING', now)).not.toBeNull();
        expect(resaleBlockUntil('TAMPERED', now)).not.toBeNull();
    });

    /** An intact item is genuinely fine; holding it back costs a unit for nothing. */
    it('does not quarantine an intact tag', () => {
        expect(resaleBlockUntil('INTACT', now)).toBeNull();
    });

    it('does not quarantine when the return was never inspected', () => {
        expect(resaleBlockUntil(null, now)).toBeNull();
    });

    it('honours a custom window', () => {
        const until = resaleBlockUntil('DAMAGED', now, 30);
        expect(until?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    });
});

describe('isDefectiveReturn', () => {
    it('counts anything other than INTACT as a quality signal', () => {
        expect(isDefectiveReturn('DAMAGED')).toBe(true);
        expect(isDefectiveReturn('INTACT')).toBe(false);
        expect(isDefectiveReturn(null)).toBe(false);
    });
});

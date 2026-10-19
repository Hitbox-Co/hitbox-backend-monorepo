import { describe, expect, it } from '@jest/globals';
import {
    currentQuarterBoundary,
    nextQuarterBoundary,
    quarterEndingAt,
    quarterLabel,
} from '../src/domain/quarter';
import { approvalStateOf } from '../src/domain/payout-approval-state';

const utc = (iso: string) => new Date(iso);

describe('quarter boundaries (UTC)', () => {
    it.each([
        ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        ['2026-03-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z'],
        ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
        ['2026-09-30T23:59:59.999Z', '2026-07-01T00:00:00.000Z'],
        ['2026-10-19T12:00:00.000Z', '2026-10-01T00:00:00.000Z'],
        ['2026-12-31T23:59:59.999Z', '2026-10-01T00:00:00.000Z'],
    ])('%s falls in the quarter starting %s', (at, expected) => {
        expect(currentQuarterBoundary(utc(at)).toISOString()).toBe(expected);
    });

    it('is exactly on the boundary at 00:00 UTC, not a millisecond earlier', () => {
        expect(currentQuarterBoundary(utc('2026-10-01T00:00:00.000Z')).toISOString()).toBe(
            '2026-10-01T00:00:00.000Z',
        );
        expect(currentQuarterBoundary(utc('2026-09-30T23:59:59.999Z')).toISOString()).toBe(
            '2026-07-01T00:00:00.000Z',
        );
    });

    it('rolls the next boundary over the year end', () => {
        expect(nextQuarterBoundary(utc('2026-11-15T00:00:00.000Z')).toISOString()).toBe(
            '2027-01-01T00:00:00.000Z',
        );
        expect(nextQuarterBoundary(utc('2026-01-01T00:00:00.000Z')).toISOString()).toBe(
            '2026-04-01T00:00:00.000Z',
        );
    });

    it('settles the quarter that ENDS at the boundary', () => {
        const { start, end } = quarterEndingAt(utc('2027-01-01T00:00:00.000Z'));
        expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
        expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
        expect(quarterLabel(start)).toBe('2026-Q4');
        expect(quarterLabel(quarterEndingAt(utc('2026-04-01T00:00:00.000Z')).start)).toBe(
            '2026-Q1',
        );
    });
});

describe('approvalStateOf', () => {
    it('treats SCHEDULED as pending approval, without renaming the enum', () => {
        expect(approvalStateOf({ status: 'SCHEDULED', rejectedAt: null })).toBe('PENDING_APPROVAL');
    });

    it('labels a CANCELLED batch REJECTED only when it carries a rejection trail', () => {
        expect(approvalStateOf({ status: 'CANCELLED', rejectedAt: new Date() })).toBe('REJECTED');
        expect(approvalStateOf({ status: 'CANCELLED', rejectedAt: null })).toBe('CANCELLED');
    });

    it('passes every other status through', () => {
        for (const status of ['APPROVED', 'PAID', 'FAILED']) {
            expect(approvalStateOf({ status, rejectedAt: null })).toBe(status);
        }
    });
});

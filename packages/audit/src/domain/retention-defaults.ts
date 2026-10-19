import { AuditSeverity } from '@hitbox/database';

export interface RetentionPolicyDefinition {
    severity: AuditSeverity;
    retentionDays: number;
    notes: string;
}

/**
 * Starting values for `AuditRetentionPolicy`, seeded once.
 *
 * These are *defaults*, not the authority — which is the whole point of the
 * policy being a table. An operator edits the row and the next prune sweep
 * picks it up, with no deploy. So the seed inserts these and then leaves them
 * alone; re-running it must not quietly reset a window someone widened for a
 * legal hold.
 */
export const RETENTION_DEFAULTS: readonly RetentionPolicyDefinition[] = [
    {
        severity: AuditSeverity.CRITICAL,
        retentionDays: 2555,
        notes:
            'Seven years. Covers refunds, transactions, role and permission changes, and org ' +
            'lifecycle — the records a financial or regulatory review asks for. Raise to ' +
            'whatever local law requires; never lower without legal sign-off.',
    },
    {
        severity: AuditSeverity.WARNING,
        retentionDays: 1095,
        notes:
            'Three years. General denials and non-critical failures. Long enough that a ' +
            'slow-burn access pattern is still visible after the fact.',
    },
    {
        severity: AuditSeverity.INFO,
        retentionDays: 90,
        notes:
            'Ninety days hot, then aggregate. This is the high-volume tier; keeping it longer ' +
            'buys little and costs the most.',
    },
];

/**
 * The cutoff a pruning job compares `occurredAt` against: anything strictly
 * older than this, at that severity, is out of policy.
 *
 * Pure and exported so the scheduled job and the admin UI agree on the date
 * without either re-deriving it — an off-by-one here deletes a day of
 * evidence early.
 */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date {
    const cutoff = new Date(now.getTime());
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    return cutoff;
}

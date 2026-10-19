/**
 * Seeds the audit event catalog and the default retention policies.
 *
 * Run from the repo root:  pnpm db:seed:audit
 *
 * **This is not optional on a deploy.** `AuditEvent.eventType` is a foreign key
 * to `AuditEventType`, so an event the table does not know about cannot be
 * written at all — and `IAuditRecorder.record` fails the operation it was
 * describing rather than losing the trail. An unseeded database therefore turns
 * every audited write in the platform (a release decision, a refund, a SKU edit)
 * into a `500`.
 *
 * Idempotent, and the same shape as the access-control seed: the code catalog in
 * @hitbox/audit is the authority for event types, so re-running reconciles the
 * database back to it. Rows the catalog does not know are left alone —
 * registering an event without a migration is the reason `AuditEventType` is a
 * table rather than an enum. Retention policies are only filled in where
 * missing, because a window somebody widened for a legal hold must survive the
 * next deploy.
 */
import { seedAudit } from '@hitbox/audit';
import { prisma } from '../src/index';

async function main(): Promise<void> {
    const result = await seedAudit(prisma);

    console.log('✔ audit seed complete');
    console.log(
        `  event types:        ${result.eventTypes.created} created, ` +
        `${result.eventTypes.updated} reconciled`,
    );
    console.log(`  retention policies: ${result.retentionPolicies.created} created`);
}

main()
    .catch((error) => {
        console.error('✖ audit seed failed');
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

import type { PrismaClient } from '@hitbox/database';
import { AuditEventTypeRepository } from '../repository/audit-event-type.repository';
import { AuditRetentionPolicyRepository } from '../repository/audit-retention-policy.repository';

export interface AuditSeedResult {
    eventTypes: { created: number; updated: number };
    retentionPolicies: { created: number };
}

/**
 * Seeds the event-type catalog and the retention policies.
 *
 * Idempotent, and safe on every deploy — but note the two halves behave
 * differently on purpose:
 *
 *   Event types are reconciled to the code catalog, because the catalog is the
 *   authority on what an event means and its severity must not drift. Rows the
 *   catalog does not know about are left alone rather than retired: registering
 *   an event without a migration is the reason this is a table.
 *
 *   Retention policies are only filled in where missing. They are an
 *   operational decision, possibly a legal one, and a deploy that reset a
 *   window someone widened for a hold would destroy evidence on the next
 *   prune.
 */
export async function seedAudit(prisma: PrismaClient): Promise<AuditSeedResult> {
    const eventTypes = await new AuditEventTypeRepository(prisma).syncCatalog();
    const retentionPolicies = await new AuditRetentionPolicyRepository(prisma).seedDefaults();
    return { eventTypes, retentionPolicies };
}

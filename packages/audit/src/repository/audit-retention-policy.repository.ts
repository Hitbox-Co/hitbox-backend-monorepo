import type {
    AuditRetentionPolicy,
    AuditSeverity,
    Prisma,
    PrismaClient,
} from '@hitbox/database';
import { RETENTION_DEFAULTS } from '../domain/retention-defaults';

export class AuditRetentionPolicyRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findAll(): Promise<AuditRetentionPolicy[]> {
        return this.prisma.auditRetentionPolicy.findMany({ orderBy: { severity: 'asc' } });
    }

    findBySeverity(severity: AuditSeverity): Promise<AuditRetentionPolicy | null> {
        return this.prisma.auditRetentionPolicy.findUnique({ where: { severity } });
    }

    /** `tx` so the change and its CRITICAL audit record commit together. */
    async update(
        severity: AuditSeverity,
        patch: { retentionDays: number; notes: string },
        tx?: Prisma.TransactionClient,
    ): Promise<AuditRetentionPolicy> {
        return (tx ?? this.prisma).auditRetentionPolicy.update({
            where: { severity },
            data: patch,
        });
    }

    /**
     * Inserts the starting policies for any severity that has none.
     *
     * `createMany({ skipDuplicates })` rather than an upsert, on purpose: an
     * operator may have widened a window for a legal hold, and a deploy that
     * silently reset it back to the code default would destroy evidence on the
     * next prune. The seed fills gaps; it never overwrites a decision.
     */
    async seedDefaults(): Promise<{ created: number }> {
        const result = await this.prisma.auditRetentionPolicy.createMany({
            data: RETENTION_DEFAULTS.map((policy) => ({ ...policy })),
            skipDuplicates: true,
        });
        return { created: result.count };
    }
}

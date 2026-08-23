import type { Prisma, PrismaClient } from '@hitbox/database';
import type { AuditResult } from '../domain/enums/audit.enum';

export interface AuditRecord {
    actorUserId: string | null;
    actorType: string;
    action: string;
    resource: string;
    resourceId?: string | null;
    organizationId?: string | null;
    result: AuditResult;
    surface?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
}

export interface AuditQuery {
    organizationId?: string | null;
    actorUserId?: string;
    resource?: string;
    resourceId?: string;
    result?: AuditResult;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
}

/**
 * Append-only. There is intentionally no update or delete method — retention is
 * handled out-of-band by a scheduled purge, so application code cannot rewrite
 * history even by accident.
 */
export class AuditRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async append(record: AuditRecord): Promise<void> {
        await this.prisma.auditLog.create({
            data: {
                actorUserId: record.actorUserId,
                actorType: record.actorType,
                action: record.action,
                resource: record.resource,
                resourceId: record.resourceId ?? null,
                organizationId: record.organizationId ?? null,
                result: record.result,
                surface: record.surface ?? null,
                ipAddress: record.ipAddress ?? null,
                userAgent: record.userAgent ?? null,
                requestId: record.requestId ?? null,
                metadata: (record.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            },
        });
    }

    /** Batched writes for the non-blocking audit path. */
    async appendMany(records: readonly AuditRecord[]): Promise<void> {
        if (records.length === 0) return;
        await this.prisma.auditLog.createMany({
            data: records.map((record) => ({
                actorUserId: record.actorUserId,
                actorType: record.actorType,
                action: record.action,
                resource: record.resource,
                resourceId: record.resourceId ?? null,
                organizationId: record.organizationId ?? null,
                result: record.result,
                surface: record.surface ?? null,
                ipAddress: record.ipAddress ?? null,
                userAgent: record.userAgent ?? null,
                requestId: record.requestId ?? null,
                metadata: (record.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            })),
        });
    }

    async list(query: AuditQuery) {
        const where: Prisma.AuditLogWhereInput = {
            ...(query.organizationId !== undefined
                ? { organizationId: query.organizationId }
                : {}),
            ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
            ...(query.resource ? { resource: query.resource } : {}),
            ...(query.resourceId ? { resourceId: query.resourceId } : {}),
            ...(query.result ? { result: query.result } : {}),
            ...(query.from || query.to
                ? {
                    createdAt: {
                        ...(query.from ? { gte: query.from } : {}),
                        ...(query.to ? { lte: query.to } : {}),
                    },
                }
                : {}),
        };

        const rows = await this.prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: query.limit + 1,
            ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        });

        const hasMore = rows.length > query.limit;
        const items = hasMore ? rows.slice(0, query.limit) : rows;
        return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    }
}

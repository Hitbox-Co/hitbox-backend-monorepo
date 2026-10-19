import type { AuditEventType, PrismaClient } from '@hitbox/database';
import { AUDIT_EVENT_CATALOG } from '../domain/audit-event-catalog';

export interface EventTypeSyncResult {
    created: number;
    updated: number;
}

/** Reads and seeds the event-type catalog table. */
export class AuditEventTypeRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findAll(options: { includeInactive?: boolean } = {}): Promise<AuditEventType[]> {
        return this.prisma.auditEventType.findMany({
            where: options.includeInactive ? {} : { isActive: true },
            orderBy: [{ personaGroup: 'asc' }, { eventType: 'asc' }],
        });
    }

    findByKey(eventType: string): Promise<AuditEventType | null> {
        return this.prisma.auditEventType.findUnique({ where: { eventType } });
    }

    /**
     * Mirrors the code catalog into the table. Idempotent, so it is safe on
     * every deploy.
     *
     * Unlike the permission catalog's sync, this deliberately does NOT
     * deactivate rows it does not recognise. The whole reason this is a table
     * and not an enum is that an operator can register an event without a
     * migration; a sync that retired anything not in code would delete that
     * capability on the next deploy, and would orphan the events already
     * written against the row.
     */
    async syncCatalog(): Promise<EventTypeSyncResult> {
        const existing = await this.prisma.auditEventType.findMany({
            select: { eventType: true },
        });
        const known = new Set(existing.map((row) => row.eventType));

        let created = 0;
        let updated = 0;
        const now = new Date();

        for (const definition of AUDIT_EVENT_CATALOG) {
            const isNew = !known.has(definition.eventType);
            await this.prisma.auditEventType.upsert({
                where: { eventType: definition.eventType },
                create: {
                    eventType: definition.eventType,
                    personaGroup: definition.personaGroup,
                    description: definition.description,
                    defaultSeverity: definition.defaultSeverity,
                    sourceStories: [...definition.sourceStories],
                    isActive: true,
                    createdAt: now,
                },
                // createdAt is left alone: it records when the event was first
                // registered, and a re-sync is not a re-registration.
                update: {
                    personaGroup: definition.personaGroup,
                    description: definition.description,
                    defaultSeverity: definition.defaultSeverity,
                    sourceStories: [...definition.sourceStories],
                    isActive: true,
                },
            });
            if (isNew) created += 1;
            else updated += 1;
        }

        return { created, updated };
    }
}

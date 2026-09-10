import { AuditActorType, AuditSeverity } from '@hitbox/database';
import type { AuditEvent, AuditEventType, AuditRetentionPolicy, Prisma } from '@hitbox/database';
import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import type { AuditActor } from '../src/domain/interfaces/audit-recorder.interface';
import type {
    AuditEventCursor,
    AuditEventFilter,
    AuditEventPage,
    AuditEventRepository,
    AuditEventRow,
} from '../src/repository/audit-event.repository';
import type { AuditEventTypeRepository } from '../src/repository/audit-event-type.repository';
import type { AuditRetentionPolicyRepository } from '../src/repository/audit-retention-policy.repository';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const ADMIN = '33333333-3333-4333-8333-333333333333';
export const CORRELATION = '55555555-5555-4555-8555-555555555555';

export const FIXED_NOW = new Date('2026-09-10T14:22:03.000Z');

export const ADMIN_ACTOR: AuditActor = {
    type: AuditActorType.HITBOX_ADMIN,
    id: ADMIN,
    roleSnapshot: 'HITBOX_SYSTEM_ADMIN',
};

/** Captures what was logged, so a test can assert a drop was reported. */
export interface CapturingLogger extends Logger {
    warnings: unknown[];
    errors: unknown[];
}

export function fakeLogger(): CapturingLogger {
    const warnings: unknown[] = [];
    const errors: unknown[] = [];
    const logger = {
        warnings,
        errors,
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
        error: (...args: unknown[]) => errors.push(args),
        fatal: () => undefined,
        trace: () => undefined,
        child: () => logger,
    };
    return logger as unknown as CapturingLogger;
}

export interface FakeEventBus extends IEventBus {
    published: { event: string; payload: unknown }[];
    failOnPublish: boolean;
}

export function fakeEventBus(): FakeEventBus {
    const published: { event: string; payload: unknown }[] = [];
    const bus = {
        published,
        failOnPublish: false,
        publish: async (event: string, payload: unknown) => {
            if (bus.failOnPublish) throw new Error('bus down');
            published.push({ event, payload });
        },
        subscribe: () => ({ unsubscribe: () => undefined }),
    };
    return bus as unknown as FakeEventBus;
}

/**
 * In-memory stand-in for the event repository.
 *
 * `findPage` filters and pages over the appended rows so the query service's
 * scoping and cursor handling are exercised end to end; the keyset SQL itself
 * needs a database and is not what these tests are about.
 */
export class FakeEventRepository {
    readonly appended: AuditEventRow[] = [];
    /** Set to make the next append throw, as a database outage would. */
    failAppend = false;
    /** Rows returned by findPage / findByCorrelationId. */
    rows: AuditEvent[] = [];
    readonly transactions: (Prisma.TransactionClient | undefined)[] = [];
    readonly pageCalls: { filter: AuditEventFilter; limit: number; cursor?: AuditEventCursor }[] =
        [];

    append(row: AuditEventRow, tx?: Prisma.TransactionClient): Promise<void> {
        if (this.failAppend) return Promise.reject(new Error('audit database unavailable'));
        this.appended.push(row);
        this.transactions.push(tx);
        return Promise.resolve();
    }

    findPage(
        filter: AuditEventFilter,
        limit: number,
        cursor?: AuditEventCursor,
    ): Promise<AuditEventPage> {
        this.pageCalls.push({ filter, limit, ...(cursor ? { cursor } : {}) });

        const matching = this.rows.filter((row) =>
            Object.entries(filter).every(([key, value]) => {
                if (value === undefined) return true;
                if (key === 'from') return row.occurredAt >= (value as Date);
                if (key === 'to') return row.occurredAt < (value as Date);
                return row[key as keyof AuditEvent] === value;
            }),
        );

        const start = cursor ? matching.findIndex((row) => row.eventId === cursor.eventId) + 1 : 0;
        const slice = matching.slice(start, start + limit);
        const last = slice.at(-1);
        const hasMore = start + limit < matching.length;

        return Promise.resolve({
            events: slice,
            nextCursor:
                hasMore && last ? { occurredAt: last.occurredAt, eventId: last.eventId } : null,
        });
    }

    findByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
        return Promise.resolve(this.rows.filter((row) => row.correlationId === correlationId));
    }

    countOlderThan(severity: AuditSeverity, cutoff: Date): Promise<number> {
        return Promise.resolve(
            this.rows.filter((row) => row.severity === severity && row.occurredAt < cutoff).length,
        );
    }

    /** The concrete type the services ask for. */
    asRepository(): AuditEventRepository {
        return this as unknown as AuditEventRepository;
    }
}

/** Only `findByKey` matters — the recorder's fallback for operator-registered rows. */
export class FakeEventTypeRepository {
    lookups: string[] = [];
    rows = new Map<string, Pick<AuditEventType, 'defaultSeverity' | 'isActive'>>();

    findByKey(eventType: string): Promise<AuditEventType | null> {
        this.lookups.push(eventType);
        const row = this.rows.get(eventType);
        return Promise.resolve((row as AuditEventType | undefined) ?? null);
    }

    asRepository(): AuditEventTypeRepository {
        return this as unknown as AuditEventTypeRepository;
    }
}

export class FakePolicyRepository {
    policies = new Map<AuditSeverity, AuditRetentionPolicy>();
    readonly updates: {
        severity: AuditSeverity;
        patch: { retentionDays: number; notes: string };
        inTransaction: boolean;
    }[] = [];
    seedCalls = 0;

    constructor(seed: { severity: AuditSeverity; retentionDays: number; notes: string }[] = []) {
        for (const policy of seed) {
            this.policies.set(policy.severity, policy as AuditRetentionPolicy);
        }
    }

    findAll(): Promise<AuditRetentionPolicy[]> {
        return Promise.resolve([...this.policies.values()]);
    }

    findBySeverity(severity: AuditSeverity): Promise<AuditRetentionPolicy | null> {
        return Promise.resolve(this.policies.get(severity) ?? null);
    }

    update(
        severity: AuditSeverity,
        patch: { retentionDays: number; notes: string },
        tx?: Prisma.TransactionClient,
    ): Promise<AuditRetentionPolicy> {
        this.updates.push({ severity, patch, inTransaction: tx !== undefined });
        const updated = { severity, ...patch } as AuditRetentionPolicy;
        this.policies.set(severity, updated);
        return Promise.resolve(updated);
    }

    seedDefaults(): Promise<{ created: number }> {
        this.seedCalls += 1;
        return Promise.resolve({ created: 0 });
    }

    asRepository(): AuditRetentionPolicyRepository {
        return this as unknown as AuditRetentionPolicyRepository;
    }
}

/** A `$transaction` that hands out a marker, so a test can prove `tx` flowed through. */
export const TX_MARKER = { marker: 'tx' } as unknown as Prisma.TransactionClient;

export function fakePrisma(options: { failAfterCallback?: boolean } = {}) {
    return {
        $transaction: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
            const result = await fn(TX_MARKER);
            if (options.failAfterCallback) throw new Error('commit failed');
            return result;
        },
    };
}

/**
 * Builds a persisted-looking AuditEvent for the read-side tests.
 *
 * Spread rather than field-by-field `??`, so an explicit `null` override
 * survives — `organizationId: null` is a real and meaningful value here (a
 * platform-level event), and coalescing it back to a default would make the
 * tenant-scoping tests pass for the wrong reason.
 */
export function auditEventRow(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return {
        eventId: '66666666-6666-4666-8666-666666666666',
        occurredAt: FIXED_NOW,
        eventType: 'role.assign',
        actorType: AuditActorType.HITBOX_ADMIN,
        actorId: ADMIN,
        actorRoleSnapshot: 'HITBOX_SYSTEM_ADMIN',
        organizationId: ORG_A,
        resourceType: 'role',
        resourceId: null,
        actionResult: 'SUCCESS',
        severity: AuditSeverity.CRITICAL,
        beforeState: null,
        afterState: null,
        ipAddress: null,
        userAgent: null,
        deviceId: null,
        correlationId: CORRELATION,
        ledgerReferenceId: null,
        metadata: {},
        insertedAt: FIXED_NOW,
        ...overrides,
    } as AuditEvent;
}

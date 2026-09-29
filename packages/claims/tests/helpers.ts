import type { IEventBus } from '@hitbox/shared';
import type { Logger } from 'pino';
import { ClaimsRepository } from '../src/repository/claims.repository';
import { ClaimsService } from '../src/service/claims.service';
import { FakePrisma } from './fake-prisma';
import type { FakePrismaOptions } from './fake-prisma';

export const SKU_A = '11111111-1111-4111-8111-111111111111';
export const SKU_B = '22222222-2222-4222-8222-222222222222';
export const TAG_A = '04A39B2C5D6E80';
export const TAG_B = '04A39B2C5D6E81';
export const DROP_ID = '33333333-3333-4333-8333-333333333333';
export const ALICE = '44444444-4444-4444-8444-444444444444';
export const BOB = '55555555-5555-4555-8555-555555555555';

export interface CapturingLogger extends Logger {
    entries: { level: string; context: Record<string, unknown>; message: string }[];
}

export function fakeLogger(): CapturingLogger {
    const entries: { level: string; context: Record<string, unknown>; message: string }[] = [];
    const record = (level: string) => (context: unknown, message?: unknown) => {
        entries.push({
            level,
            context: (typeof context === 'object' && context !== null
                ? context
                : {}) as Record<string, unknown>,
            message: typeof context === 'string' ? context : String(message ?? ''),
        });
    };
    const logger = {
        entries,
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        fatal: record('fatal'),
        trace: record('trace'),
        child: () => logger,
    };
    return logger as unknown as CapturingLogger;
}

export interface FakeEventBus extends IEventBus {
    published: { event: string; payload: unknown }[];
}

export function fakeEventBus(): FakeEventBus {
    const published: { event: string; payload: unknown }[] = [];
    return {
        published,
        publish: async (event: string, payload: unknown) => {
            published.push({ event, payload });
        },
        subscribe: () => ({ unsubscribe: () => undefined }),
    } as unknown as FakeEventBus;
}

export interface Harness {
    prisma: FakePrisma;
    service: ClaimsService;
    logger: CapturingLogger;
    eventBus: FakeEventBus;
    /** Rows currently in the fake store, for direct assertions. */
    tokens(): Record<string, any>[];
    claims(): Record<string, any>[];
    skuStatus(skuId: string): string;
}

/**
 * A claims service over the in-memory store, seeded with one unclaimed SKU
 * (`SKU_A` / `TAG_A`), a second SKU (`SKU_B` / `TAG_B`) for the wrong-item
 * test, and two users.
 */
export function harness(
    options: { claimTokenRequired?: boolean } & FakePrismaOptions = {},
): Harness {
    const { claimTokenRequired = false, ...prismaOptions } = options;
    const prisma = new FakePrisma(prismaOptions);
    const logger = fakeLogger();
    const eventBus = fakeEventBus();

    prisma.store.drop.push({
        id: DROP_ID,
        groupCode: 'HB-DEMO-001',
        name: 'Demo Collectible',
        status: 'PUBLISHED',
        collectionId: null,
        collection: null,
        dropPrices: [],
    });
    prisma.store.user.push(
        { id: ALICE, handle: 'alice', fullName: 'Alice A' },
        { id: BOB, handle: 'bob', fullName: 'Bob B' },
    );
    for (const [id, tagId, serial] of [
        [SKU_A, TAG_A, 7],
        [SKU_B, TAG_B, 8],
    ] as const) {
        prisma.store.sku.push({
            id,
            tagId,
            skuCode: `HB-DEMO-001-${String(serial).padStart(6, '0')}`,
            serialNumber: serial,
            productId: DROP_ID,
            claimedStatus: 'UNCLAIMED',
            ownerId: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        });
    }

    const service = new ClaimsService({
        claims: new ClaimsRepository(prisma.asPrisma()),
        eventBus,
        logger,
        claimTokenRequired,
    });

    return {
        prisma,
        service,
        logger,
        eventBus,
        tokens: () => prisma.store.claimToken,
        claims: () => prisma.store.skuClaim,
        skuStatus: (skuId: string) =>
            prisma.store.sku.find((s) => s.id === skuId)?.claimedStatus as string,
    };
}

/** Validates as `userId` and returns the raw token it was issued. */
export async function validatedToken(
    h: Harness,
    userId: string,
    tagId: string = TAG_A,
): Promise<string> {
    const result = await h.service.validate(tagId, userId);
    if (!result.claimToken) throw new Error('validate issued no token');
    return result.claimToken;
}

import { jest } from '@jest/globals';
import type { FinanceAccess } from '../src/domain/finance-access';
import { buildFinanceAccess } from '../src/domain/finance-access';

export const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as never;

export const principal = (permissions: string[]) => ({
    userId: 'user-1',
    permissions,
    roles: [],
});

/** Everything the System Admin role holds for these features. */
export const ADMIN_PERMISSIONS = [
    'payment-royalty:read:global',
    'payment-royalty:manage:global',
    'payment-royalty:update:global',
    'payment-royalty:approve:global',
    'payment-royalty:transfer:global',
    'drop:configure:global',
];

export const accessFor = (permissions: string[]): FinanceAccess =>
    buildFinanceAccess(principal(permissions));

/** A prisma stand-in whose transaction just hands the same fake to the callback. */
export function makePrisma(extra: Record<string, unknown> = {}) {
    const tx = { __tx: true, ...extra };
    return {
        tx,
        client: {
            ...extra,
            $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
        } as never,
    };
}

export function makeAudit() {
    return {
        record: jest.fn(async () => undefined),
        emit: jest.fn(),
    };
}

export function makeBus() {
    return { publish: jest.fn(async () => undefined), subscribe: jest.fn() } as never;
}

/** A public-code resolver stub: `codes` maps `model:id` to a code. */
export function makeCodes(codes: Record<string, string> = {}) {
    return {
        resolve: jest.fn(async (lookup: Record<string, (string | null | undefined)[]>) => ({
            get: (model: string, id: string | null | undefined) =>
                id ? (codes[`${model}:${id}`] ?? null) : null,
            lookup,
        })),
    } as never;
}

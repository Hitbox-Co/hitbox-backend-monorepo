import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOrdersModule } from '../src/module';

/**
 * Regression: an own-scoped grant (`order:read:own`, which every buyer holds)
 * only matches when the guard is told whose record the route touches. The buyer
 * routes were mounted without that, so every buyer got a 403 AUTHZ_FORBIDDEN.
 *
 * The guard here behaves like the real engine for own-scoped grants: it lets a
 * request through only when the route's `context` names an owner, and that owner
 * is the caller. The handlers behind it never run.
 */

const CALLER = 'user-123';

const strictOwnGuard = {
    requirePermission(_capability: string, options?: { context?: (req: express.Request) => unknown }): RequestHandler {
        return (req, res) => {
            const ctx = options?.context?.(req) as { ownerId?: string } | undefined;
            if (!ctx?.ownerId || ctx.ownerId !== CALLER) {
                res.status(403).json({ error: { code: 'AUTHZ_FORBIDDEN' } });
                return;
            }
            res.status(200).json({ passed: true });
        };
    },
};

let server: Server;
let base: string;

beforeAll(async () => {
    const orders = createOrdersModule({
        prisma: {} as never,
        eventBus: { subscribe: jest.fn(), publish: jest.fn() } as never,
        guard: strictOwnGuard,
        resolveCaller: (async () => ({ userId: CALLER })) as never,
        audit: {} as never,
        resolveBuyer: () => CALLER,
    });
    const app = express();
    app.use('/orders', orders.createBuyerRouter((_req, _res, next) => next()));
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orders`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('buyer order routes name the caller as the record owner', () => {
    it.each([
        ['GET', ''],
        ['GET', '/recent-purchases'],
        ['GET', '/8c1e2f6a-0000-4000-8000-000000000000'],
        ['GET', '/8c1e2f6a-0000-4000-8000-000000000000/tracking'],
        ['POST', '/8c1e2f6a-0000-4000-8000-000000000000/cancel'],
    ])('%s /orders%s passes for an own-scoped buyer', async (method, path) => {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(200);
    });
});

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMarketsModule } from '../src/module';

/**
 * GET /markets: public, active markets only, `{ id, currency, countryCodes }`.
 * Prisma is faked; the router, controller and service are real.
 */

const findMany = jest.fn(async () => [
    { id: 'm-us', currency: 'USD', marketCountrys: [{ countryCode: 'CA' }, { countryCode: 'US' }] },
    { id: 'm-in', currency: 'INR', marketCountrys: [{ countryCode: 'IN' }] },
    { id: 'm-empty', currency: 'GBP', marketCountrys: [] },
]);

let server: Server;
let url: string;

beforeAll(async () => {
    const markets = createMarketsModule({
        prisma: { market: { findMany } } as never,
        // The public router must never touch the permission guard.
        guard: { requirePermission: () => { throw new Error('guard must not be used'); } } as never,
    });
    const app = express();
    app.use('/api/v1/markets', markets.createPublicRouter());
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/markets`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('GET /markets', () => {
    it('needs no token and returns { data: [{ id, currency, countryCodes }] } only', async () => {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            data: [
                { id: 'm-us', currency: 'USD', countryCodes: ['CA', 'US'] },
                { id: 'm-in', currency: 'INR', countryCodes: ['IN'] },
                { id: 'm-empty', currency: 'GBP', countryCodes: [] },
            ],
        });
    });

    it('asks only for active, non-archived markets, default first', async () => {
        await fetch(url);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { isActive: true, archivedAt: null },
            orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        }));
    });

    it('is cacheable for a few minutes and rate limited per IP', async () => {
        const res = await fetch(url);
        expect(res.headers.get('cache-control')).toBe('public, max-age=300');
        expect(res.headers.get('ratelimit-limit')).toBe('60');
    });
});

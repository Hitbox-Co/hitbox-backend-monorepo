import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '@hitbox/shared';
import { createUsersModule } from '../src/module';

/**
 * The address book over real HTTP: the real router, controller, service and
 * repository, with only Prisma replaced by an in-memory store. This pins what
 * a client sees: status codes, the `{ data }` envelope, ownership scoping, the
 * single default and the cap. (The partial unique index and the row lock that
 * back them are database-side.)
 */

type Row = Record<string, unknown> & { id: string; userId: string };

function fakePrisma() {
    const rows: Row[] = [];
    const matches = (row: Row, where: Record<string, unknown> = {}) =>
        Object.entries(where).every(([key, value]) => row[key] === value);
    const address = {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
            rows
                .filter((row) => matches(row, where))
                .map((row) => ({ ...row }))
                .sort(
                    (a, b) =>
                        Number(b.isDefault) - Number(a.isDefault) ||
                        (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
                ),
        findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
            // Copies, like Prisma: a row read earlier must not change under the caller.
            const found = rows.filter((row) => matches(row, where)).map((row) => ({ ...row }));
            if (orderBy) found.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
            return found[0] ?? null;
        },
        count: async ({ where }: { where: Record<string, unknown> }) =>
            rows.filter((row) => matches(row, where)).length,
        create: async ({ data }: { data: Row }) => {
            rows.push({ ...data });
            return { ...data };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.find((candidate) => candidate.id === where.id) as Row;
            Object.assign(row, data);
            return { ...row };
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const hit = rows.filter((row) => matches(row, where));
            hit.forEach((row) => Object.assign(row, data));
            return { count: hit.length };
        },
    };
    const client: Record<string, unknown> = {
        address,
        $queryRaw: async () => [],
        $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
    };
    return { client, rows };
}

let server: Server;
let base: string;
let store: ReturnType<typeof fakePrisma>;

beforeAll(async () => {
    store = fakePrisma();
    const users = createUsersModule({
        prisma: store.client as never,
        eventBus: { publish: async () => undefined, subscribe: () => ({ unsubscribe: () => undefined }) } as never,
    });
    // Stands in for Clerk auth: the caller is whoever the header says.
    const requireAuth: RequestHandler = (req, res, next) => {
        const id = req.header('x-user');
        if (!id) {
            res.status(401).json({ error: { code: 'AUTH_UNAUTHENTICATED', message: 'no' } });
            return;
        }
        (req as unknown as { auth: unknown }).auth = { accountId: id };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/users', users.createRouter(requireAuth));
    app.use(errorHandler as never);
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/users/me/addresses`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

async function call(user: string | null, method: string, path = '', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(user ? { 'x-user': user } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const home = {
    label: 'Home', recipientName: 'Arjun Singh', line1: '12 MG Road', city: 'Bengaluru',
    state: 'KA', postalCode: '560001', countryCode: 'IN',
};
const work = { ...home, label: 'Work', line1: '1 Residency Road', phone: '+919800000000' };

describe('address book over HTTP', () => {
    it('needs a signed-in caller', async () => {
        expect((await call(null, 'GET')).status).toBe(401);
    });

    it('create: 201 { data }, first address is the default, usage defaults to BOTH', async () => {
        const res = await call(U1, 'POST', '', home);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            label: 'Home', recipientName: 'Arjun Singh', line1: '12 MG Road', line2: null, city: 'Bengaluru',
            state: 'KA', postalCode: '560001', countryCode: 'IN', phone: null, isDefault: true, usage: 'BOTH',
        });
        expect(typeof res.body.data.id).toBe('string');
        expect(typeof res.body.data.createdAt).toBe('string');
        expect(res.body.data).not.toHaveProperty('userId');
    });

    it('the second address is not the default; the list puts the default first, then newest', async () => {
        const second = await call(U1, 'POST', '', work);
        expect(second.body.data.isDefault).toBe(false);
        await call(U1, 'POST', '', { ...home, label: 'Other', line1: '3 Brigade Road' });

        const list = await call(U1, 'GET');
        expect(list.status).toBe(200);
        expect(list.body.data.map((a: { label: string }) => a.label)).toEqual(['Home', 'Other', 'Work']);
        expect(list.body.data.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
    });

    it("another user cannot see, change, delete or default someone else's address: 404 USERS_ADDRESS_NOT_FOUND", async () => {
        const [first] = (await call(U1, 'GET')).body.data;
        for (const [method, path, body] of [
            ['GET', `/${first.id}`],
            ['PATCH', `/${first.id}`, { city: 'Pune' }],
            ['DELETE', `/${first.id}`],
            ['POST', `/${first.id}/default`],
        ] as const) {
            const res = await call(U2, method, path, body);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('USERS_ADDRESS_NOT_FOUND');
        }
        expect((await call(U2, 'GET')).body.data).toEqual([]);
        // and a malformed id is a 404 too
        expect((await call(U1, 'GET', '/not-a-uuid')).status).toBe(404);
    });

    it('default: switching moves the single default', async () => {
        const list = (await call(U1, 'GET')).body.data as { id: string; label: string }[];
        const target = list.find((a) => a.label === 'Work') as { id: string };
        const res = await call(U1, 'POST', `/${target.id}/default`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ id: target.id, isDefault: true });

        const after = (await call(U1, 'GET')).body.data as { label: string; isDefault: boolean }[];
        expect(after.filter((a) => a.isDefault).map((a) => a.label)).toEqual(['Work']);
        expect(after[0]?.label).toBe('Work');
    });

    it('patch: partial update, clearing with null, and whole-address re-validation', async () => {
        const [first] = (await call(U1, 'GET')).body.data;
        const ok = await call(U1, 'PATCH', `/${first.id}`, { line2: 'Flat 4B', phone: '+919811111111' });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ line2: 'Flat 4B', phone: '+919811111111' });

        const cleared = await call(U1, 'PATCH', `/${first.id}`, { line2: null });
        expect(cleared.body.data.line2).toBeNull();

        const bad = await call(U1, 'PATCH', `/${first.id}`, { countryCode: 'US' });
        expect(bad.status).toBe(422);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');

        expect((await call(U1, 'PATCH', `/${first.id}`, {})).status).toBe(422);
        expect((await call(U1, 'PATCH', `/${first.id}`, { isDefault: true })).status).toBe(422);
    });

    it('validation: 422 VALIDATION_ERROR with the field named', async () => {
        const res = await call(U1, 'POST', '', { ...home, postalCode: '12345', state: 'Karnataka' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(JSON.stringify(res.body.error.details)).toMatch(/postalCode/);
        expect(JSON.stringify(res.body.error.details)).toMatch(/state/);
    });

    it('delete archives (204), hides it, hands the default to the newest remaining, keeps the row', async () => {
        const before = (await call(U1, 'GET')).body.data as { id: string; label: string; isDefault: boolean }[];
        const def = before.find((a) => a.isDefault) as { id: string };

        const res = await call(U1, 'DELETE', `/${def.id}`);
        expect(res.status).toBe(204);

        const after = (await call(U1, 'GET')).body.data as { id: string; isDefault: boolean }[];
        expect(after.some((a) => a.id === def.id)).toBe(false);
        expect(after.filter((a) => a.isDefault)).toHaveLength(1);
        expect((await call(U1, 'GET', `/${def.id}`)).status).toBe(404);
        expect((await call(U1, 'DELETE', `/${def.id}`)).status).toBe(404);
        // soft delete: the row is still there for old orders to point at
        const archived = store.rows.find((row) => row.id === def.id);
        expect(archived).toMatchObject({ isActive: false, isDefault: false });
        expect(archived?.archivedAt).toBeInstanceOf(Date);
    });

    it('limit: the 11th active address is 409 USERS_ADDRESS_LIMIT_REACHED; archived ones do not count', async () => {
        const count = (await call(U2, 'GET')).body.data.length as number;
        for (let i = count; i < 10; i += 1) {
            expect((await call(U2, 'POST', '', { ...home, line1: `${i} Main Road` })).status).toBe(201);
        }
        const over = await call(U2, 'POST', '', home);
        expect(over.status).toBe(409);
        expect(over.body.error).toMatchObject({ code: 'USERS_ADDRESS_LIMIT_REACHED', details: { limit: 10 } });

        const [one] = (await call(U2, 'GET')).body.data;
        await call(U2, 'DELETE', `/${one.id}`);
        expect((await call(U2, 'POST', '', home)).status).toBe(201);
    });
});

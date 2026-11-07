import { DropContentService } from '../src/service/drop-content.service';
import { DropContentRepository } from '../src/repository/drop-content.repository';
import type { LockedUnit } from '../src/repository/drop-content.repository';

/**
 * The artist panel obeys the same rule as the HitBox admin: a serial list may
 * not add or remove a unit that is already claimed or owned. Serials with no
 * minted unit yet stay free.
 */

/** A `Prisma.join(...)` fragment, recognised by shape. */
function isSql(v: unknown): v is { values: unknown[] } {
    return typeof v === 'object' && v !== null && Array.isArray((v as { values?: unknown }).values);
}

const DROP = 'drop-1';
const TIER = 'tier-x';

function locked(serialNumber: number, over: Partial<LockedUnit> = {}): LockedUnit {
    return { id: `sku-${serialNumber}`, productId: DROP, serialNumber, claimedStatus: 'UNCLAIMED', owned: false, ...over };
}

function row(serials: number[]) {
    return {
        id: TIER, publicCode: null, name: 'Signed video', description: null, productId: DROP,
        accessType: 'SKU_EXCLUSIVE', isActive: true, archivedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
        moderationLockedAt: null, moderationReason: null, moderatedById: null,
        contentBundleItems: [], eligibleSerials: serials.map((serialNumber) => ({ serialNumber })),
    };
}

/**
 * A real DropContentRepository over a fake Prisma client, so the
 * repository's own diff ("which serials changed") and lock query run.
 */
function build(options: { current: number[]; units: LockedUnit[] }) {
    let serials = [...options.current];
    const lockedQueries: number[][] = [];
    const tx = {
        contentBundleSerial: {
            findMany: async () => serials.map((serialNumber) => ({ serialNumber })),
            deleteMany: async ({ where }: any) => { serials = serials.filter((n) => where.serialNumber.notIn.includes(n)); },
            createMany: async ({ data }: any) => {
                for (const d of data) if (!serials.includes(d.serialNumber)) serials.push(d.serialNumber);
            },
        },
        contentBundle: {
            update: async () => ({}),
            create: async () => ({}),
            findUniqueOrThrow: async () => row([...serials].sort((a, b) => a - b)),
        },
        // The lock query: return the units whose serial is in the IN (...) list.
        // Called as a tagged template: (strings, dropId, Prisma.join(serials)).
        $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const asked = values
                .flatMap((v) => (isSql(v) ? v.values : [v]))
                .filter((v): v is number => typeof v === 'number');
            lockedQueries.push(asked);
            return options.units.filter((u) => asked.includes(u.serialNumber));
        },
    };
    const prisma = {
        $transaction: async (work: (t: typeof tx) => unknown) => work(tx),
        drop: {
            findUnique: async () => ({ id: DROP, publicCode: null, name: 'Tee', totalSupply: 100, status: 'LIVE', archivedAt: null }),
        },
        contentBundle: {
            findFirst: async () => row([...serials]),
            count: async () => 0,
            findMany: async () => [],
        },
    };
    const drops = new DropContentRepository(prisma as never);
    drops.holderCounts = async () => new Map() as never;
    drops.openedCounts = async () => new Map() as never;
    drops.listForDrop = async () => [];
    const service = new DropContentService({ content: {} as never, drops });
    return { service, lockedQueries, serials: () => serials };
}

describe('artist panel: claimed units are locked out of serial-list changes', () => {
    it('refuses to add a claimed unit, naming it by serial, and writes nothing', async () => {
        const env = build({ current: [1], units: [locked(7, { claimedStatus: 'CLAIMED', owned: true })] });
        await expect(
            env.service.update({ dropId: DROP, bundleId: TIER, serialNumbers: [1, 7] }),
        ).rejects.toMatchObject({
            statusCode: 409,
            code: 'DROP_CONTENT_UNIT_CLAIMED',
            message: expect.stringContaining('#7'),
        });
        expect(env.serials()).toEqual([1]);
    });

    it('refuses to remove a unit that is already owned', async () => {
        const env = build({ current: [1, 5], units: [locked(5, { owned: true })] });
        await expect(
            env.service.update({ dropId: DROP, bundleId: TIER, serialNumbers: [1] }),
        ).rejects.toMatchObject({ code: 'DROP_CONTENT_UNIT_CLAIMED' });
        expect(env.serials()).toEqual([1, 5]);
    });

    it('checks only the serials that change — a claimed unit staying listed is fine', async () => {
        const env = build({
            current: [1, 7],
            units: [locked(7, { claimedStatus: 'CLAIMED', owned: true }), locked(9)],
        });
        await expect(
            env.service.update({ dropId: DROP, bundleId: TIER, serialNumbers: [1, 7, 9] }),
        ).resolves.toBeDefined();
        expect(env.lockedQueries).toEqual([[9]]);
        expect(env.serials().sort((a, b) => a - b)).toEqual([1, 7, 9]);
    });

    it('lets serials with no minted unit yet change freely', async () => {
        const env = build({ current: [1], units: [] });
        await expect(
            env.service.update({ dropId: DROP, bundleId: TIER, serialNumbers: [1, 50, 99] }),
        ).resolves.toBeDefined();
    });

    it('does not lock anything for an edit that leaves the serial list alone', async () => {
        const env = build({ current: [1], units: [] });
        await env.service.update({ dropId: DROP, bundleId: TIER, name: 'Renamed' });
        expect(env.lockedQueries).toEqual([]);
    });

    it('refuses to create an exclusive tier listing a claimed unit', async () => {
        const env = build({ current: [], units: [locked(3, { claimedStatus: 'CLAIMED', owned: true })] });
        await expect(
            env.service.create({ dropId: DROP, tier: 'EXCLUSIVE', name: 'Gold', serialNumbers: [2, 3] }),
        ).rejects.toMatchObject({ code: 'DROP_CONTENT_UNIT_CLAIMED' });
    });
});

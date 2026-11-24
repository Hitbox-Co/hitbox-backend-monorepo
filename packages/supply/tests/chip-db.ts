import { randomUUID } from 'node:crypto';

/**
 * A tiny in-memory stand-in for the tables the chip paths touch (NfcTag,
 * NfcTagKey, Sku). Just enough of the Prisma surface for the code under test,
 * with the same semantics: unique UID hash, `currentFor` derived from
 * `Sku.currentNfcTagId`, keys filtered by status.
 */

type Row = Record<string, any>;

const idsOf = (where: any): string[] | null => {
    if (where?.id === undefined) return null;
    return typeof where.id === 'string' ? [where.id] : (where.id.in as string[]);
};

export function createChipDb() {
    const tags: Row[] = [];
    const keys: Row[] = [];
    const skus: Row[] = [];

    const currentFor = (tagId: string) => {
        const sku = skus.find((row) => row.currentNfcTagId === tagId);
        return sku ? { id: sku.id } : null;
    };
    const activeKeys = (tagId: string) => keys.filter((key) => key.nfcTagId === tagId && key.status === 'ACTIVE');
    const withRelations = (tag: Row) => ({
        ...tag,
        currentFor: currentFor(tag.id),
        keys: activeKeys(tag.id).slice(0, 1),
    });

    const tx: any = {
        nfcTag: {
            findMany: async ({ where }: any) => {
                const byHash: string[] | undefined = where?.tagUidHash?.in;
                const byId = idsOf(where);
                return tags
                    .filter((tag) => (byHash ? byHash.includes(tag.tagUidHash) : byId ? byId.includes(tag.id) : true))
                    .map(withRelations);
            },
            findFirst: async () => {
                const sorted = [...tags].sort((a, b) => (a.nfcTagCode < b.nfcTagCode ? 1 : -1));
                return sorted[0] ? { nfcTagCode: sorted[0].nfcTagCode } : null;
            },
            findUnique: async ({ where }: any) => {
                const tag = where.id
                    ? tags.find((row) => row.id === where.id)
                    : tags.find((row) => row.tagUidHash === where.tagUidHash);
                return tag ? withRelations(tag) : null;
            },
            createMany: async ({ data }: { data: Row[] }) => {
                for (const row of data) {
                    if (tags.some((tag) => tag.tagUidHash === row.tagUidHash || tag.nfcTagCode === row.nfcTagCode)) {
                        throw Object.assign(new Error('unique'), { code: 'P2002' });
                    }
                    tags.push({
                        qcStatus: 'PENDING', lifecycleState: 'UNPROVISIONED', lastTapCounter: -1,
                        supplyBatchId: null, variantId: null, skuId: null, boundAt: null, retiredAt: null, ...row,
                    });
                }
                return { count: data.length };
            },
            updateMany: async ({ where, data }: any) => {
                const ids = idsOf(where);
                let count = 0;
                for (const tag of tags) {
                    if (ids && !ids.includes(tag.id)) continue;
                    if (where.lifecycleState && tag.lifecycleState !== where.lifecycleState) continue;
                    Object.assign(tag, data);
                    count += 1;
                }
                return { count };
            },
            update: async ({ where, data }: any) => {
                const tag = tags.find((row) => row.id === where.id)!;
                Object.assign(tag, data);
                return tag;
            },
        },
        nfcTagKey: {
            createMany: async ({ data }: { data: Row[] }) => {
                for (const row of data) {
                    keys.push({ id: randomUUID(), status: 'ACTIVE', lastTapCounter: -1, revokedAt: null, ...row });
                }
                return { count: data.length };
            },
            create: async ({ data }: { data: Row }) => {
                keys.push({ id: randomUUID(), status: 'ACTIVE', lastTapCounter: -1, revokedAt: null, ...data });
                return data;
            },
            updateMany: async ({ where, data }: any) => {
                let count = 0;
                for (const key of keys) {
                    if (key.nfcTagId !== where.nfcTagId || (where.status && key.status !== where.status)) continue;
                    Object.assign(key, data);
                    count += 1;
                }
                return { count };
            },
        },
        sku: {
            findFirst: async ({ where }: any) => {
                const own = skus.filter((sku) => sku.productId === where.productId);
                const top = [...own].sort((a, b) => b.serialNumber - a.serialNumber)[0];
                return top ? { serialNumber: top.serialNumber } : null;
            },
            count: async ({ where }: any) => skus.filter((sku) => sku.productId === where.productId).length,
            createMany: async ({ data }: { data: Row[] }) => {
                for (const row of data) skus.push({ ...row });
                return { count: data.length };
            },
            update: async ({ where, data }: any) => {
                const sku = skus.find((row) => row.id === where.id)!;
                Object.assign(sku, data);
                return sku;
            },
        },
    };

    return { tags, keys, skus, tx, activeKeys, currentFor };
}

export type ChipDb = ReturnType<typeof createChipDb>;

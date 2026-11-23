import { randomUUID } from 'node:crypto';
import type { Address, Prisma, PrismaClient } from '@hitbox/database';
import type { AddressFields } from '../dto/address.dto';
import { toAddressColumns } from '../dto/address.dto';

/** An address that is neither archived nor switched off. */
const ACTIVE = { isActive: true, archivedAt: null } as const;

export type CreateAddressResult =
    | { kind: 'OK'; address: Address }
    | { kind: 'LIMIT_REACHED'; limit: number };

/**
 * The address book's only Prisma access.
 *
 * Every write that can change *which* address is the default, or *how many*
 * there are, runs in a transaction that first locks the user's row. Two
 * requests from the same user (a double tap, two devices) therefore queue
 * instead of both reading "no default yet" and both becoming it, or both
 * seeing nine addresses and both adding a tenth. The partial unique index
 * `Address_one_default_per_user` is the backstop behind that lock.
 */
export class AddressRepository {
    constructor(private readonly prisma: PrismaClient) { }

    /** Default first, then newest. */
    listActive(userId: string): Promise<Address[]> {
        return this.prisma.address.findMany({
            where: { userId, ...ACTIVE },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        });
    }

    /** One of the user's own live addresses; null for someone else's or an archived one. */
    findActive(userId: string, id: string): Promise<Address | null> {
        return this.prisma.address.findFirst({ where: { id, userId, ...ACTIVE } });
    }

    /** One of the user's own addresses, archived or not; null for someone else's. */
    findOwned(userId: string, id: string): Promise<Address | null> {
        return this.prisma.address.findFirst({ where: { id, userId } });
    }

    async create(userId: string, fields: AddressFields, limit: number): Promise<CreateAddressResult> {
        return this.prisma.$transaction(async (tx) => {
            await lockUser(tx, userId);
            const active = await tx.address.count({ where: { userId, ...ACTIVE } });
            if (active >= limit) return { kind: 'LIMIT_REACHED', limit } as const;

            const now = new Date();
            const address = await tx.address.create({
                data: {
                    id: randomUUID(),
                    userId,
                    ...toAddressColumns(fields),
                    // The first address a user saves is their default.
                    isDefault: active === 0,
                    isActive: true,
                    archivedAt: null,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            return { kind: 'OK', address } as const;
        });
    }

    /** Applies already-validated fields; null when the address is not the user's live one. */
    update(userId: string, id: string, fields: AddressFields): Promise<Address | null> {
        return this.prisma.$transaction(async (tx) => {
            await lockUser(tx, userId);
            const current = await tx.address.findFirst({ where: { id, userId, ...ACTIVE } });
            if (!current) return null;
            return tx.address.update({
                where: { id },
                data: { ...toAddressColumns(fields), updatedAt: new Date() },
            });
        });
    }

    /**
     * Soft delete. The row stays because `OrderAddress.sourceAddressId` may
     * point at it and old orders must keep showing where they were sent.
     * Archiving the default hands the flag to the newest remaining address, so
     * a user with addresses always has exactly one default.
     */
    archive(userId: string, id: string): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            await lockUser(tx, userId);
            const current = await tx.address.findFirst({ where: { id, userId, ...ACTIVE } });
            if (!current) return false;

            const now = new Date();
            await tx.address.update({
                where: { id },
                data: { isActive: false, archivedAt: now, isDefault: false, updatedAt: now },
            });
            if (current.isDefault) {
                const next = await tx.address.findFirst({
                    where: { userId, ...ACTIVE },
                    orderBy: { createdAt: 'desc' },
                    select: { id: true },
                });
                if (next) {
                    await tx.address.update({
                        where: { id: next.id },
                        data: { isDefault: true, updatedAt: now },
                    });
                }
            }
            return true;
        });
    }

    /** Makes this the one default. Idempotent. Null when it is not the user's live address. */
    setDefault(userId: string, id: string): Promise<Address | null> {
        return this.prisma.$transaction(async (tx) => {
            await lockUser(tx, userId);
            const target = await tx.address.findFirst({ where: { id, userId, ...ACTIVE } });
            if (!target) return null;
            if (target.isDefault) return target;

            const now = new Date();
            // Clear first: the partial unique index allows one default at a time.
            await tx.address.updateMany({
                where: { userId, isDefault: true, ...ACTIVE },
                data: { isDefault: false, updatedAt: now },
            });
            return tx.address.update({
                where: { id },
                data: { isDefault: true, updatedAt: now },
            });
        });
    }
}

async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
}

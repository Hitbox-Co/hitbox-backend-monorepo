import { Prisma, VirusScanStatus } from '@hitbox/database';
import type { AssetType, MediaAsset, PrismaClient } from '@hitbox/database';
import { ownerColumn } from '../domain/storage-key';
import type { OwnerType } from '../domain/storage-key';
import type { ListMediaQuery, ScanResultDto } from '../dto/media.dto';

/** The only place in this module that touches Prisma. */
export class MediaRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<MediaAsset | null> {
        return this.prisma.mediaAsset.findUnique({ where: { id } });
    }

    create(input: {
        id: string;
        assetType: AssetType;
        storageRef: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number | null;
        uploadedById: string;
        ownerColumn: 'productId' | 'collectionId' | 'organizationId' | 'artistId' | null;
        ownerId: string;
        organizationId: string | null;
    }): Promise<MediaAsset> {
        return this.prisma.mediaAsset.create({
            data: {
                id: input.id,
                assetType: input.assetType,
                storageRef: input.storageRef,
                fileName: input.fileName,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
                // Always PENDING on creation — nothing is servable until the
                // scanner says otherwise.
                virusScanStatus: VirusScanStatus.PENDING,
                uploadedById: input.uploadedById,
                createdAt: new Date(),
                ...(input.ownerColumn ? { [input.ownerColumn]: input.ownerId } : {}),
                // The owning org is recorded even when the owner column is a
                // product or collection, so scope filtering stays one column.
                ...(input.organizationId && input.ownerColumn !== 'organizationId'
                    ? { organizationId: input.organizationId }
                    : {}),
            },
        });
    }

    async list(
        input: ListMediaQuery & {
            organizationIds: string[] | null;
            skip: number;
            take: number;
        },
    ): Promise<{ total: number; items: MediaAsset[] }> {
        const where = this.buildWhere(input);
        const [total, items] = await Promise.all([
            this.prisma.mediaAsset.count({ where }),
            this.prisma.mediaAsset.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: input.skip,
                take: input.take,
            }),
        ]);
        return { total, items };
    }

    async countByType(organizationIds: string[] | null): Promise<Record<string, number>> {
        const rows = await this.prisma.mediaAsset.groupBy({
            by: ['assetType'],
            where: this.scopeWhere(organizationIds),
            _count: { _all: true },
        });
        const out: Record<string, number> = {};
        for (const row of rows) out[row.assetType] = row._count._all;
        return out;
    }

    async countByScanStatus(
        organizationIds: string[] | null,
    ): Promise<Record<string, number>> {
        const rows = await this.prisma.mediaAsset.groupBy({
            by: ['virusScanStatus'],
            where: this.scopeWhere(organizationIds),
            _count: { _all: true },
        });
        const out: Record<string, number> = {};
        for (const row of rows) out[row.virusScanStatus] = row._count._all;
        return out;
    }

    archive(id: string): Promise<MediaAsset> {
        return this.prisma.mediaAsset.update({
            where: { id },
            data: { archivedAt: new Date() },
        });
    }

    setScanResult(dto: ScanResultDto): Promise<MediaAsset> {
        return this.prisma.mediaAsset.update({
            where: { id: dto.assetId },
            data: {
                virusScanStatus: dto.virusScanStatus,
                ...(dto.checksum ? { checksum: dto.checksum } : {}),
                ...(dto.sizeBytes !== undefined ? { sizeBytes: dto.sizeBytes } : {}),
            },
        });
    }

    // ── Owner to organization resolution ────────────────────────────────────
    // The owning organization comes from the owner record, never from the
    // request body — that is what makes the scope check meaningful.

    async organizationOfProduct(productId: string): Promise<string | null> {
        const row = await this.prisma.product.findUnique({
            where: { id: productId },
            select: { organizationId: true },
        });
        return row?.organizationId ?? null;
    }

    async organizationOfCollection(collectionId: string): Promise<string | null> {
        const row = await this.prisma.artistCollection.findUnique({
            where: { id: collectionId },
            select: { organizationId: true },
        });
        return row?.organizationId ?? null;
    }

    async organizationOfArtist(artistId: string): Promise<string | null> {
        const row = await this.prisma.artist.findUnique({
            where: { id: artistId },
            select: { organizationId: true },
        });
        return row?.organizationId ?? null;
    }

    private scopeWhere(organizationIds: string[] | null): Prisma.MediaAssetWhereInput {
        return organizationIds === null ? {} : { organizationId: { in: organizationIds } };
    }

    private buildWhere(
        input: ListMediaQuery & { organizationIds: string[] | null },
    ): Prisma.MediaAssetWhereInput {
        const where: Prisma.MediaAssetWhereInput = {
            ...this.scopeWhere(input.organizationIds),
            ...(input.assetType ? { assetType: input.assetType } : {}),
            ...(input.virusScanStatus ? { virusScanStatus: input.virusScanStatus } : {}),
        };
        if (input.ownerType && input.ownerId) {
            const column = ownerColumn(input.ownerType as OwnerType);
            if (column) Object.assign(where, { [column]: input.ownerId });
            else Object.assign(where, { uploadedById: input.ownerId });
        }
        return where;
    }
}

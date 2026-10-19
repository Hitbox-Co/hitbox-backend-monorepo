import { randomUUID } from 'node:crypto';
import { Prisma } from '@hitbox/database';
import type { ArtistTaxDocument, PrismaClient } from '@hitbox/database';
import type {
    ListArtistTaxDocumentsQuery,
    RegisterArtistTaxDocumentDto,
} from '../dto/tax.dto';

export class ArtistTaxDocumentRepository {
    constructor(private readonly prisma: PrismaClient) { }

    findById(id: string): Promise<ArtistTaxDocument | null> {
        return this.prisma.artistTaxDocument.findUnique({ where: { id } });
    }

    /** The current, non-archived document of one type for one artist. */
    findLive(
        artistId: string,
        documentType: ArtistTaxDocument['documentType'],
        countryCode: string,
    ): Promise<ArtistTaxDocument | null> {
        return this.prisma.artistTaxDocument.findFirst({
            where: {
                artistId,
                documentType,
                countryCode,
                status: { not: 'ARCHIVED' },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async list(
        query: ListArtistTaxDocumentsQuery & {
            /** Set for an OWN-scoped artist caller. */
            restrictToArtistIds: string[] | null;
            skip: number;
            take: number;
            now: Date;
        },
    ): Promise<{ total: number; items: ArtistTaxDocument[] }> {
        const where: Prisma.ArtistTaxDocumentWhereInput = {
            ...(query.restrictToArtistIds === null
                ? {}
                : { artistId: { in: query.restrictToArtistIds } }),
            ...(query.artistId ? { artistId: query.artistId } : {}),
            ...(query.countryCode ? { countryCode: query.countryCode } : {}),
            ...(query.documentType ? { documentType: query.documentType } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.expiringWithinDays
                ? {
                    expiresAt: {
                        not: null,
                        gte: query.now,
                        lte: new Date(query.now.getTime() + query.expiringWithinDays * 86_400_000),
                    },
                }
                : {}),
        };

        const [total, items] = await Promise.all([
            this.prisma.artistTaxDocument.count({ where }),
            this.prisma.artistTaxDocument.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }],
                skip: query.skip,
                take: query.take,
            }),
        ]);
        return { total, items };
    }

    /**
     * Registers a new document, archiving whatever it replaces — in one
     * transaction, because the unique index allows exactly one live row per
     * (artist, type, country, status) and inserting before archiving would
     * collide with it.
     *
     * Archiving rather than updating keeps the old W-9 readable: HitBox has to
     * be able to show which document was on file at the time a payment was
     * made, not just the current one.
     */
    async registerReplacing(
        dto: RegisterArtistTaxDocumentDto,
        options: { createdById: string | null; backupWithholdingRate: string | null },
    ): Promise<ArtistTaxDocument> {
        const now = new Date();
        return this.prisma.$transaction(async (tx) => {
            await tx.artistTaxDocument.updateMany({
                where: {
                    artistId: dto.artistId,
                    documentType: dto.documentType,
                    countryCode: dto.countryCode,
                    status: { not: 'ARCHIVED' },
                },
                data: { status: 'ARCHIVED', updatedAt: now },
            });

            return tx.artistTaxDocument.create({
                data: {
                    id: randomUUID(),
                    artistId: dto.artistId,
                    countryCode: dto.countryCode,
                    documentType: dto.documentType,
                    documentStorageRef: dto.storageRef,
                    documentSha256: dto.documentSha256 ?? null,
                    documentNumber: dto.documentNumber ?? null,
                    issuerName: dto.issuerName ?? null,
                    issueDate: dto.issueDate ?? null,
                    expiresAt: dto.expiresAt ?? null,
                    status: 'PENDING_REVIEW',
                    // A document that has not been verified cannot exempt the
                    // artist from withholding, so a fresh registration always
                    // starts withheld and the review is what clears it.
                    backupWithholdingApplied: options.backupWithholdingRate !== null,
                    backupWithholdingRate: options.backupWithholdingRate,
                    notes: dto.notes ?? null,
                    createdById: options.createdById,
                    createdAt: now,
                    updatedAt: now,
                },
            });
        });
    }

    review(
        id: string,
        decision: {
            status: 'APPROVED' | 'REJECTED';
            verifiedById: string;
            notes: string;
            backupWithholdingApplied: boolean;
        },
    ): Promise<ArtistTaxDocument> {
        const now = new Date();
        return this.prisma.artistTaxDocument.update({
            where: { id },
            data: {
                status: decision.status,
                verifiedById: decision.verifiedById,
                verifiedAt: now,
                notes: decision.notes,
                backupWithholdingApplied: decision.backupWithholdingApplied,
                updatedAt: now,
            },
        });
    }

    /** Sweeps documents past their expiry into EXPIRED. Idempotent. */
    async expire(now: Date): Promise<number> {
        const result = await this.prisma.artistTaxDocument.updateMany({
            where: { status: 'APPROVED', expiresAt: { not: null, lt: now } },
            data: { status: 'EXPIRED', backupWithholdingApplied: true, updatedAt: now },
        });
        return result.count;
    }
}

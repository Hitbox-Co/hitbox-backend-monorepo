import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { ArtistTaxDocument } from '@hitbox/database';
import {
    TAX_AUDIT_EVENTS,
    TAX_ERROR_CODES,
    TAX_EVENTS,
    US_BACKUP_WITHHOLDING_RATE,
} from '../constants/tax.constant';
import type { TaxAccess } from '../domain/tax-access';
import { TaxScope, requireTaxManage } from '../domain/tax-access';
import type { IDocumentStorage } from '../domain/interfaces/document-storage.port';
import type { IArtistOwnership } from '../domain/interfaces/payout-lookup.port';
import type { ITaxAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { recordTaxAudit } from '../domain/interfaces/audit-recorder.port';
import type { ArtistTaxDocumentRepository } from '../repository/artist-tax-document.repository';
import type {
    ListArtistTaxDocumentsQuery,
    RegisterArtistTaxDocumentDto,
    ReviewArtistTaxDocumentDto,
} from '../dto/tax.dto';

/** Short, because the thing behind the link may be a W-9 carrying an SSN. */
const DOWNLOAD_URL_TTL_SECONDS = 120;

export interface ArtistTaxDocumentServiceDeps {
    documents: ArtistTaxDocumentRepository;
    artists: IArtistOwnership;
    storage: IDocumentStorage | null;
    eventBus: IEventBus;
    audit: ITaxAuditRecorder;
    logger: Logger;
}

/**
 * Artist tax paperwork: W-9 (US), PAN and GST registration (India).
 *
 * The rule this service exists to enforce is the one from §2.2 of the
 * compliance guide: **HitBox must have a valid W-9 on file before the first
 * payment to a US artist, and without one the IRS requires 24% backup
 * withholding.** So a document's verification state is not paperwork hygiene —
 * it decides how much money the artist receives. `backupWithholdingApplied` is
 * denormalised onto the row precisely so the payout path can ask one question
 * and get one answer, rather than interpreting document status itself.
 *
 * A freshly registered document always starts withheld; the *review* is what
 * clears it. That is the safe default: the failure mode of withholding on an
 * artist who did file a valid W-9 is a refund at tax time, and the failure mode
 * of not withholding on one who did not is an IRS penalty against HitBox.
 */
export class ArtistTaxDocumentService {
    constructor(private readonly deps: ArtistTaxDocumentServiceDeps) { }

    async list(
        query: ListArtistTaxDocumentsQuery,
        access: TaxAccess,
    ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number } }> {
        const restrictToArtistIds = await this.restriction(access);
        const { total, items } = await this.deps.documents.list({
            ...query,
            restrictToArtistIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            now: new Date(),
        });
        return {
            data: items.map((document) => present(document, access)),
            meta: { page: query.page, limit: query.limit, total },
        };
    }

    async getById(id: string, access: TaxAccess): Promise<unknown> {
        return present(await this.requireInScope(id, access), access);
    }

    /**
     * Records a document the artist has already uploaded to S3.
     *
     * An artist may register their own (`payment-royalty:read:own` reaches
     * their artist record); a HitBox operator may register one on their behalf,
     * which is the normal path when paperwork arrives by e-mail.
     */
    async register(
        dto: RegisterArtistTaxDocumentDto,
        access: TaxAccess,
    ): Promise<unknown> {
        await this.assertReachesArtist(dto.artistId, access);

        const created = await this.deps.documents.registerReplacing(dto, {
            createdById: access.userId,
            // Only US documents carry backup withholding; an Indian PAN has no
            // equivalent, and TDS is deducted regardless of paperwork.
            backupWithholdingRate:
                dto.countryCode === 'US' ? US_BACKUP_WITHHOLDING_RATE : null,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.ARTIST_DOCUMENT_REVIEW,
            actorId: access.userId,
            targetType: 'ArtistTaxDocument',
            targetId: created.id,
            metadata: {
                action: 'register',
                artistId: dto.artistId,
                documentType: dto.documentType,
                countryCode: dto.countryCode,
            },
        });
        return present(created, access);
    }

    /**
     * Verifies or rejects a document. HitBox-side only — an artist cannot
     * approve their own W-9, which is the whole point of the review step.
     */
    async review(
        id: string,
        dto: ReviewArtistTaxDocumentDto,
        access: TaxAccess,
    ): Promise<unknown> {
        requireTaxManage(access, 'verify an artist tax document');
        const document = await this.requireInScope(id, access);

        if (document.status !== 'PENDING_REVIEW') {
            throw AppError.conflict(
                `This document is already ${document.status}.`,
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const approved = dto.decision === 'APPROVE';
        const updated = await this.deps.documents.review(id, {
            status: approved ? 'APPROVED' : 'REJECTED',
            verifiedById: access.userId,
            notes: dto.reason,
            // Approving a US W-9 is exactly the event that lifts withholding.
            backupWithholdingApplied:
                document.countryCode === 'US' && document.documentType === 'W9'
                    ? !approved
                    : document.backupWithholdingApplied,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.ARTIST_DOCUMENT_REVIEW,
            actorId: access.userId,
            targetType: 'ArtistTaxDocument',
            targetId: id,
            metadata: {
                action: 'review',
                decision: dto.decision,
                reason: dto.reason,
                artistId: document.artistId,
                documentType: document.documentType,
                backupWithholdingApplied: updated.backupWithholdingApplied,
            },
        });
        this.deps.eventBus.publish(TAX_EVENTS.ARTIST_DOCUMENT_REVIEWED, {
            documentId: id,
            artistId: document.artistId,
            documentType: document.documentType,
            status: updated.status,
            backupWithholdingApplied: updated.backupWithholdingApplied,
        });

        return present(updated, access);
    }

    /**
     * A very short-lived link to the file.
     *
     * Two minutes rather than the invoice's five: a W-9 carries a taxpayer
     * identification number, and the window in which a leaked URL is useful
     * should be about as long as it takes to click it. Always audited.
     */
    async downloadUrl(
        id: string,
        access: TaxAccess,
    ): Promise<{ url: string; expiresIn: number }> {
        const document = await this.requireInScope(id, access);
        if (!this.deps.storage) {
            throw AppError.badRequest(
                'Document storage is not configured on this deployment.',
                TAX_ERROR_CODES.STORAGE_UNAVAILABLE,
            );
        }
        if (!document.documentStorageRef) {
            throw AppError.notFound(
                'This record has no stored file.',
                TAX_ERROR_CODES.DOCUMENT_NOT_RENDERED,
            );
        }

        const link = await this.deps.storage.presignDownload({
            key: document.documentStorageRef,
            expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.ARTIST_DOCUMENT_DOWNLOAD,
            actorId: access.userId,
            targetType: 'ArtistTaxDocument',
            targetId: id,
            metadata: {
                artistId: document.artistId,
                documentType: document.documentType,
                scope: access.scope,
            },
        });
        return link;
    }

    /**
     * Whether this artist may be paid without withholding.
     *
     * The question the payout path asks. Kept here rather than in finance
     * because the answer is about documents, and documents are this module's.
     */
    async withholdingStatus(
        artistId: string,
        countryCode: string,
    ): Promise<{ backupWithholdingApplied: boolean; rate: string | null; reason: string }> {
        if (countryCode !== 'US') {
            return {
                backupWithholdingApplied: false,
                rate: null,
                reason: 'Backup withholding is a US rule; this artist is not US-taxed.',
            };
        }
        const w9 = await this.deps.documents.findLive(artistId, 'W9', 'US');
        if (!w9) {
            return {
                backupWithholdingApplied: true,
                rate: US_BACKUP_WITHHOLDING_RATE,
                reason: 'No W-9 on file.',
            };
        }
        if (w9.status !== 'APPROVED') {
            return {
                backupWithholdingApplied: true,
                rate: US_BACKUP_WITHHOLDING_RATE,
                reason: `W-9 is ${w9.status}, not verified.`,
            };
        }
        return {
            backupWithholdingApplied: false,
            rate: null,
            reason: 'Verified W-9 on file.',
        };
    }

    /** Sweeps expired documents. Call from the scheduler; idempotent. */
    async expireLapsedDocuments(): Promise<number> {
        const count = await this.deps.documents.expire(new Date());
        if (count > 0) {
            this.deps.logger.info(
                { count },
                'artist tax documents moved to EXPIRED — withholding now applies to them',
            );
        }
        return count;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /** Null = unrestricted; an array = only these artists. */
    private async restriction(access: TaxAccess): Promise<string[] | null> {
        if (access.scope === TaxScope.GLOBAL) return null;
        if (access.scope === TaxScope.BUYER) {
            // A buyer has no business in this table at all.
            throw AppError.forbidden(
                'Artist tax documents are not part of the buyer surface.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
        return this.deps.artists.findArtistIdsForUser(access.userId);
    }

    private async assertReachesArtist(artistId: string, access: TaxAccess): Promise<void> {
        const restriction = await this.restriction(access);
        if (restriction !== null && !restriction.includes(artistId)) {
            throw AppError.forbidden(
                'You may only manage tax documents for your own artist record.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
    }

    private async requireInScope(
        id: string,
        access: TaxAccess,
    ): Promise<ArtistTaxDocument> {
        const document = await this.deps.documents.findById(id);
        if (!document) {
            throw AppError.notFound('Tax document not found.', TAX_ERROR_CODES.NOT_FOUND);
        }
        await this.assertReachesArtist(document.artistId, access);
        return document;
    }
}

/**
 * The API shape.
 *
 * `documentNumber` — a PAN or GSTIN — is returned only to a global-scoped
 * operator and to the artist it belongs to, which `restriction` has already
 * guaranteed by the time this runs. `documentStorageRef` is never returned to
 * anyone: the file is reached through the presigned-download route, and the key
 * itself is not part of the artist's view of their own paperwork.
 */
function present(document: ArtistTaxDocument, access: TaxAccess): unknown {
    return {
        id: document.id,
        artistId: document.artistId,
        countryCode: document.countryCode,
        documentType: document.documentType,
        documentNumber: document.documentNumber,
        issuerName: document.issuerName,
        issueDate: document.issueDate,
        expiresAt: document.expiresAt,
        status: document.status,
        verifiedAt: document.verifiedAt,
        backupWithholdingApplied: document.backupWithholdingApplied,
        backupWithholdingRate: document.backupWithholdingRate?.toString() ?? null,
        notes: document.notes,
        createdAt: document.createdAt,
        documentAvailable: document.documentStorageRef !== null,
        ...(access.scope === TaxScope.GLOBAL
            ? {
                documentSha256: document.documentSha256,
                verifiedById: document.verifiedById,
                createdById: document.createdById,
            }
            : {}),
    };
}

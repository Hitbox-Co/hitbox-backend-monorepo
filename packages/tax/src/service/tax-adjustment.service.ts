import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Currency, TaxAdjustmentEntry } from '@hitbox/database';
import { TAX_AUDIT_EVENTS, TAX_ERROR_CODES, TAX_EVENTS } from '../constants/tax.constant';
import { subtractMoney } from '../domain/money';
import type { TaxAccess } from '../domain/tax-access';
import { requireTaxManage, requireTaxOverride } from '../domain/tax-access';
import type { ITaxAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { recordTaxAudit } from '../domain/interfaces/audit-recorder.port';
import type { InvoiceRepository } from '../repository/invoice.repository';
import type { TaxAdjustmentRepository } from '../repository/tax-adjustment.repository';
import type {
    CreateTaxAdjustmentDto,
    DecideTaxAdjustmentDto,
    ListTaxAdjustmentsQuery,
} from '../dto/tax.dto';

export interface TaxAdjustmentServiceDeps {
    adjustments: TaxAdjustmentRepository;
    invoices: InvoiceRepository;
    eventBus: IEventBus;
    audit: ITaxAuditRecorder;
    logger: Logger;
}

/**
 * Corrections to an issued invoice's tax figure.
 *
 * Two powers, deliberately held by different capabilities:
 *
 *   **Raising** a correction takes `payment-royalty:manage` — it is the normal
 *   act of an operator who spotted a wrong rate.
 *
 *   **Approving** one takes `payment-royalty:override` — it changes a figure
 *   that has already been reported to a tax authority, which is a different
 *   kind of act entirely, and the catalog already separates the two.
 *
 * On top of that, an adjustment can never be approved by the person who raised
 * it. Four-eyes on a statutory correction is not ceremony: a single person able
 * to both assert and accept a change to a filed tax figure is the exact shape
 * of control failure a tax audit looks for.
 */
export class TaxAdjustmentService {
    constructor(private readonly deps: TaxAdjustmentServiceDeps) { }

    async list(
        query: ListTaxAdjustmentsQuery,
        access: TaxAccess,
    ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number } }> {
        requireTaxManage(access, 'read tax adjustments');
        const { total, items } = await this.deps.adjustments.list({
            ...query,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            data: items.map(present),
            meta: { page: query.page, limit: query.limit, total },
        };
    }

    async create(dto: CreateTaxAdjustmentDto, access: TaxAccess): Promise<unknown> {
        requireTaxManage(access, 'raise a tax adjustment');

        const invoice = await this.deps.invoices.findById(dto.invoiceId);
        if (!invoice) {
            throw AppError.notFound('Invoice not found.', TAX_ERROR_CODES.NOT_FOUND);
        }
        if (invoice.status === 'VOID') {
            throw AppError.conflict(
                'A void invoice has no tax figure to correct — it was cancelled in full.',
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const original = invoice.taxAmount.toString();
        const delta = subtractMoney(dto.adjustedTaxAmount, original);
        if (delta === '0.00') {
            throw AppError.badRequest(
                'The adjusted tax equals what the invoice already says.',
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const created = await this.deps.adjustments.create({
            invoiceId: dto.invoiceId,
            adjustmentType: dto.adjustmentType,
            reason: dto.reason,
            originalTaxAmount: original,
            adjustedTaxAmount: dto.adjustedTaxAmount,
            adjustmentAmount: delta,
            currency: invoice.currency as Currency,
            createdById: access.userId,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.ADJUSTMENT_APPROVE,
            actorId: access.userId,
            targetType: 'TaxAdjustmentEntry',
            targetId: created.id,
            metadata: {
                action: 'raise',
                invoiceId: dto.invoiceId,
                invoiceNumber: invoice.invoiceNumber,
                adjustmentType: dto.adjustmentType,
                originalTaxAmount: original,
                adjustedTaxAmount: dto.adjustedTaxAmount,
                reason: dto.reason,
            },
        });
        return present(created);
    }

    async decide(
        id: string,
        dto: DecideTaxAdjustmentDto,
        access: TaxAccess,
    ): Promise<unknown> {
        requireTaxOverride(access, 'approve a correction to an issued tax figure');

        const adjustment = await this.deps.adjustments.findById(id);
        if (!adjustment) {
            throw AppError.notFound('Tax adjustment not found.', TAX_ERROR_CODES.NOT_FOUND);
        }
        if (adjustment.status !== 'PENDING_APPROVAL') {
            throw AppError.conflict(
                `This adjustment is already ${adjustment.status}.`,
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }
        if (adjustment.createdById && adjustment.createdById === access.userId) {
            throw AppError.forbidden(
                'You raised this adjustment, so you may not also approve it. A correction to ' +
                'a figure already reported to a tax authority needs a second pair of eyes.',
                TAX_ERROR_CODES.SEPARATION_OF_DUTIES,
            );
        }

        const updated = await this.deps.adjustments.decide(id, {
            status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            approvedById: access.userId,
            reason: dto.reason,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.ADJUSTMENT_APPROVE,
            actorId: access.userId,
            targetType: 'TaxAdjustmentEntry',
            targetId: id,
            metadata: {
                action: 'decide',
                decision: dto.decision,
                reason: dto.reason,
                invoiceId: adjustment.invoiceId,
                adjustmentAmount: adjustment.adjustmentAmount.toString(),
            },
        });

        if (dto.decision === 'APPROVE') {
            // The invoice row itself is NOT rewritten. The issued document
            // stays as issued and this entry is the correction — same
            // append-only rule the finance ledgers follow, and the reason a
            // tax authority can see both what was filed and what changed.
            this.deps.eventBus.publish(TAX_EVENTS.ADJUSTMENT_APPROVED, {
                adjustmentId: id,
                invoiceId: adjustment.invoiceId,
                adjustmentAmount: adjustment.adjustmentAmount.toString(),
                currency: adjustment.currency,
            });
        }

        return present(updated);
    }
}

function present(adjustment: TaxAdjustmentEntry): unknown {
    return {
        id: adjustment.id,
        invoiceId: adjustment.invoiceId,
        adjustmentType: adjustment.adjustmentType,
        reason: adjustment.reason,
        originalTaxAmount: adjustment.originalTaxAmount.toString(),
        adjustedTaxAmount: adjustment.adjustedTaxAmount.toString(),
        adjustmentAmount: adjustment.adjustmentAmount.toString(),
        currency: adjustment.currency,
        status: adjustment.status,
        createdById: adjustment.createdById,
        approvedById: adjustment.approvedById,
        approvedAt: adjustment.approvedAt,
        rejectionReason: adjustment.rejectionReason,
        createdAt: adjustment.createdAt,
    };
}

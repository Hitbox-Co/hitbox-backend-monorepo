import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import type { IEventBus } from '@hitbox/shared';
import type { Currency, TaxReturnFiling } from '@hitbox/database';
import {
    FORM_1099_NEC_THRESHOLD_USD,
    TAX_AUDIT_EVENTS,
    TAX_ERROR_CODES,
    TAX_EVENTS,
    TDS_RATE_ROYALTY,
} from '../constants/tax.constant';
import { filingDueDate } from '../domain/fiscal-calendar';
import { compareMoney, subtractMoney, sumMoney, taxOn } from '../domain/money';
import type { TaxAccess } from '../domain/tax-access';
import { TaxScope, requireTaxExport, requireTaxManage } from '../domain/tax-access';
import type { IArtistOwnership, IPayoutLookup } from '../domain/interfaces/payout-lookup.port';
import type { ITaxAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { recordTaxAudit } from '../domain/interfaces/audit-recorder.port';
import type { InvoiceRepository } from '../repository/invoice.repository';
import type { TaxFilingRepository } from '../repository/tax-filing.repository';
import type {
    CreateTaxFilingDto,
    ListTaxFilingsQuery,
    MarkTaxFilingFiledDto,
    TaxSummaryQuery,
} from '../dto/tax.dto';

export interface TaxFilingServiceDeps {
    filings: TaxFilingRepository;
    invoices: InvoiceRepository;
    payouts: IPayoutLookup;
    artists: IArtistOwnership;
    eventBus: IEventBus;
    audit: ITaxAuditRecorder;
    logger: Logger;
}

/**
 * Tax returns and information returns.
 *
 * Two quite different things share this table, and the difference is worth
 * stating because it decides who may see what:
 *
 *   **Returns HitBox files about itself** — GSTR-1, GSTR-3B, a state
 *   sales-tax return. Built from every invoice in the period, across every
 *   artist. Platform-scoped, and an artist must never see one: HitBox's GSTR-1
 *   is a list of every sale it made, including other artists'.
 *
 *   **Information returns HitBox files about an artist** — Form 16A (India,
 *   TDS certificate) and 1099-NEC (US). These belong to the artist as much as
 *   to HitBox: the artist files their own taxes with them. An artist reads
 *   their own and nobody else's.
 *
 * `listFilings` enforces exactly that split through `restrictToArtistIds` — an
 * artist-scoped caller is filtered to rows carrying their `artistId`, which no
 * GSTR row ever has.
 */
export class TaxFilingService {
    constructor(private readonly deps: TaxFilingServiceDeps) { }

    // ── Reports (the data a return is built from) ────────────────────────────

    /**
     * The indirect-tax summary for a period: what GSTR-1/3B or a state return
     * is filed from.
     *
     * Includes the HSN-wise breakdown unconditionally, because GSTR-1 requires
     * it and producing it separately would invite the two being run over
     * different date ranges.
     */
    async indirectTaxSummary(query: TaxSummaryQuery, access: TaxAccess): Promise<unknown> {
        if (access.scope !== TaxScope.GLOBAL) {
            throw AppError.forbidden(
                'Tax return data is platform-wide and covers every seller on it.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }

        const filter = {
            countryCode: query.countryCode,
            stateCode: query.stateCode,
            periodStart: query.periodStart,
            periodEnd: query.periodEnd,
        };
        const [totals, byClassification] = await Promise.all([
            this.deps.invoices.summariseForPeriod(filter),
            this.deps.invoices.summariseByClassification(filter),
        ]);

        return {
            countryCode: query.countryCode,
            stateCode: query.stateCode ?? null,
            period: { start: query.periodStart, end: query.periodEnd },
            invoiceCount: totals.invoiceCount,
            taxableValue: totals.subtotal,
            taxCollected: totals.taxAmount,
            grossValue: totals.totalAmount,
            // Named for what it is in each regime, so the figure can be typed
            // straight into the right box.
            filingHint:
                query.countryCode === 'IN'
                    ? 'GSTR-1 table 12 (HSN-wise summary); GSTR-3B 3.1(a) output tax.'
                    : 'State sales-tax return: gross sales, taxable sales, tax due.',
            byClassification,
        };
    }

    /**
     * What a 1099-NEC would report for one artist in a calendar year.
     *
     * Box 1 sums **paid** payouts, per §2.2 of the compliance guide as revised
     * on 2026-09-15: a quarter that is still pending approval, or was rejected,
     * is excluded until it clears. This method is the place that rule is
     * actually implemented — it never reads the royalty ledger.
     */
    async form1099Preview(
        input: { artistId: string; taxYear: number },
        access: TaxAccess,
    ): Promise<unknown> {
        await this.assertReachesArtist(input.artistId, access);

        const from = new Date(Date.UTC(input.taxYear, 0, 1));
        const to = new Date(Date.UTC(input.taxYear + 1, 0, 1));
        const paid = (
            await this.deps.payouts.findPaidForArtist({ artistId: input.artistId, from, to })
        ).filter((payout) => payout.currency === 'USD');

        const box1 = sumMoney(paid.map((payout) => payout.amount));
        const reportable = compareMoney(box1, FORM_1099_NEC_THRESHOLD_USD) >= 0;

        return {
            artistId: input.artistId,
            taxYear: input.taxYear,
            currency: 'USD',
            box1Royalties: box1,
            payoutCount: paid.length,
            threshold: FORM_1099_NEC_THRESHOLD_USD,
            reportable,
            reason: reportable
                ? 'Above the $600 annual threshold — a 1099-NEC is required.'
                : `Below the $${FORM_1099_NEC_THRESHOLD_USD} threshold — no 1099-NEC is required.`,
            payouts: paid.map((payout) => ({
                payoutId: payout.payoutId,
                amount: payout.amount,
                paidAt: payout.paidAt,
            })),
        };
    }

    /**
     * What a Form 16A would certify for one artist in a quarter.
     *
     * TDS at 30% (s.194O) on the approved, paid payout — gross, deducted and
     * net, which is exactly the three figures the certificate carries.
     */
    async form16aPreview(
        input: { artistId: string; periodStart: Date; periodEnd: Date },
        access: TaxAccess,
    ): Promise<unknown> {
        await this.assertReachesArtist(input.artistId, access);

        const paid = (
            await this.deps.payouts.findPaidForArtist({
                artistId: input.artistId,
                from: input.periodStart,
                to: input.periodEnd,
            })
        ).filter((payout) => payout.currency === 'INR');

        const gross = sumMoney(paid.map((payout) => payout.amount));
        const tds = taxOn(gross, TDS_RATE_ROYALTY);

        return {
            artistId: input.artistId,
            period: { start: input.periodStart, end: input.periodEnd },
            currency: 'INR',
            section: '194O',
            tdsRate: TDS_RATE_ROYALTY,
            grossRoyalty: gross,
            tdsDeducted: tds,
            netPaid: subtractMoney(gross, tds),
            payoutCount: paid.length,
            payouts: paid.map((payout) => ({
                payoutId: payout.payoutId,
                amount: payout.amount,
                paidAt: payout.paidAt,
            })),
        };
    }

    // ── Filings ─────────────────────────────────────────────────────────────

    async list(
        query: ListTaxFilingsQuery,
        access: TaxAccess,
    ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number } }> {
        const restrictToArtistIds =
            access.scope === TaxScope.GLOBAL
                ? null
                : await this.deps.artists.findArtistIdsForUser(access.userId);

        const { total, items } = await this.deps.filings.list({
            ...query,
            restrictToArtistIds,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            data: items.map(present),
            meta: { page: query.page, limit: query.limit, total },
        };
    }

    async getById(id: string, access: TaxAccess): Promise<unknown> {
        return present(await this.requireInScope(id, access));
    }

    /**
     * Creates a filing with its figures already computed.
     *
     * For an information return this is where the payout gate is enforced: the
     * payout must exist, must belong to the named artist, and must be PAID. And
     * the caller must not be the person who approved it — separation of duties,
     * which §8 of the compliance guide explicitly asks for as a control point
     * when Phase 3 lands. The rule is not that approving is suspicious; it is
     * that one person should not be able to both release money and produce the
     * document that says the money was released.
     */
    async create(dto: CreateTaxFilingDto, access: TaxAccess): Promise<unknown> {
        requireTaxManage(access, 'create a tax filing');

        let totalTaxableAmount: string | null = null;
        let totalTaxCollected: string | null = null;
        let totalTaxDue: string | null = null;
        let currency: Currency = dto.countryCode === 'IN' ? 'INR' : 'USD';

        if (dto.filingType === 'FORM_16A' || dto.filingType === 'FORM_1099_NEC') {
            const payout = await this.deps.payouts.findById(dto.payoutId as string);
            if (!payout) {
                throw AppError.notFound(
                    'The payout this filing reports does not exist.',
                    TAX_ERROR_CODES.NOT_FOUND,
                );
            }
            if (payout.payeeArtistId !== dto.artistId) {
                throw AppError.badRequest(
                    'That payout was not made to this artist.',
                    TAX_ERROR_CODES.PAYOUT_NOT_REPORTABLE,
                );
            }
            if (payout.status !== 'PAID') {
                throw AppError.badRequest(
                    `Form 16A and 1099-NEC report royalty that was *paid*; this payout is ` +
                    `${payout.status}. It becomes reportable once it is approved and the ` +
                    `transfer executes, and carries forward to the next cycle until then.`,
                    TAX_ERROR_CODES.PAYOUT_NOT_REPORTABLE,
                );
            }
            if (payout.approvedById && payout.approvedById === access.userId) {
                throw AppError.forbidden(
                    'You approved this payout, so you may not also file the return that ' +
                    'reports it. Ask another operator with payment-royalty:manage to file it.',
                    TAX_ERROR_CODES.SEPARATION_OF_DUTIES,
                );
            }

            currency = payout.currency as Currency;
            totalTaxableAmount = payout.amount;
            totalTaxCollected =
                dto.filingType === 'FORM_16A' ? taxOn(payout.amount, TDS_RATE_ROYALTY) : '0.00';
            totalTaxDue = totalTaxCollected;
        } else {
            const summary = await this.deps.invoices.summariseForPeriod({
                countryCode: dto.countryCode,
                stateCode: dto.stateCode,
                periodStart: dto.periodStart,
                periodEnd: dto.periodEnd,
            });
            totalTaxableAmount = summary.subtotal;
            totalTaxCollected = summary.taxAmount;
            // Net of input tax credit, which India allows and the US does not.
            // ITC is entered by the operator when the GSTR-3B is prepared, so
            // the figure starts equal to output tax.
            totalTaxDue = summary.taxAmount;
        }

        const created = await this.deps.filings.create(dto, {
            totalTaxableAmount,
            totalTaxCollected,
            totalTaxDue,
            currency,
            dueDate: filingDueDate(dto.filingType, {
                start: dto.periodStart,
                end: dto.periodEnd,
                label: '',
            }),
            createdById: access.userId,
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.FILING_CREATE,
            actorId: access.userId,
            targetType: 'TaxReturnFiling',
            targetId: created.id,
            metadata: {
                filingType: dto.filingType,
                countryCode: dto.countryCode,
                stateCode: dto.stateCode ?? null,
                artistId: dto.artistId ?? null,
                payoutId: dto.payoutId ?? null,
                totalTaxCollected,
            },
        });
        return present(created);
    }

    /** Records the government acknowledgement once the return is lodged. */
    async markFiled(
        id: string,
        dto: MarkTaxFilingFiledDto,
        access: TaxAccess,
    ): Promise<unknown> {
        requireTaxManage(access, 'mark a tax filing as filed');
        const filing = await this.requireInScope(id, access);

        if (filing.status === 'FILED' || filing.status === 'ACCEPTED') {
            throw AppError.conflict(
                `This filing is already ${filing.status}.`,
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const updated = await this.deps.filings.markFiled(id, {
            referenceNumber: dto.referenceNumber,
            filedAt: dto.filedAt ?? new Date(),
            filedById: access.userId,
            ...(dto.notes ? { notes: dto.notes } : {}),
        });

        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.FILING_FILE,
            actorId: access.userId,
            targetType: 'TaxReturnFiling',
            targetId: id,
            metadata: {
                filingType: filing.filingType,
                referenceNumber: dto.referenceNumber,
            },
        });
        this.deps.eventBus.publish(TAX_EVENTS.FILING_FILED, {
            filingId: id,
            filingType: filing.filingType,
            referenceNumber: dto.referenceNumber,
        });
        return present(updated);
    }

    /**
     * The row-level export behind a return — every invoice in the period.
     *
     * Gated on `reports-dashboards:export:global` rather than the tax read
     * capability, because this copies customer names and addresses out of the
     * platform in bulk. Reading a return's totals and exporting the rows behind
     * it are different powers, and the catalog already separates them.
     */
    async exportInvoiceRows(query: TaxSummaryQuery, access: TaxAccess): Promise<unknown> {
        requireTaxExport(access, 'export tax return data');
        const summary = await this.indirectTaxSummary(query, access);
        const { items } = await this.deps.invoices.list({
            page: 1,
            limit: 1000,
            countryCode: query.countryCode,
            ...(query.stateCode ? { stateCode: query.stateCode } : {}),
            issuedFrom: query.periodStart,
            issuedTo: query.periodEnd,
            organizationIds: null,
            restrictToBuyerId: null,
            skip: 0,
            take: 1000,
        });

        return {
            summary,
            rows: items
                .filter((invoice) => invoice.status !== 'VOID')
                .map((invoice) => ({
                    invoiceNumber: invoice.invoiceNumber,
                    invoiceDate: invoice.invoiceDate,
                    customerName: invoice.customerName,
                    customerGstin: invoice.customerGstin,
                    placeOfSupply: invoice.stateCode,
                    hsnCode: invoice.hsnCode,
                    taxableValue: invoice.subtotal.toString(),
                    taxRate: invoice.taxRate.toString(),
                    taxAmount: invoice.taxAmount.toString(),
                    invoiceValue: invoice.totalAmount.toString(),
                })),
        };
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private async assertReachesArtist(artistId: string, access: TaxAccess): Promise<void> {
        if (access.scope === TaxScope.GLOBAL) return;
        if (access.scope === TaxScope.BUYER) {
            throw AppError.forbidden(
                'Tax filings are not part of the buyer surface.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
        const owned = await this.deps.artists.findArtistIdsForUser(access.userId);
        if (!owned.includes(artistId)) {
            throw AppError.forbidden(
                'You may only read tax filings for your own artist record.',
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
    }

    private async requireInScope(id: string, access: TaxAccess): Promise<TaxReturnFiling> {
        const filing = await this.deps.filings.findById(id);
        if (!filing) {
            throw AppError.notFound('Tax filing not found.', TAX_ERROR_CODES.NOT_FOUND);
        }
        if (access.scope === TaxScope.GLOBAL) return filing;

        if (!filing.artistId) {
            // A platform return. Not an artist's to read, whatever their grant.
            throw AppError.forbidden(
                "This is HitBox's own tax return, not an artist statement.",
                TAX_ERROR_CODES.FORBIDDEN,
            );
        }
        await this.assertReachesArtist(filing.artistId, access);
        return filing;
    }
}

function present(filing: TaxReturnFiling): unknown {
    return {
        id: filing.id,
        filingType: filing.filingType,
        countryCode: filing.countryCode,
        stateCode: filing.stateCode,
        period: { start: filing.periodStart, end: filing.periodEnd },
        currency: filing.currency,
        totalTaxableAmount: filing.totalTaxableAmount?.toString() ?? null,
        totalTaxCollected: filing.totalTaxCollected?.toString() ?? null,
        totalTaxDue: filing.totalTaxDue?.toString() ?? null,
        inputTaxCredit: filing.inputTaxCredit?.toString() ?? null,
        artistId: filing.artistId,
        payoutId: filing.payoutId,
        status: filing.status,
        dueDate: filing.dueDate,
        filedAt: filing.filedAt,
        referenceNumber: filing.referenceNumber,
        documentAvailable: filing.documentStorageRef !== null,
        notes: filing.notes,
        createdAt: filing.createdAt,
    };
}

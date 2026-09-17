import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import { TAX_AUDIT_EVENTS, TAX_ERROR_CODES } from '../constants/tax.constant';
import type { TaxAccess } from '../domain/tax-access';
import { requireTaxManage } from '../domain/tax-access';
import type { ITaxAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import { recordTaxAudit } from '../domain/interfaces/audit-recorder.port';
import type { TaxConfigurationRepository } from '../repository/tax-configuration.repository';
import type {
    CloseTaxConfigurationDto,
    CreateTaxConfigurationDto,
    ListTaxConfigurationsQuery,
} from '../dto/tax.dto';

export interface TaxConfigurationServiceDeps {
    configurations: TaxConfigurationRepository;
    audit: ITaxAuditRecorder;
    logger: Logger;
}

/**
 * The rate table.
 *
 * Every write here changes what customers are charged, so all of them are
 * global-only and audited. There is no update and no delete: a rate is
 * versioned by its effective window, and the only mutation is closing one so a
 * successor takes over. That is what makes re-deriving a two-year-old invoice
 * produce the figure that was actually on it.
 */
export class TaxConfigurationService {
    constructor(private readonly deps: TaxConfigurationServiceDeps) { }

    async list(
        query: ListTaxConfigurationsQuery,
        _access: TaxAccess,
    ): Promise<{ data: unknown[]; meta: { page: number; limit: number; total: number } }> {
        const { total, items } = await this.deps.configurations.list({
            ...query,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            data: items.map(present),
            meta: { page: query.page, limit: query.limit, total },
        };
    }

    async getById(id: string): Promise<unknown> {
        return present(await this.require(id));
    }

    async create(dto: CreateTaxConfigurationDto, access: TaxAccess): Promise<unknown> {
        requireTaxManage(access, 'configure tax rates');

        // An overlapping row for the same target would make rate resolution
        // depend on which one the tie-break happened to pick — for a figure
        // that goes on a government filing, "probably right" is not good
        // enough.
        const overlapping = await this.deps.configurations.findCandidates({
            productId: dto.productId ?? '00000000-0000-0000-0000-000000000000',
            countryCode: dto.countryCode,
            stateCode: dto.stateCode ?? null,
        });
        const clash = overlapping.find(
            (row) =>
                row.productId === (dto.productId ?? null) &&
                row.stateCode === (dto.stateCode ?? null) &&
                (row.effectiveTo === null || row.effectiveTo > dto.effectiveFrom) &&
                (!dto.effectiveTo || row.effectiveFrom < dto.effectiveTo),
        );
        if (clash) {
            throw AppError.conflict(
                `A rate for this target is already in force over that window ` +
                `(configuration ${clash.id}, effective from ` +
                `${clash.effectiveFrom.toISOString().slice(0, 10)}). Close it first.`,
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const created = await this.deps.configurations.create(dto, access.userId);
        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.TAX_CONFIG_CHANGE,
            actorId: access.userId,
            targetType: 'TaxConfiguration',
            targetId: created.id,
            metadata: {
                action: 'create',
                countryCode: dto.countryCode,
                stateCode: dto.stateCode ?? null,
                productId: dto.productId ?? null,
                taxType: dto.taxType,
                taxRate: dto.taxRate,
                hsnCode: dto.hsnCode ?? null,
                effectiveFrom: dto.effectiveFrom.toISOString(),
            },
        });
        return present(created);
    }

    async close(
        id: string,
        dto: CloseTaxConfigurationDto,
        access: TaxAccess,
    ): Promise<unknown> {
        requireTaxManage(access, 'close a tax rate');
        const configuration = await this.require(id);

        if (configuration.effectiveTo !== null) {
            throw AppError.conflict(
                'This rate is already closed.',
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }
        if (dto.effectiveTo <= configuration.effectiveFrom) {
            throw AppError.badRequest(
                'A rate cannot stop applying before it started.',
                TAX_ERROR_CODES.INVALID_TRANSITION,
            );
        }

        const closed = await this.deps.configurations.close(id, dto.effectiveTo);
        await recordTaxAudit(this.deps.audit, {
            eventType: TAX_AUDIT_EVENTS.TAX_CONFIG_CHANGE,
            actorId: access.userId,
            targetType: 'TaxConfiguration',
            targetId: id,
            metadata: {
                action: 'close',
                effectiveTo: dto.effectiveTo.toISOString(),
                reason: dto.reason,
            },
        });
        return present(closed);
    }

    private async require(id: string) {
        const configuration = await this.deps.configurations.findById(id);
        if (!configuration) {
            throw AppError.notFound(
                'Tax configuration not found.',
                TAX_ERROR_CODES.NOT_FOUND,
            );
        }
        return configuration;
    }
}

function present(row: {
    id: string;
    productId: string | null;
    countryCode: string;
    stateCode: string | null;
    taxType: string;
    taxRate: { toString(): string };
    hsnCode: string | null;
    sacCode: string | null;
    exemptionReason: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    status: string;
    createdAt: Date;
}): unknown {
    return {
        id: row.id,
        productId: row.productId,
        countryCode: row.countryCode,
        stateCode: row.stateCode,
        taxType: row.taxType,
        taxRate: row.taxRate.toString(),
        hsnCode: row.hsnCode,
        sacCode: row.sacCode,
        exemptionReason: row.exemptionReason,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        status: row.status,
        createdAt: row.createdAt,
    };
}

import { randomUUID } from 'node:crypto';
import type { PaymentGatewayConfig } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import {
    PAYMENTS_AUDIT_EVENTS,
    PAYMENTS_ERROR_CODES,
} from '../constants/payments.constant';
import type { IPaymentsAuditRecorder } from '../domain/interfaces/audit-recorder.port';
import type { PaymentAccess } from '../domain/payment-access';
import { requireConfigure } from '../domain/payment-access';
import type {
    CreateGatewayConfigDto,
    GatewayConfigView,
    ListGatewayConfigsQuery,
    UpdateGatewayConfigDto,
} from '../dto/payments.dto';
import type { GatewayConfigRepository } from '../repository/gateway-config.repository';

export interface GatewayConfigServiceDeps {
    configs: GatewayConfigRepository;
    audit: IPaymentsAuditRecorder;
    logger: Logger;
}

/**
 * Which provider credentials apply where.
 *
 * Every method here is CRITICAL in the audit trail, because this is the table
 * that decides where the platform's money lands. Changing a `credentialsRef`
 * is, functionally, changing the bank account — so it is System-Admin-only in
 * the role catalog, it is recorded with before/after state, and the column
 * itself is a *pointer* into the secrets manager that the DTO refuses to
 * accept an actual API key for.
 */
export class GatewayConfigService {
    constructor(private readonly deps: GatewayConfigServiceDeps) { }

    async list(
        query: ListGatewayConfigsQuery,
        access: PaymentAccess,
    ): Promise<{ page: number; limit: number; total: number; items: GatewayConfigView[] }> {
        requireConfigure(access, 'view payment gateway configuration');
        const { total, items } = await this.deps.configs.list({
            ...query,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map((row) => this.toView(row)),
        };
    }

    async create(
        dto: CreateGatewayConfigDto,
        access: PaymentAccess,
    ): Promise<GatewayConfigView> {
        requireConfigure(access, 'configure payment gateways');

        const now = new Date();
        const config = await this.deps.configs.create({
            id: randomUUID(),
            scope: dto.scope,
            organizationId: dto.organizationId ?? null,
            gateway: dto.gateway,
            isDefault: dto.isDefault,
            credentialsRef: dto.credentialsRef,
            status: dto.status,
            createdAt: now,
            updatedAt: now,
        });

        if (dto.isDefault) {
            await this.deps.configs.clearDefault({
                gateway: dto.gateway,
                scope: dto.scope,
                organizationId: dto.organizationId ?? null,
                exceptId: config.id,
            });
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.GATEWAY_CONFIGURE,
            actor: { type: 'HITBOX_ADMIN', id: access.userId },
            result: 'SUCCESS',
            organizationId: dto.organizationId ?? null,
            resource: { type: 'PaymentGatewayConfig', id: config.id },
            // The reference, never a credential — and there is nothing else on
            // this row that is a secret.
            afterState: {
                scope: dto.scope,
                gateway: dto.gateway,
                isDefault: dto.isDefault,
                credentialsRef: dto.credentialsRef,
                status: dto.status,
            },
            correlationId: randomUUID(),
        });

        this.deps.logger.info(
            { configId: config.id, scope: dto.scope, gateway: dto.gateway },
            'payment gateway configured',
        );
        return this.toView(config);
    }

    async update(
        id: string,
        dto: UpdateGatewayConfigDto,
        access: PaymentAccess,
    ): Promise<GatewayConfigView> {
        requireConfigure(access, 'configure payment gateways');

        const existing = await this.deps.configs.findById(id);
        if (!existing) {
            throw AppError.notFound(
                'Gateway configuration not found.',
                PAYMENTS_ERROR_CODES.NOT_FOUND,
            );
        }

        const updated = await this.deps.configs.update(id, {
            ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
            ...(dto.status ? { status: dto.status } : {}),
            ...(dto.credentialsRef ? { credentialsRef: dto.credentialsRef } : {}),
            updatedAt: new Date(),
        });

        if (dto.isDefault) {
            await this.deps.configs.clearDefault({
                gateway: existing.gateway,
                scope: existing.scope,
                organizationId: existing.organizationId,
                exceptId: id,
            });
        }

        await this.deps.audit.record({
            eventType: PAYMENTS_AUDIT_EVENTS.GATEWAY_CONFIGURE,
            actor: { type: 'HITBOX_ADMIN', id: access.userId },
            result: 'SUCCESS',
            organizationId: existing.organizationId,
            resource: { type: 'PaymentGatewayConfig', id },
            beforeState: {
                isDefault: existing.isDefault,
                status: existing.status,
                credentialsRef: existing.credentialsRef,
            },
            afterState: {
                isDefault: updated.isDefault,
                status: updated.status,
                credentialsRef: updated.credentialsRef,
            },
            correlationId: randomUUID(),
        });

        return this.toView(updated);
    }

    private toView(row: PaymentGatewayConfig): GatewayConfigView {
        return {
            id: row.id,
            scope: row.scope,
            organizationId: row.organizationId,
            gateway: row.gateway,
            isDefault: row.isDefault,
            credentialsRef: row.credentialsRef,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    }
}

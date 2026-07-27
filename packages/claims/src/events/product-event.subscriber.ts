import type { Logger } from 'pino';
import type { IEventBus } from '@hitbox/shared';
import type { ClaimsService } from '../service/claims.service';

// Mirrors @hitbox/products PRODUCT_EVENTS.PRODUCT_CREATED. Hardcoded to avoid a
// package dependency on products just for a string constant.
const PRODUCT_CREATED = 'products.product.created';

interface ProductCreatedPayload {
    productId: string;
    productCode: string;
}

interface Deps {
    eventBus: IEventBus;
    service: ClaimsService;
    logger: Logger;
}

/**
 * When a product is created, write its "First Time" origin ledger record (if it
 * carries an NFC tag) so the provenance chain exists before anyone claims.
 */
export function registerProductEventSubscriptions(deps: Deps): void {
    deps.eventBus.subscribe<ProductCreatedPayload>(PRODUCT_CREATED, async (payload) => {
        try {
            await deps.service.ensureOriginForProduct(payload.productId);
        } catch (err) {
            deps.logger.error({ err, productId: payload.productId }, 'failed to write origin ledger record');
        }
    });
}

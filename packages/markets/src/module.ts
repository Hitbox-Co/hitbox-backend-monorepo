import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { PrismaClient } from '@hitbox/database';
import { createModuleLogger } from '@hitbox/shared';
import {
    MARKET_READ_CAPABILITY,
    MARKET_WRITE_CAPABILITY,
    MARKETS_MODULE,
} from './constants/markets.constant';
import { MarketController } from './controller/market.controller';
import { MarketRepository } from './repository/market.repository';
import { MarketService } from './service/market.service';

/**
 * Structural guard — the shape of `requirePermission`, not an import of the
 * authorization module. Bootstrap passes the real one.
 */
export interface MarketsPermissionGuard {
    requirePermission(
        capability: string,
        options?: {
            context?: (req: Request) => unknown;
            /** Require a platform-wide grant, not an organization-scoped one. */
            globalOnly?: boolean;
        },
    ): RequestHandler;
}

export interface MarketsModuleDeps {
    prisma: PrismaClient;
    guard: MarketsPermissionGuard;
}

export interface MarketsModule {
    createRouter(requireAuth: RequestHandler): Router;
}

export function createMarketsModule(deps: MarketsModuleDeps): MarketsModule {
    const logger = createModuleLogger(MARKETS_MODULE);
    const markets = new MarketRepository(deps.prisma);
    const service = new MarketService({ markets, logger });
    const controller = new MarketController(service);

    return {
        createRouter(requireAuth) {
            const router = Router();
            router.use(requireAuth);

            // Reading is wide: any dashboard caller needs the market list to
            // label figures and populate filters.
            router.get(
                '/',
                deps.guard.requirePermission(MARKET_READ_CAPABILITY),
                controller.list,
            );
            router.get(
                '/:marketId',
                deps.guard.requirePermission(MARKET_READ_CAPABILITY),
                controller.getById,
            );

            // Writing is platform-wide only. Markets are shared configuration
            // every organization prices against, so an org-scoped holder of
            // the same capability must not reach them — `globalOnly` is what
            // makes this System-Admin-only without naming the role.
            router.post(
                '/',
                deps.guard.requirePermission(MARKET_WRITE_CAPABILITY, { globalOnly: true }),
                controller.create,
            );
            router.patch(
                '/:marketId',
                deps.guard.requirePermission(MARKET_WRITE_CAPABILITY, { globalOnly: true }),
                controller.update,
            );
            router.delete(
                '/:marketId',
                deps.guard.requirePermission(MARKET_WRITE_CAPABILITY, { globalOnly: true }),
                controller.archive,
            );

            return router;
        },
    };
}

/**
 * @hitbox/markets
 *
 * Market/currency regions and their country mappings.
 *
 * A market is the pricing region a buyer shops in: products carry one
 * `ProductPrice` per market, orders record the market they were placed in, and
 * exactly one market is the default that a buyer whose country maps nowhere
 * falls back to.
 *
 * Because every organization prices against this table, writes require a
 * **platform-wide** grant while reads do not.
 */

export { createMarketsModule } from './module';
export type {
    IMarketLookup,
    MarketsModule,
    MarketsModuleDeps,
    MarketsPermissionGuard,
} from './module';
export type { MarketRef } from './repository/market.repository';

export {
    MARKET_READ_CAPABILITY,
    MARKET_WRITE_CAPABILITY,
    MARKETS_ERROR_CODES,
    MARKETS_MODULE,
} from './constants/markets.constant';

export {
    createMarketSchema,
    listMarketsQuerySchema,
    updateMarketSchema,
} from './dto/market.dto';
export type {
    CreateMarketDto,
    ListMarketsQuery,
    MarketResponse,
    UpdateMarketDto,
} from './dto/market.dto';

export type { MarketService } from './service/market.service';

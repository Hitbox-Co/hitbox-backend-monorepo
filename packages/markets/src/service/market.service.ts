import { AppError } from '@hitbox/shared';
import type { Logger } from 'pino';
import { MARKETS_ERROR_CODES } from '../constants/markets.constant';
import type {
    CreateMarketDto,
    ListMarketsQuery,
    MarketResponse,
    UpdateMarketDto,
} from '../dto/market.dto';
import type { MarketRepository, MarketRow } from '../repository/market.repository';

export interface MarketServiceDeps {
    markets: MarketRepository;
    logger: Logger;
}

/**
 * Market administration.
 *
 * Three invariants are enforced here rather than left to the database, because
 * each has a failure mode that is silent at the schema level:
 *
 *   1. **Exactly one default.** The column is a plain boolean, so nothing stops
 *      two rows carrying it — or none. Orders resolve their market through the
 *      default when the buyer's country maps nowhere, so "no default" is an
 *      outage, not a warning.
 *   2. **A country belongs to one market.** `countryCode` is unique, so a
 *      collision would surface as a raw P2002 with no indication of which
 *      market already owns it.
 *   3. **Referenced markets are archived, never deleted.** An order must
 *      always be able to name the market it was placed in.
 */
export class MarketService {
    constructor(private readonly deps: MarketServiceDeps) { }

    async list(query: ListMarketsQuery): Promise<{
        page: number;
        limit: number;
        total: number;
        items: MarketResponse[];
    }> {
        const { total, items } = await this.deps.markets.list({
            includeArchived: query.includeArchived,
            isActive: query.isActive,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
        });
        return {
            page: query.page,
            limit: query.limit,
            total,
            items: items.map(toResponse),
        };
    }

    async getById(id: string): Promise<MarketResponse> {
        return toResponse(await this.require(id));
    }

    async create(dto: CreateMarketDto): Promise<MarketResponse> {
        const existing = await this.deps.markets.findByCode(dto.code);
        if (existing) {
            throw AppError.conflict(
                `Market code ${dto.code} is already in use.`,
                MARKETS_ERROR_CODES.CODE_TAKEN,
            );
        }
        await this.assertCountriesFree(dto.countryCodes);

        const market = await this.deps.markets.create(dto);
        this.deps.logger.info(
            { marketId: market.id, code: market.code, isDefault: market.isDefault },
            'market created',
        );
        return toResponse(market);
    }

    async update(id: string, dto: UpdateMarketDto): Promise<MarketResponse> {
        const current = await this.require(id);

        if (dto.countryCodes !== undefined) {
            await this.assertCountriesFree(dto.countryCodes, id);
        }

        // Refuse to leave the platform with no default. Promoting a different
        // market is how you move it — clearing the flag on the only one that
        // has it is not.
        if (dto.isDefault === false && current.isDefault) {
            throw AppError.badRequest(
                'Promote another market to default instead of clearing this one.',
                MARKETS_ERROR_CODES.DEFAULT_REQUIRED,
            );
        }
        // Same reasoning for deactivating: the default must stay usable.
        if (dto.isActive === false && current.isDefault) {
            throw AppError.badRequest(
                'The default market cannot be deactivated. Promote another market first.',
                MARKETS_ERROR_CODES.DEFAULT_REQUIRED,
            );
        }

        const market = await this.deps.markets.update(id, dto);
        this.deps.logger.info({ marketId: id }, 'market updated');
        return toResponse(market);
    }

    /**
     * Soft archive.
     *
     * Refused while the market still carries prices or orders: archiving it
     * would leave `ProductPrice` rows pointing at a market no buyer can reach,
     * which reads as "this product has no price" rather than as a
     * misconfiguration. Move the prices first.
     */
    async archive(id: string): Promise<MarketResponse> {
        const current = await this.require(id);

        if (current.isDefault) {
            throw AppError.badRequest(
                'The default market cannot be archived. Promote another market first.',
                MARKETS_ERROR_CODES.DEFAULT_REQUIRED,
            );
        }
        if (current._count.dropPrices > 0) {
            throw AppError.conflict(
                `${current._count.dropPrices} product price(s) still reference this market.`,
                MARKETS_ERROR_CODES.IN_USE,
                { productPrices: current._count.dropPrices },
            );
        }

        const market = await this.deps.markets.archive(id);
        this.deps.logger.info(
            { marketId: id, orders: current._count.orders },
            'market archived',
        );
        return toResponse(market);
    }

    private async require(id: string): Promise<MarketRow> {
        const market = await this.deps.markets.findById(id);
        if (!market) {
            throw AppError.notFound('Market not found.', MARKETS_ERROR_CODES.NOT_FOUND);
        }
        return market;
    }

    /** Names the conflicting countries rather than surfacing a raw P2002. */
    private async assertCountriesFree(codes: string[], exceptMarketId?: string): Promise<void> {
        if (codes.length === 0) return;
        const taken = await this.deps.markets.findCountryOwners(codes, exceptMarketId);
        if (taken.length > 0) {
            throw AppError.conflict(
                `Already mapped to another market: ${taken.map((t) => t.countryCode).join(', ')}.`,
                MARKETS_ERROR_CODES.COUNTRY_TAKEN,
                { countryCodes: taken.map((t) => t.countryCode) },
            );
        }
    }
}

function toResponse(market: MarketRow): MarketResponse {
    return {
        id: market.id,
        code: market.code,
        name: market.name,
        currency: market.currency,
        isActive: market.isActive,
        isDefault: market.isDefault,
        countryCodes: market.marketCountrys.map((row) => row.countryCode),
        usage: {
            productPrices: market._count.dropPrices,
            orders: market._count.orders,
        },
        archivedAt: market.archivedAt?.toISOString() ?? null,
        createdAt: market.createdAt.toISOString(),
        updatedAt: market.updatedAt.toISOString(),
    };
}

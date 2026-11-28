import type { Logger } from 'pino';
import { AppError } from '@hitbox/shared';
import { COLLECTION_PROGRESS_ERROR_CODES } from '../constants/collections.constant';
import type { IDropCardCatalog } from '../domain/interfaces/drop-card-catalog.interface';
import { toProgress } from '../dto/collection-progress.dto';
import type {
    ArtistCollectionsDto,
    ArtistCollectionsQueryDto,
    CollectionDetailQueryDto,
    CollectionProgressDetailDto,
    SetDropDto,
} from '../dto/collection-progress.dto';
import type { CollectionProgressRepository } from '../repository/collection-progress.repository';

interface CollectionProgressServiceDeps {
    progress: CollectionProgressRepository;
    /** products' card adapter, injected at bootstrap. */
    dropCards: IDropCardCatalog;
    logger: Logger;
}

/**
 * "How much of this artist's collection do I own, and what is missing?" for
 * the buyer app. The set is a collection's released drops; "own" means a
 * claimed unit — the same rule the collection reward unlocks on, so this
 * screen and the reward teaser always agree.
 */
export class CollectionProgressService {
    constructor(private readonly deps: CollectionProgressServiceDeps) { }

    /** An artist's public collections, each with the viewer's progress. */
    async listForArtist(
        artistId: string,
        query: ArtistCollectionsQueryDto,
        viewerId?: string,
    ): Promise<ArtistCollectionsDto> {
        const artist = await this.deps.progress.findPublicArtist(artistId);
        if (!artist) {
            throw AppError.notFound('Artist not found.', COLLECTION_PROGRESS_ERROR_CODES.ARTIST_NOT_FOUND);
        }

        const { items, total } = await this.deps.progress.findArtistCollections(
            artist.id,
            (query.page - 1) * query.limit,
            query.limit,
        );

        const dropsByCollection = await this.deps.progress.releasedDropIds(items.map((row) => row.id));
        const owned = viewerId
            ? await this.deps.progress.ownedDropIds(viewerId, [...dropsByCollection.values()].flat())
            : null;

        return {
            artist,
            total,
            items: items.map((row) => {
                const dropIds = dropsByCollection.get(row.id) ?? [];
                return {
                    id: row.id,
                    name: row.name,
                    slug: row.slug,
                    description: row.description,
                    heroImageUrl: row.heroImageUrl,
                    totalDrops: dropIds.length,
                    progress: owned
                        ? toProgress(dropIds.filter((id) => owned.has(id)).length, dropIds.length)
                        : null,
                };
            }),
        };
    }

    /** One collection: every released drop as a card, flagged owned or missing. */
    async getDetail(
        collectionId: string,
        query: CollectionDetailQueryDto,
        viewerId?: string,
    ): Promise<CollectionProgressDetailDto> {
        const collection = await this.deps.progress.findPublicCollection(collectionId);
        if (!collection) {
            throw AppError.notFound(
                'Collection not found.',
                COLLECTION_PROGRESS_ERROR_CODES.COLLECTION_NOT_FOUND,
            );
        }

        const dropIds = (await this.deps.progress.releasedDropIds([collection.id])).get(collection.id) ?? [];
        const [cards, owned] = await Promise.all([
            this.deps.dropCards.findCards(dropIds, query.marketId),
            viewerId ? this.deps.progress.ownedDropIds(viewerId, dropIds) : Promise.resolve(null),
        ]);

        // Release order, not the lookup's arbitrary one. A drop with no card is skipped.
        const byId = new Map(cards.map((card) => [card.id, card]));
        const drops: SetDropDto[] = [];
        for (const id of dropIds) {
            const card = byId.get(id);
            if (!card) continue;
            const isOwned = owned ? owned.has(id) : null;
            if (query.show === 'owned' && isOwned !== true) continue;
            if (query.show === 'missing' && isOwned !== false) continue;
            drops.push({ ...card, owned: isOwned });
        }

        this.deps.logger.debug({ collectionId, show: query.show, signedIn: Boolean(viewerId) }, 'collections.progress.read');

        const { id, name, slug, description, heroImageUrl, artist } = collection;
        return {
            collection: { id, name, slug, description, heroImageUrl, artist },
            progress: owned ? toProgress(dropIds.filter((d) => owned.has(d)).length, dropIds.length) : null,
            drops,
        };
    }
}

import { describe, expect, it, jest } from '@jest/globals';
import { CollectionService } from '../src/service/collection.service';

/** GET /collections/user/:userId — a PRIVATE profile hides the whole shelf. */

function build(owner: { id: string; profileVisibility: string } | null) {
    const collections = {
        findOwner: jest.fn(async () => owner),
        findManyByUser: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const service = new CollectionService({ collections, artistStats: {}, mediaUrls: undefined, logger: {} } as never);
    return { service, collections };
}
const query = { page: 1, limit: 20 } as never;

describe('someone else’s shelf', () => {
    it('a PUBLIC profile shows only its PUBLIC items', async () => {
        const { service, collections } = build({ id: 'u2', profileVisibility: 'PUBLIC' });
        await service.listPublicByUser('u2', query, 'u1');
        expect(collections.findManyByUser).toHaveBeenCalledWith('u2', query, { publicOnly: true });
    });

    it('a PRIVATE profile is a 403 COLLECTIONS_PROFILE_PRIVATE, for guests and other users', async () => {
        const { service, collections } = build({ id: 'u2', profileVisibility: 'PRIVATE' });
        await expect(service.listPublicByUser('u2', query, null)).rejects.toMatchObject({ statusCode: 403, code: 'COLLECTIONS_PROFILE_PRIVATE' });
        await expect(service.listPublicByUser('u2', query, 'u1')).rejects.toMatchObject({ statusCode: 403 });
        expect(collections.findManyByUser).not.toHaveBeenCalled();
    });

    it('the owner sees their whole shelf, private profile or not', async () => {
        const { service, collections } = build({ id: 'u2', profileVisibility: 'PRIVATE' });
        await service.listPublicByUser('u2', query, 'u2');
        expect(collections.findManyByUser).toHaveBeenCalledWith('u2', query);
    });

    it('an unknown or deactivated collector is a 404', async () => {
        await expect(build(null).service.listPublicByUser('u9', query, null)).rejects.toMatchObject({ statusCode: 404, code: 'COLLECTIONS_USER_NOT_FOUND' });
    });
});

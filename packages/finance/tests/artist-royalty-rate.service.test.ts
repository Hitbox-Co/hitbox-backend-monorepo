import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { ArtistRoyaltyRateService } from '../src/service/artist-royalty-rate.service';
import { setArtistRoyaltyRateSchema } from '../src/dto/cogs-royalty-payout.dto';
import {
    accessFor,
    ADMIN_PERMISSIONS,
    makeAudit,
    makeBus,
    silentLogger,
} from './cogs-royalty-payout.helpers';

type Rule = Record<string, unknown>;

function setup(opts: { artistExists?: boolean; existing?: Rule[] } = {}) {
    const rules: Rule[] = [...(opts.existing ?? [])];
    const repo = {
        list: jest.fn(async (q: { artistId?: string; activeAt?: Date }) => ({
            total: rules.length,
            items: rules.filter(
                (r) =>
                    (!q.artistId || r.artistId === q.artistId) &&
                    (!q.activeAt ||
                        ((r.effectiveFrom as Date) <= q.activeAt &&
                            (r.effectiveTo === null || (r.effectiveTo as Date) > q.activeAt))),
            ),
        })),
        create: jest.fn(async (data: Rule) => {
            rules.push(data);
            return data as never;
        }),
    };
    const audit = makeAudit();
    const service = new ArtistRoyaltyRateService({
        prisma: {
            artist: { count: jest.fn(async () => (opts.artistExists ?? true ? 1 : 0)) },
        } as never,
        rules: repo as never,
        eventBus: makeBus(),
        audit,
        logger: silentLogger,
    });
    return { service, rules, repo, audit };
}

const admin = accessFor(ADMIN_PERMISSIONS);

describe('ArtistRoyaltyRateService.set', () => {
    it('writes an artist-only, NET_PROFIT rule into RoyaltyRule.percentage', async () => {
        const { service, rules, audit } = setup();
        const view = await service.set('artist-1', { percentage: '12.5' }, admin, 'admin-1');

        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({
            artistId: 'artist-1',
            collectionId: null,
            productId: null,
            organizationId: null,
            basis: 'NET_PROFIT',
            effectiveTo: null,
        });
        expect((rules[0]!.percentage as Prisma.Decimal).toString()).toBe('12.5');
        expect(view).toMatchObject({ artistId: 'artist-1', basis: 'NET_PROFIT', isInForce: true });
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'royalty.rule.change' }),
        );
    });

    it('needs payment-royalty:update — manage alone cannot set a rate', async () => {
        const { service, rules } = setup();
        const manageOnly = accessFor(['payment-royalty:read:global', 'payment-royalty:manage:global']);
        await expect(
            service.set('artist-1', { percentage: '10' }, manageOnly, 'u'),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(rules).toHaveLength(0);
    });

    it('404s for an unknown artist', async () => {
        const { service } = setup({ artistExists: false });
        await expect(
            service.set('ghost', { percentage: '10' }, admin, 'u'),
        ).rejects.toMatchObject({ statusCode: 404, code: 'FINANCE_ARTIST_NOT_FOUND' });
    });

    it('is immutable while a rate is in force: a second one is refused', async () => {
        const { service, rules } = setup({
            existing: [
                {
                    id: 'r1',
                    artistId: 'artist-1',
                    collectionId: null,
                    productId: null,
                    organizationId: null,
                    basis: 'NET_PROFIT',
                    percentage: new Prisma.Decimal('10'),
                    effectiveFrom: new Date(Date.now() - 86_400_000),
                    effectiveTo: null,
                },
            ],
        });
        await expect(
            service.set('artist-1', { percentage: '20' }, admin, 'u'),
        ).rejects.toMatchObject({ statusCode: 409, code: 'FINANCE_RATE_OVERLAP' });
        expect(rules).toHaveLength(1);
    });

    it('allows a new rate once the old one is closed (versioned, not edited)', async () => {
        const { service, rules } = setup({
            existing: [
                {
                    id: 'r1',
                    artistId: 'artist-1',
                    collectionId: null,
                    productId: null,
                    organizationId: null,
                    basis: 'NET_PROFIT',
                    percentage: new Prisma.Decimal('10'),
                    effectiveFrom: new Date(Date.now() - 2 * 86_400_000),
                    effectiveTo: new Date(Date.now() - 86_400_000),
                },
            ],
        });
        await service.set('artist-1', { percentage: '20' }, admin, 'u');
        expect(rules).toHaveLength(2);
        expect((rules[0]!.percentage as Prisma.Decimal).toString()).toBe('10');
    });

    it('ignores a broader rule when checking for an existing artist rate', async () => {
        const { service, rules } = setup({
            existing: [
                {
                    id: 'org-rule',
                    artistId: 'artist-1',
                    organizationId: 'org-1',
                    collectionId: null,
                    productId: null,
                    basis: 'GROSS_REVENUE',
                    percentage: new Prisma.Decimal('5'),
                    effectiveFrom: new Date(Date.now() - 86_400_000),
                    effectiveTo: null,
                },
            ],
        });
        await service.set('artist-1', { percentage: '15' }, admin, 'u');
        expect(rules).toHaveLength(2);
    });
});

describe('setArtistRoyaltyRateSchema', () => {
    it('accepts only a percentage — no basis, no scope columns', () => {
        expect(setArtistRoyaltyRateSchema.safeParse({ percentage: '15' }).success).toBe(true);
        expect(
            setArtistRoyaltyRateSchema.safeParse({ percentage: '15', basis: 'GROSS_REVENUE' })
                .success,
        ).toBe(false);
        expect(
            setArtistRoyaltyRateSchema.safeParse({ percentage: '15', productId: 'x' }).success,
        ).toBe(false);
    });

    it('bounds the percentage to (0, 100]', () => {
        for (const bad of ['0', '100.1', '-5', 'abc', '']) {
            expect(setArtistRoyaltyRateSchema.safeParse({ percentage: bad }).success).toBe(false);
        }
        expect(setArtistRoyaltyRateSchema.safeParse({ percentage: '100' }).success).toBe(true);
    });
});

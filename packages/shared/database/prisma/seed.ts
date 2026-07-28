/**
 * Development seed — realistic dummy data across EVERY table so the API can
 * be tested end-to-end (discover feed, product listings, claims, ledger,
 * buyer collections).
 *
 * Run with:  pnpm db:seed          (from the repo root)
 *
 * Idempotent: wipes and re-creates catalog data on every run. Real accounts
 * are preserved — only users whose clerkUserId starts with "seed_" are touched.
 */
import { createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import type {
    MarketplaceStatus,
    ProductCategory,
    ProductGenre,
    ProductRarity,
    ProductType,
} from '@prisma/client';

const prisma = new PrismaClient();

const img = (seed: string, w = 600, h = 800) =>
    `https://picsum.photos/seed/${seed}/${w}/${h}`;
const avatar = (seed: string) =>
    `https://api.dicebear.com/9.x/adventurer/png?seed=${seed}`;

// ── source data ─────────────────────────────────────────────────────────

const USERS = [
    { clerkUserId: 'seed_user_1', email: 'liam@example.com', username: 'liam_collects', firstName: 'Liam', lastName: 'Carter' },
    { clerkUserId: 'seed_user_2', email: 'maya@example.com', username: 'maya.vinyl', firstName: 'Maya', lastName: 'Rodriguez' },
    { clerkUserId: 'seed_user_3', email: 'kenji@example.com', username: 'kenji_k', firstName: 'Kenji', lastName: 'Kato' },
    { clerkUserId: 'seed_user_4', email: 'ava@example.com', username: 'ava_hits', firstName: 'Ava', lastName: 'Novak' },
    { clerkUserId: 'seed_user_5', email: 'noah@example.com', username: 'noahbox', firstName: 'Noah', lastName: 'Mensah' },
];

const ARTISTS: Array<{
    name: string; slug: string; genre: ProductGenre; bio: string; isVerified: boolean;
    // maximumLimit = cap of collectibles the collection can hold (progress denominator).
    collections: Array<{ name: string; description: string; maximumLimit: number }>;
}> = [
        {
            name: 'Pierce The Veil', slug: 'pierce-the-veil', genre: 'MUSIC', isVerified: true,
            bio: 'San Diego post-hardcore icons. Signature series collectibles from every era.',
            collections: [
                { name: 'Signature Series', description: 'Hand-signed memorabilia from the band.', maximumLimit: 8 },
                { name: 'Misadventures Era', description: 'Collectibles from the 2016 album cycle.', maximumLimit: 10 },
            ],
        },
        {
            name: 'Blink-182', slug: 'blink-182', genre: 'MUSIC', isVerified: true,
            bio: 'Pop-punk legends. Greatest hits collectibles and tour exclusives.',
            collections: [
                { name: 'Greatest Hits', description: 'Career-spanning collectible drop.', maximumLimit: 6 },
                { name: 'Warped Tour 2026', description: 'Relive the moments. Own the legacy.', maximumLimit: 12 },
            ],
        },
        {
            name: 'Neon District', slug: 'neon-district', genre: 'GAMING', isVerified: true,
            bio: 'Esports org with limited-run digital and physical drops.',
            collections: [{ name: 'Championship 2026', description: 'Winners circle collectibles.', maximumLimit: 20 }],
        },
        {
            name: 'Sakura Nine', slug: 'sakura-nine', genre: 'ANIME', isVerified: false,
            bio: 'Indie anime studio — cel prints, figures and signed storyboards.',
            collections: [{ name: 'First Bloom', description: 'Debut season collectible line.', maximumLimit: 5 }],
        },
        {
            name: 'Court Kings', slug: 'court-kings', genre: 'SPORTS', isVerified: true,
            bio: 'Basketball memorabilia: game-worn, signed, authenticated.',
            collections: [{ name: 'Playoff Run', description: 'Game-worn and signed playoff gear.', maximumLimit: 15 }],
        },
        {
            name: 'Midnight Frames', slug: 'midnight-frames', genre: 'FILM', isVerified: false,
            bio: 'Cult cinema props and one-sheet posters.',
            collections: [{ name: 'Director’s Cut', description: 'Props and posters from the vault.', maximumLimit: 4 }],
        },
    ];

interface ProductSpec {
    code: string;                     // 8 unique + 4 group digits
    name: string;
    type: ProductType;
    category: ProductCategory;
    genre: ProductGenre;
    rarity: ProductRarity;
    status?: MarketplaceStatus;
    price: number;
    points: number;
    inventory: number;
    sold: number;
    collection?: string;              // ArtistCollection name
    tag?: string;                     // NFC tag → also creates a claim
    owner?: string;                   // username → owned + history + buyer collection
    images: number;                   // how many images to attach
    description?: string;
}

const PRODUCTS: ProductSpec[] = [
    // ── TRENDING_NOW ────────────────────────────────────────────────────
    { code: '100000010001', name: 'Pierce The Veil — Signature Series Poster', type: 'INDIVIDUAL', category: 'POSTER', genre: 'MUSIC', rarity: 'LEGENDARY', status: 'TRENDING_NOW', price: 249.99, points: 12500, inventory: 50, sold: 412, collection: 'Signature Series', tag: 'nfc-ptv-001', owner: 'liam_collects', images: 3, description: 'Hand-signed by all four members. Includes hologram certificate.' },
    { code: '100000020001', name: 'Blink-182 — Greatest Hits Vinyl (Signed)', type: 'INDIVIDUAL', category: 'AUTOGRAPH', genre: 'MUSIC', rarity: 'EPIC', status: 'TRENDING_NOW', price: 189.0, points: 9800, inventory: 120, sold: 350, collection: 'Greatest Hits', tag: 'nfc-b182-001', owner: 'maya.vinyl', images: 2 },
    { code: '100000030002', name: 'PTV Misadventures Tour Jersey', type: 'INDIVIDUAL', category: 'JERSEY', genre: 'MUSIC', rarity: 'RARE', status: 'TRENDING_NOW', price: 129.5, points: 6200, inventory: 200, sold: 298, collection: 'Misadventures Era', images: 2 },
    { code: '100000040003', name: 'Neon District Champion Card Pack', type: 'GROUP', category: 'CARD_PACK', genre: 'GAMING', rarity: 'UNCOMMON', status: 'TRENDING_NOW', price: 24.99, points: 1200, inventory: 5000, sold: 2210, collection: 'Championship 2026', images: 1 },
    { code: '100000050004', name: 'Court Kings Game-Worn Sneakers', type: 'INDIVIDUAL', category: 'ACCESSORY', genre: 'SPORTS', rarity: 'EXCLUSIVE', status: 'TRENDING_NOW', price: 1499.0, points: 45000, inventory: 1, sold: 1, collection: 'Playoff Run', tag: 'nfc-ck-001', owner: 'kenji_k', images: 3, description: 'Game 7. Authenticated chain of custody on the HitBox ledger.' },

    // ── NEW_RELEASE ─────────────────────────────────────────────────────
    { code: '200000010001', name: 'Warped Tour 2026 Commemorative Box', type: 'GROUP', category: 'GAME_BOX', genre: 'MUSIC', rarity: 'EPIC', status: 'NEW_RELEASE', price: 89.99, points: 4500, inventory: 1000, sold: 87, collection: 'Warped Tour 2026', owner: 'liam_collects', images: 2, description: 'Relive the moments. Own the legacy.' },
    { code: '200000020001', name: 'Sakura Nine — First Bloom Figure', type: 'INDIVIDUAL', category: 'FIGURE', genre: 'ANIME', rarity: 'RARE', status: 'NEW_RELEASE', price: 74.0, points: 3600, inventory: 300, sold: 45, collection: 'First Bloom', images: 3 },
    { code: '200000030002', name: 'Midnight Frames — Original One-Sheet', type: 'INDIVIDUAL', category: 'POSTER', genre: 'FILM', rarity: 'LEGENDARY', status: 'NEW_RELEASE', price: 420.0, points: 15800, inventory: 3, sold: 0, collection: 'Director’s Cut', images: 2 },
    { code: '200000040003', name: 'Blink-182 Warped Tour Trading Cards', type: 'GROUP', category: 'TRADING_CARD', genre: 'MUSIC', rarity: 'COMMON', status: 'NEW_RELEASE', price: 9.99, points: 500, inventory: 10000, sold: 132, collection: 'Warped Tour 2026', images: 1 },
    { code: '200000050004', name: 'Sakura Nine Signed Storyboard Cel', type: 'INDIVIDUAL', category: 'AUTOGRAPH', genre: 'ANIME', rarity: 'EXCLUSIVE', status: 'NEW_RELEASE', price: 999.0, points: 30000, inventory: 5, sold: 2, collection: 'First Bloom', tag: 'nfc-s9-001', owner: 'ava_hits', images: 2 },

    // ── TOP_CREATORS ────────────────────────────────────────────────────
    { code: '300000010001', name: 'PTV Acoustic Session Digital Asset', type: 'INDIVIDUAL', category: 'DIGITAL_ASSET', genre: 'MUSIC', rarity: 'RARE', status: 'TOP_CREATORS', price: 39.0, points: 2000, inventory: 500, sold: 260, collection: 'Signature Series', owner: 'liam_collects', images: 1 },
    { code: '300000020001', name: 'Court Kings Signed Playoff Ball', type: 'INDIVIDUAL', category: 'AUTOGRAPH', genre: 'SPORTS', rarity: 'EPIC', status: 'TOP_CREATORS', price: 349.0, points: 11000, inventory: 25, sold: 19, collection: 'Playoff Run', tag: 'nfc-ck-002', owner: 'noahbox', images: 2 },
    { code: '300000030002', name: 'Neon District Founders Poster', type: 'INDIVIDUAL', category: 'POSTER', genre: 'GAMING', rarity: 'UNCOMMON', status: 'TOP_CREATORS', price: 29.99, points: 1500, inventory: 800, sold: 154, collection: 'Championship 2026', images: 1 },

    // ── no section (catalog only) ───────────────────────────────────────
    { code: '400000010001', name: 'Midnight Frames Prop Replica Reel', type: 'INDIVIDUAL', category: 'OTHER', genre: 'FILM', rarity: 'RARE', price: 159.0, points: 5200, inventory: 40, sold: 12, collection: 'Director’s Cut', images: 2 },
    { code: '400000020001', name: 'HitBox Starter Card Pack', type: 'GROUP', category: 'CARD_PACK', genre: 'OTHER', rarity: 'COMMON', price: 4.99, points: 250, inventory: 50000, sold: 4100, images: 1 },
    { code: '400000030002', name: 'Sakura Nine Art Book (First Print)', type: 'INDIVIDUAL', category: 'BOOK', genre: 'ANIME', rarity: 'UNCOMMON', price: 45.0, points: 1800, inventory: 600, sold: 77, collection: 'First Bloom', images: 2 },
];

// ── seeding ─────────────────────────────────────────────────────────────

async function wipe() {
    // children → parents; only seed users are removed
    await prisma.blockchainLedger.deleteMany();
    await prisma.productClaim.deleteMany();
    await prisma.buyerCollection.deleteMany();
    await prisma.productHistory.deleteMany();
    await prisma.productImage.deleteMany();
    await prisma.product.deleteMany();
    await prisma.artistCollection.deleteMany();
    await prisma.artist.deleteMany();
    await prisma.user.deleteMany({ where: { clerkUserId: { startsWith: 'seed_' } } });
}

async function main() {
    console.log('⏳ wiping previous seed data…');
    await wipe();

    console.log('👤 users…');
    const users = new Map<string, string>(); // username → id
    for (const spec of USERS) {
        const user = await prisma.user.create({
            data: { ...spec, avatarUrl: avatar(spec.username), rewardPoints: 1000 },
        });
        users.set(spec.username, user.id);
    }

    console.log('🎤 artists + collections…');
    const collections = new Map<string, { id: string; artistId: string }>(); // name → ids
    for (const spec of ARTISTS) {
        const artist = await prisma.artist.create({
            data: {
                name: spec.name,
                slug: spec.slug,
                bio: spec.bio,
                genre: spec.genre,
                isVerified: spec.isVerified,
                imageUrl: img(`artist-${spec.slug}`, 400, 400),
            },
        });
        for (const col of spec.collections) {
            const collection = await prisma.artistCollection.create({
                data: {
                    name: col.name,
                    description: col.description,
                    coverImageUrl: img(`collection-${spec.slug}-${col.name}`, 800, 450),
                    releaseDate: new Date('2026-06-01'),
                    maximumLimit: col.maximumLimit,
                    artistId: artist.id,
                },
            });
            collections.set(col.name, { id: collection.id, artistId: artist.id });
        }
    }

    console.log('📦 products (+ images, history, claims, ledger, buyer collections)…');
    let claimNo = 1;
    // Ledger hash per demo spec: SHA-256(Product ID + Tag Id + Owner Id + DateTime).
    const ledgerHash = (productCode: string, tag: string | null, ownerId: string, dt: Date): string =>
        createHash('sha256').update([productCode, tag ?? '', ownerId, dt.toISOString()].join('+')).digest('hex');
    for (const spec of PRODUCTS) {
        const collection = spec.collection ? collections.get(spec.collection) : undefined;
        const ownerId = spec.owner ? users.get(spec.owner) : undefined;
        const claimed = Boolean(spec.tag && ownerId);
        const claimedAt = new Date('2026-07-01T12:00:00Z');

        const product = await prisma.product.create({
            data: {
                productCode: spec.code,
                name: spec.name,
                type: spec.type,
                category: spec.category,
                genre: spec.genre,
                rarity: spec.rarity,
                marketplaceStatus: spec.status ?? null,
                description: spec.description ?? `${spec.name} — official HitBox collectible.`,
                priceInDollars: new Prisma.Decimal(spec.price),
                rewardPoints: spec.points,
                inventoryUnit: spec.inventory,
                unitsSold: spec.sold,
                releaseDate: new Date('2026-06-15'),
                collectionId: collection?.id,
                ownerId: ownerId ?? null,
                tagId: spec.tag ?? null,
                claimedStatus: claimed ? 'CLAIMED' : 'UNCLAIMED',
                claimedAt: claimed ? claimedAt : null,
                images: {
                    create: Array.from({ length: spec.images }, (_, i) => ({
                        url: img(`product-${spec.code}-${i + 1}`),
                        title: i === 0 ? 'cover' : `angle ${i + 1}`,
                    })),
                },
            },
        });

        if (ownerId) {
            await prisma.productHistory.create({
                data: {
                    productId: product.id,
                    ownerId,
                    price: new Prisma.Decimal(spec.price),
                    ownershipStartDate: claimedAt,
                },
            });
            await prisma.buyerCollection.create({
                data: {
                    userId: ownerId,
                    productId: product.id,
                    genre: spec.genre,
                    visibility: 'PUBLIC',
                    totalClaimedNo: 1,
                },
            });
        }

        const originDateTime = new Date('2026-06-15T00:00:00Z');

        // "First Time" origin record (seq 0, owner = HitBox) for every tagged product.
        if (spec.tag) {
            await prisma.blockchainLedger.create({
                data: {
                    txType: 'MINT',
                    sequenceNo: 0,
                    originDateTime,
                    originOwner: 'HitBox',
                    sellerDigitalSignature: `sig_hitbox_${spec.code}`,
                    productBuyerHash: ledgerHash(spec.code, spec.tag, 'HitBox', originDateTime),
                    previousHash: null,
                    transactionDateTime: originDateTime,
                    transactionAmount: new Prisma.Decimal(0),
                    originProductId: product.id,
                },
            });
        }

        // CLAIM record (seq 1, owner = the buyer) for products a seed user owns.
        if (claimed && ownerId) {
            const claim = await prisma.productClaim.create({
                data: {
                    claimCode: `HBPC${String(claimNo).padStart(6, '0')}`,
                    claimedNo: claimNo,
                    claimedAt,
                    userId: ownerId,
                    productId: product.id,
                    artistId: collection?.artistId,
                    collectionId: collection?.id,
                },
            });
            await prisma.blockchainLedger.create({
                data: {
                    txType: 'CLAIM',
                    sequenceNo: 1,
                    originDateTime,
                    originOwner: 'HitBox',
                    sellerDigitalSignature: `sig_hitbox_${spec.code}`,
                    buyerDigitalSignature: `sig_buyer_${claimNo}`,
                    receiverPublicKey: `pk_${claimNo}`,
                    productBuyerHash: ledgerHash(spec.code, spec.tag ?? null, spec.owner as string, claimedAt),
                    previousHash: ledgerHash(spec.code, spec.tag as string, 'HitBox', originDateTime),
                    transactionDateTime: claimedAt,
                    transactionAmount: new Prisma.Decimal(spec.price),
                    originProductId: product.id,
                    claimId: claim.id,
                    toUserId: ownerId,
                },
            });
            claimNo += 1;
        }
    }

    const counts = {
        users: await prisma.user.count(),
        artists: await prisma.artist.count(),
        collections: await prisma.artistCollection.count(),
        products: await prisma.product.count(),
        images: await prisma.productImage.count(),
        history: await prisma.productHistory.count(),
        claims: await prisma.productClaim.count(),
        ledger: await prisma.blockchainLedger.count(),
        buyerCollections: await prisma.buyerCollection.count(),
    };
    console.log('✅ seeded:', counts);
}

main()
    .catch((error) => {
        console.error('✖ seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

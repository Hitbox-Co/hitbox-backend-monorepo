/**
 * Demo data seed — populates every business table with enough realistic data
 * to exercise the admin dashboard end to end.
 *
 *   pnpm db:seed:demo
 *
 * ── What it does and does not touch ─────────────────────────────────────────
 *
 * It DELETES and re-creates every business row, so it is repeatable but
 * destructive. It never touches `Role`, `Permission` or `RolePermission` —
 * those are the authorization catalog, owned by `pnpm db:seed:authz`, and the
 * demo data references them rather than replacing them.
 *
 * ── Two things that shape every insert ──────────────────────────────────────
 *
 * 1. The schema declares no column defaults, so every id and timestamp is
 *    supplied explicitly. Nothing here relies on `now()` or `uuid()`.
 * 2. Ids are deterministic, derived from a label. Re-running produces the same
 *    ids, so a dashboard screenshot or a bug report stays valid across runs.
 *
 * Dates are spread across the last ~70 days so `period=week` and
 * `period=month` both return non-trivial trends and a real growth percentage.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
    AcquisitionMethod, ApprovalStatus, ArtistBrandLinkType, AssetType,
    AuditActionResult, AuditActorType, AuditSeverity, ClaimedStatus,
    ComplianceStatus, ConfigStatus, ContentAccessType, Currency, DropStatus,
    EvolutionThresholdType, FinanceDirection, GatewayConfigScope, IndexJobStatus,
    IndexOperation, LedgerEntryType, LedgerTxType, NotificationChannel,
    NotificationStatus, OrderStatus, OrganizationType, PaymentGateway,
    PaymentTransactionStatus, Prisma, ProductPriceStatus, RefundStatus,
    ResaleStatus, ReservationStatus, RoleScopeType, RoyaltyBasis,
    SupplyItemType, SupportCaseStatus, SupportCaseType, TagLifecycleState,
    UserRole, VendorType, VirusScanStatus, Visibility,
} from '@prisma/client';
import { prisma } from '../src/index';

// ── Deterministic ids ───────────────────────────────────────────────────────

/** A stable UUIDv4-shaped id derived from a label. */
function id(label: string): string {
    const h = createHash('sha1').update(`hitbox-demo:${label}`).digest('hex');
    return [
        h.slice(0, 8), h.slice(8, 12),
        `4${h.slice(13, 16)}`,
        ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
        h.slice(20, 32),
    ].join('-');
}

const NOW = new Date();
/** `days` ago, at a stable time of day so trend buckets are predictable. */
function daysAgo(days: number, hour = 12): Date {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - days);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
}
function dec(value: string | number): Prisma.Decimal {
    return new Prisma.Decimal(value);
}
/** Deterministic pseudo-random pick, so re-runs produce identical data. */
function pick<T>(items: readonly T[], seed: number): T {
    return items[seed % items.length]!;
}

// ── Configuration ───────────────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? 'admin@hitbox.demo';
/**
 * Identity lives in Clerk; this row is only the local projection. Pass the
 * real Clerk user id so the seeded admin matches an account that can actually
 * sign in — otherwise the row exists but no session will ever resolve to it.
 */
const ADMIN_CLERK_ID = process.env.DEMO_ADMIN_CLERK_ID ?? 'user_demo_system_admin';

const BUYER_COUNT = 40;
const PRODUCT_COUNT = 12;
const ORDER_COUNT = 60;

async function main(): Promise<void> {
    console.log('▸ clearing existing demo data');
    await clearBusinessTables();

    // ── Markets ─────────────────────────────────────────────────────────────
    const markets = [
        { key: 'us', code: 'US', name: 'United States', currency: Currency.USD, isDefault: true, countries: ['US', 'CA'] },
        { key: 'in', code: 'IN', name: 'India', currency: Currency.INR, isDefault: false, countries: ['IN'] },
        { key: 'uk', code: 'UK', name: 'United Kingdom', currency: Currency.GBP, isDefault: false, countries: ['GB', 'IE'] },
    ];
    await prisma.market.createMany({
        data: markets.map((m) => ({
            id: id(`market:${m.key}`), code: m.code, name: m.name, currency: m.currency,
            isActive: true, isDefault: m.isDefault, archivedAt: null,
            createdAt: daysAgo(120), updatedAt: daysAgo(120),
        })),
    });
    await prisma.marketCountry.createMany({
        data: markets.flatMap((m) =>
            m.countries.map((c) => ({
                id: id(`market-country:${c}`), marketId: id(`market:${m.key}`),
                countryCode: c, createdAt: daysAgo(120),
            })),
        ),
    });
    console.log(`  markets: ${markets.length}`);

    // ── Organizations ───────────────────────────────────────────────────────
    const orgs = [
        { key: 'hitbox', name: 'HitBox', slug: 'hitbox', type: OrganizationType.HITBOX },
        { key: 'ronin', name: 'Ronin Collective', slug: 'ronin-collective', type: OrganizationType.BRAND },
        { key: 'lumen', name: 'Lumen Studios', slug: 'lumen-studios', type: OrganizationType.BRAND },
        { key: 'kaze', name: 'Kaze (solo)', slug: 'kaze', type: OrganizationType.ARTIST_INDIVIDUAL },
    ];
    await prisma.organization.createMany({
        data: orgs.map((o, i) => ({
            id: id(`org:${o.key}`), name: o.name, type: o.type, slug: o.slug,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(110 - i * 5), updatedAt: daysAgo(30),
        })),
    });
    console.log(`  organizations: ${orgs.length}`);

    // ── Users ───────────────────────────────────────────────────────────────
    // One internal admin, a handful of staff/brand personas, then buyers.
    const staff = [
        { key: 'admin', email: ADMIN_EMAIL, name: 'Ayan (System Admin)', clerkId: ADMIN_CLERK_ID, role: 'HITBOX_SYSTEM_ADMIN', org: null },
        { key: 'ops', email: 'order.manager@hitbox.demo', name: 'Priya Order-Manager', clerkId: 'user_demo_order_mgr', role: 'HITBOX_ORDER_MANAGER', org: null },
        { key: 'fin', email: 'finance@hitbox.demo', name: 'Marcus Finance', clerkId: 'user_demo_finance', role: 'HITBOX_FINANCE_ADMIN', org: null },
        { key: 'support', email: 'support@hitbox.demo', name: 'Dana Support', clerkId: 'user_demo_support', role: 'HITBOX_SUPPORT', org: null },
        { key: 'drops', email: 'drops@hitbox.demo', name: 'Sam Drop-Manager', clerkId: 'user_demo_drops', role: 'HITBOX_DROP_MANAGER', org: null },
        { key: 'content', email: 'content@hitbox.demo', name: 'Iris Content', clerkId: 'user_demo_content', role: 'HITBOX_CONTENT_MANAGER', org: null },
        { key: 'eng', email: 'engineer@hitbox.demo', name: 'Theo Platform-Engineer', clerkId: 'user_demo_eng', role: 'HITBOX_PLATFORM_ENGINEER', org: null },
        { key: 'brandadmin', email: 'admin@ronin.demo', name: 'Rin Brand-Admin', clerkId: 'user_demo_brand_admin', role: 'BRAND_ADMIN', org: 'ronin' },
        { key: 'brandemp', email: 'staff@ronin.demo', name: 'Yuki Brand-Employee', clerkId: 'user_demo_brand_emp', role: 'BRAND_EMPLOYEE', org: 'ronin' },
        { key: 'artist', email: 'kaze@artists.demo', name: 'Kaze', clerkId: 'user_demo_artist', role: 'ARTIST', org: 'kaze' },
    ];

    await prisma.user.createMany({
        data: [
            ...staff.map((s, i) => ({
                id: id(`user:${s.key}`), clerkId: s.clerkId, email: s.email,
                phone: `+1555000${String(i).padStart(4, '0')}`, handle: s.key,
                fullName: s.name, bio: null, avatarUrl: null,
                role: UserRole.USER, profileVisibility: Visibility.PRIVATE,
                generalLocation: 'Remote', preferredMarketId: id('market:us'),
                isActive: true, deactivatedAt: null, archivedAt: null,
                createdAt: daysAgo(100 - i), updatedAt: daysAgo(10),
            })),
            ...Array.from({ length: BUYER_COUNT }, (_, i) => {
                // Spread signups across the window so growth maths is real.
                const created = daysAgo(Math.floor((i / BUYER_COUNT) * 70));
                const market = pick(markets, i);
                return {
                    id: id(`user:buyer:${i}`), clerkId: `user_demo_buyer_${i}`,
                    email: `buyer${i}@example.demo`, phone: null,
                    handle: `collector_${i}`, fullName: `Demo Buyer ${i}`,
                    bio: i % 5 === 0 ? 'Collecting since 2024.' : null, avatarUrl: null,
                    role: UserRole.USER,
                    profileVisibility: i % 3 === 0 ? Visibility.PUBLIC : Visibility.PRIVATE,
                    generalLocation: market.name,
                    preferredMarketId: id(`market:${market.key}`),
                    // A few inactive accounts so the active/inactive split is not 100/0.
                    isActive: i % 11 !== 0,
                    deactivatedAt: i % 11 === 0 ? daysAgo(5) : null,
                    archivedAt: null, createdAt: created, updatedAt: created,
                };
            }),
        ],
    });
    console.log(`  users: ${staff.length + BUYER_COUNT} (${staff.length} staff/brand, ${BUYER_COUNT} buyers)`);

    // ── Role assignments ────────────────────────────────────────────────────
    // This is where privilege actually comes from — User.role is a single-value
    // enum and carries none.
    const roles = await prisma.role.findMany({ select: { id: true, name: true } });
    const roleByName = new Map(roles.map((r) => [r.name, r.id]));
    if (roleByName.size === 0) {
        throw new Error('No roles found. Run `pnpm db:seed:authz` before this seed.');
    }

    await prisma.roleAssignment.createMany({
        data: staff.flatMap((s, i) => {
            const roleId = roleByName.get(s.role);
            if (!roleId) return [];
            const scopeType = s.org ? RoleScopeType.ORGANIZATION : RoleScopeType.GLOBAL;
            return [{
                id: id(`assignment:${s.key}`), userId: id(`user:${s.key}`), roleId,
                scopeType, scopeId: s.org ? id(`org:${s.org}`) : null,
                grantedById: id('user:admin'),
                grantedAt: daysAgo(99 - i), revokedAt: null,
            }];
        }),
    });
    // Every buyer holds BUYER_COLLECTOR so the admin/non-admin split is real.
    const buyerRoleId = roleByName.get('BUYER_COLLECTOR');
    if (buyerRoleId) {
        await prisma.roleAssignment.createMany({
            data: Array.from({ length: BUYER_COUNT }, (_, i) => ({
                id: id(`assignment:buyer:${i}`), userId: id(`user:buyer:${i}`),
                roleId: buyerRoleId, scopeType: RoleScopeType.OWN, scopeId: null,
                grantedById: id('user:admin'),
                grantedAt: daysAgo(Math.floor((i / BUYER_COUNT) * 70)), revokedAt: null,
            })),
        });
    }
    console.log(`  role assignments: ${staff.length + BUYER_COUNT}`);

    // ── Addresses ───────────────────────────────────────────────────────────
    await prisma.address.createMany({
        data: Array.from({ length: BUYER_COUNT }, (_, i) => ({
            id: id(`address:${i}`), userId: id(`user:buyer:${i}`),
            label: 'HOME' as const, labelCustom: null,
            recipientName: `Demo Buyer ${i}`,
            line1: `${100 + i} Market Street`, line2: i % 4 === 0 ? 'Apt 4B' : null,
            city: 'San Francisco', state: 'CA', postalCode: '94103', countryCode: 'US',
            phone: null, isDefaultShipping: true, isDefaultBilling: true,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(60), updatedAt: daysAgo(60),
        })),
    });

    // ── Artists, collections, brand links ───────────────────────────────────
    const artists = [
        { key: 'kaze', name: 'Kaze', org: 'kaze', userKey: 'artist', genre: 'Electronic' },
        { key: 'ronin', name: 'Ronin', org: 'ronin', userKey: null, genre: 'Hip-Hop' },
        { key: 'lumen', name: 'Lumen', org: 'lumen', userKey: null, genre: 'Ambient' },
    ];
    await prisma.artist.createMany({
        data: artists.map((a, i) => ({
            id: id(`artist:${a.key}`), name: a.name, slug: a.key,
            bio: `${a.name} makes ${a.genre.toLowerCase()}.`,
            avatarUrl: null, coverUrl: null, genre: a.genre, isPublic: true,
            organizationId: id(`org:${a.org}`),
            userId: a.userKey ? id(`user:${a.userKey}`) : null,
            complianceAttestedAt: daysAgo(80), complianceAttestedBy: id('user:admin'),
            isActive: true, archivedAt: null,
            createdAt: daysAgo(95 - i * 3), updatedAt: daysAgo(20),
        })),
    });
    await prisma.artistCollection.createMany({
        data: artists.map((a, i) => ({
            id: id(`collection:${a.key}`), name: `${a.name} Vol. 1`, slug: `${a.key}-vol-1`,
            description: `First series from ${a.name}.`, heroImageUrl: null, position: i,
            artistId: id(`artist:${a.key}`), organizationId: id(`org:${a.org}`),
            isPublic: true, isActive: true, archivedAt: null,
            createdAt: daysAgo(90 - i * 3), updatedAt: daysAgo(20),
        })),
    });
    await prisma.artistBrandLink.createMany({
        data: [
            { id: id('brandlink:kaze-ronin'), artistId: id('artist:kaze'), organizationId: id('org:ronin'), linkType: ArtistBrandLinkType.MERCHANDISE, startDate: daysAgo(80), endDate: null, isActive: true, createdAt: daysAgo(80) },
            { id: id('brandlink:ronin'), artistId: id('artist:ronin'), organizationId: id('org:ronin'), linkType: ArtistBrandLinkType.PRIMARY, startDate: daysAgo(88), endDate: null, isActive: true, createdAt: daysAgo(88) },
            { id: id('brandlink:lumen'), artistId: id('artist:lumen'), organizationId: id('org:lumen'), linkType: ArtistBrandLinkType.PRIMARY, startDate: daysAgo(85), endDate: null, isActive: true, createdAt: daysAgo(85) },
        ],
    });
    console.log(`  artists: ${artists.length}, collections: ${artists.length}`);

    // ── Vendors + supply ────────────────────────────────────────────────────
    await prisma.vendor.createMany({
        data: [
            { id: id('vendor:tags'), name: 'NordicTag AB', vendorType: VendorType.NFC_TAG_MANUFACTURER, contactEmail: 'sales@nordictag.demo', isActive: true, archivedAt: null, createdAt: daysAgo(100) },
            { id: id('vendor:merch'), name: 'Osaka Merch Co.', vendorType: VendorType.MERCHANDISE_MANUFACTURER, contactEmail: 'hello@osakamerch.demo', isActive: true, archivedAt: null, createdAt: daysAgo(98) },
        ],
    });
    await prisma.supplyBatch.createMany({
        data: [
            { id: id('batch:tags-1'), vendorId: id('vendor:tags'), itemType: SupplyItemType.NFC_TAG, quantity: 5000, batchRef: 'NT-2026-014', receivedAt: daysAgo(60), sourceFileRef: null, enteredById: id('user:admin'), notes: 'NTAG 424 DNA', createdAt: daysAgo(60) },
            { id: id('batch:merch-1'), vendorId: id('vendor:merch'), itemType: SupplyItemType.MERCHANDISE, quantity: 1200, batchRef: 'OM-2026-003', receivedAt: daysAgo(45), sourceFileRef: null, enteredById: id('user:drops'), notes: null, createdAt: daysAgo(45) },
        ],
    });

    // ── Products ────────────────────────────────────────────────────────────
    // Spread across the DropStatus lifecycle so the products section shows all
    // nine states rather than only ACTIVE.
    const statuses: DropStatus[] = [
        DropStatus.ACTIVE, DropStatus.ACTIVE, DropStatus.ACTIVE, DropStatus.PUBLISHED,
        DropStatus.PUBLISHED, DropStatus.DRAFT, DropStatus.SUBMITTED, DropStatus.IN_REVIEW,
        DropStatus.APPROVED, DropStatus.REJECTED, DropStatus.ENDED, DropStatus.ARCHIVED,
    ];
    const categories = ['TRADING_CARD', 'FIGURE', 'JERSEY', 'POSTER'];
    const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => {
        const artist = pick(artists, i);
        const status = statuses[i]!;
        return {
            key: `p${i}`, index: i, artist, status,
            supply: 100 + i * 50,
            live: status === DropStatus.ACTIVE || status === DropStatus.PUBLISHED,
        };
    });
    await prisma.product.createMany({
        data: products.map((p) => ({
            id: id(`product:${p.key}`), groupCode: `HB-${String(1000 + p.index)}`,
            name: `${p.artist.name} Drop #${p.index + 1}`,
            description: `Limited ${pick(categories, p.index).toLowerCase().replace('_', ' ')} from ${p.artist.name}.`,
            collectionId: id(`collection:${p.artist.key}`),
            artistId: id(`artist:${p.artist.key}`),
            organizationId: id(`org:${p.artist.org}`),
            vertical: 'music', category: pick(categories, p.index),
            rarity: pick(['COMMON', 'RARE', 'LEGENDARY'], p.index),
            purchaseLimit: 2, totalSupply: p.supply,
            releaseStart: daysAgo(50 - p.index * 2), releaseEnd: null,
            status: p.status,
            publishedAt: p.live ? daysAgo(48 - p.index * 2) : null,
            complianceStatus: p.status === DropStatus.REJECTED ? ComplianceStatus.FLAGGED : ComplianceStatus.CLEARED,
            oddsDisclosureRef: p.index % 4 === 0 ? `https://hitbox.demo/odds/${p.key}` : null,
            isAgeSpecific: p.index % 6 === 0, minimumAge: p.index % 6 === 0 ? 18 : null,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(55 - p.index * 2), updatedAt: daysAgo(10),
        })),
    });
    await prisma.productVariant.createMany({
        data: products.flatMap((p) =>
            ['S', 'M', 'L'].map((size, v) => ({
                id: id(`variant:${p.key}:${size}`), productId: id(`product:${p.key}`),
                variantCode: `HB-${1000 + p.index}-${size}`, label: `Size ${size}`,
                optionName: 'size', optionValue: size, position: v,
                totalSupply: Math.floor(p.supply / 3), isActive: true, archivedAt: null,
                createdAt: daysAgo(55 - p.index * 2), updatedAt: daysAgo(10),
            })),
        ),
    });
    await prisma.productPrice.createMany({
        data: products.flatMap((p) =>
            markets.map((m) => ({
                id: id(`price:${p.key}:${m.key}`), productId: id(`product:${p.key}`),
                variantId: null, marketId: id(`market:${m.key}`),
                amount: dec(m.currency === Currency.INR ? 2400 + p.index * 100 : 29 + p.index * 10),
                isFree: false,
                costOfGoods: dec(m.currency === Currency.INR ? 900 + p.index * 40 : 11 + p.index * 4),
                status: ProductPriceStatus.ACTIVE,
                createdAt: daysAgo(55 - p.index * 2), updatedAt: daysAgo(10),
            })),
        ),
    });
    console.log(`  products: ${PRODUCT_COUNT} (+${PRODUCT_COUNT * 3} variants, ${PRODUCT_COUNT * 3} prices)`);

    // ── Release approvals ───────────────────────────────────────────────────
    await prisma.releaseApproval.createMany({
        data: products
            .filter((p) => [DropStatus.SUBMITTED, DropStatus.IN_REVIEW, DropStatus.APPROVED, DropStatus.REJECTED].includes(p.status))
            .map((p, i) => {
                const decided = p.status === DropStatus.APPROVED || p.status === DropStatus.REJECTED;
                return {
                    id: id(`approval:${p.key}`), productId: id(`product:${p.key}`),
                    approverId: id('user:drops'),
                    status: p.status === DropStatus.REJECTED ? ApprovalStatus.REJECTED
                        : p.status === DropStatus.APPROVED ? ApprovalStatus.APPROVED
                            : ApprovalStatus.PENDING,
                    comment: p.status === DropStatus.REJECTED ? 'Odds disclosure missing.' : null,
                    version: 1, decidedAt: decided ? daysAgo(12 + i) : null,
                    complianceStatus: p.status === DropStatus.REJECTED ? ComplianceStatus.FLAGGED : ComplianceStatus.CLEARED,
                    oddsDisclosureRef: null,
                    checkedById: decided ? id('user:admin') : null,
                    checkedAt: decided ? daysAgo(12 + i) : null,
                    createdAt: daysAgo(20 + i), updatedAt: daysAgo(12 + i),
                };
            }),
    });

    // ── Media ───────────────────────────────────────────────────────────────
    await prisma.mediaAsset.createMany({
        data: [
            ...products.map((p, i) => ({
                id: id(`asset:drop:${p.key}`), assetType: AssetType.DROP_IMAGE,
                storageRef: `drop-images/products/${id(`product:${p.key}`)}/${id(`asset:drop:${p.key}`)}.jpg`,
                fileName: 'hero.jpg', mimeType: 'image/jpeg', sizeBytes: 400000 + i * 1000,
                checksum: null,
                // One PENDING and one INFECTED so the scan-status gate is visible.
                virusScanStatus: i === 0 ? VirusScanStatus.PENDING : i === 1 ? VirusScanStatus.INFECTED : VirusScanStatus.CLEAN,
                uploadedById: id('user:drops'), organizationId: id(`org:${p.artist.org}`),
                artistId: null, productId: id(`product:${p.key}`), collectionId: null,
                archivedAt: null, createdAt: daysAgo(50 - i),
            })),
            {
                id: id('asset:legal'), assetType: AssetType.LEGAL_DOCUMENT,
                storageRef: `legal-documents/organizations/${id('org:ronin')}/${id('asset:legal')}.pdf`,
                fileName: 'brand-agreement.pdf', mimeType: 'application/pdf', sizeBytes: 120000,
                checksum: null, virusScanStatus: VirusScanStatus.CLEAN,
                uploadedById: id('user:admin'), organizationId: id('org:ronin'),
                artistId: null, productId: null, collectionId: null,
                archivedAt: null, createdAt: daysAgo(70),
            },
            {
                id: id('asset:exclusive'), assetType: AssetType.EXCLUSIVE_CONTENT,
                storageRef: `exclusive-content/collections/${id('collection:kaze')}/${id('asset:exclusive')}.mp4`,
                fileName: 'behind-the-scenes.mp4', mimeType: 'video/mp4', sizeBytes: 48000000,
                checksum: null, virusScanStatus: VirusScanStatus.CLEAN,
                uploadedById: id('user:content'), organizationId: id('org:kaze'),
                artistId: id('artist:kaze'), productId: null, collectionId: id('collection:kaze'),
                archivedAt: null, createdAt: daysAgo(40),
            },
        ],
    });
    await prisma.productImage.createMany({
        data: products.map((p, i) => ({
            id: id(`image:${p.key}`), productId: id(`product:${p.key}`),
            assetId: id(`asset:drop:${p.key}`), position: 0, isPrimary: true,
            altText: `${p.artist.name} drop artwork`, archivedAt: null, createdAt: daysAgo(50 - i),
        })),
    });
    console.log(`  media assets: ${PRODUCT_COUNT + 2}`);

    // ── SKUs ────────────────────────────────────────────────────────────────
    // 20 serialized items per live product; a slice of each is claimed.
    const liveProducts = products.filter((p) => p.live);
    const skus: { key: string; productKey: string; serial: number; claimed: boolean; ownerIdx: number }[] = [];
    for (const p of liveProducts) {
        for (let s = 1; s <= 20; s += 1) {
            skus.push({
                key: `${p.key}:${s}`, productKey: p.key, serial: s,
                claimed: s <= 12, ownerIdx: (p.index * 20 + s) % BUYER_COUNT,
            });
        }
    }
    await prisma.sku.createMany({
        data: skus.map((s, i) => ({
            id: id(`sku:${s.key}`), skuCode: `SKU-${s.productKey}-${String(s.serial).padStart(4, '0')}`,
            productId: id(`product:${s.productKey}`), variantId: null, serialNumber: s.serial,
            ownerId: s.claimed ? id(`user:buyer:${s.ownerIdx}`) : null,
            claimedStatus: s.claimed ? ClaimedStatus.CLAIMED : ClaimedStatus.UNCLAIMED,
            tagId: `04${createHash('sha1').update(s.key).digest('hex').slice(0, 12).toUpperCase()}`,
            provisioningBatchId: 'NT-2026-014',
            tagLifecycleState: s.claimed ? TagLifecycleState.ACTIVE : TagLifecycleState.BOUND,
            vendorId: id('vendor:tags'),
            vendorAuthenticatedAt: daysAgo(55), claimToken: null,
            claimTokenIssuedAt: null, claimTokenUsedAt: s.claimed ? daysAgo(30) : null,
            resaleBlocked: i % 97 === 0, resaleBlockedReason: i % 97 === 0 ? 'Open support case' : null,
            lastTapCounter: s.claimed ? 3 + (i % 7) : 0,
            tamperStatus: i % 149 === 0 ? 'counter_regression' : null,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(55), updatedAt: daysAgo(20),
        })),
    });
    const claimedSkus = skus.filter((s) => s.claimed);
    console.log(`  skus: ${skus.length} (${claimedSkus.length} claimed)`);

    // ── Claims, ledger, ownership history, buyer collections ────────────────
    await prisma.productClaim.createMany({
        data: claimedSkus.map((s, i) => ({
            id: id(`claim:${s.key}`), claimCode: `CLM-${String(10000 + i)}`,
            claimedNo: 1, claimedAt: daysAgo(30 - (i % 25)),
            userId: id(`user:buyer:${s.ownerIdx}`), skuId: id(`sku:${s.key}`),
            productId: id(`product:${s.productKey}`),
            artistId: id(`artist:${products.find((p) => p.key === s.productKey)!.artist.key}`),
            collectionId: id(`collection:${products.find((p) => p.key === s.productKey)!.artist.key}`),
            revokedAt: null, revokedReason: null,
        })),
    });
    await prisma.blockchainLedger.createMany({
        data: claimedSkus.flatMap((s, i) => {
            const mintHash = createHash('sha256').update(`mint:${s.key}`).digest('hex');
            const claimHash = createHash('sha256').update(`claim:${s.key}${mintHash}`).digest('hex');
            return [
                { id: id(`ledger:${s.key}:1`), skuId: id(`sku:${s.key}`), sequenceNo: 1, previousHash: null, currentHash: mintHash, txType: LedgerTxType.MINT, sellerDigitalSignature: null, buyerDigitalSignature: null, receiverPublicKey: null, payload: { origin: 'hitbox' }, createdAt: daysAgo(55) },
                { id: id(`ledger:${s.key}:2`), skuId: id(`sku:${s.key}`), sequenceNo: 2, previousHash: mintHash, currentHash: claimHash, txType: LedgerTxType.CLAIM, sellerDigitalSignature: null, buyerDigitalSignature: null, receiverPublicKey: null, payload: { claimedBy: id(`user:buyer:${s.ownerIdx}`) }, createdAt: daysAgo(30 - (i % 25)) },
            ];
        }),
    });
    await prisma.productHistory.createMany({
        data: claimedSkus.map((s, i) => ({
            id: id(`history:${s.key}`), skuId: id(`sku:${s.key}`),
            ownerId: id(`user:buyer:${s.ownerIdx}`), acquiredVia: AcquisitionMethod.CLAIM,
            price: dec(29 + (i % 12) * 10), currency: Currency.USD,
            startedAt: daysAgo(30 - (i % 25)), endedAt: null, isCurrent: true,
        })),
    });
    await prisma.buyerCollection.createMany({
        data: claimedSkus.map((s, i) => ({
            id: id(`buyercollection:${s.key}`), userId: id(`user:buyer:${s.ownerIdx}`),
            skuId: id(`sku:${s.key}`),
            visibility: i % 4 === 0 ? Visibility.PUBLIC : Visibility.PRIVATE,
            shareToken: i % 4 === 0 ? id(`share:${s.key}`).replace(/-/g, '') : null,
            acquiredAt: daysAgo(30 - (i % 25)), archivedAt: null,
        })),
    });

    // ── Content + evolution ─────────────────────────────────────────────────
    await prisma.contentBundle.createMany({
        data: artists.map((a, i) => ({
            id: id(`bundle:${a.key}`), name: `${a.name} — Behind the Scenes`,
            description: 'Unreleased footage for holders.',
            productId: null, collectionId: id(`collection:${a.key}`),
            accessType: i === 0 ? ContentAccessType.OWNER_ONLY : ContentAccessType.EVOLUTION_GRANT,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(45 - i * 2), updatedAt: daysAgo(15),
        })),
    });
    await prisma.contentBundleItem.createMany({
        data: [{ id: id('bundleitem:kaze'), bundleId: id('bundle:kaze'), assetId: id('asset:exclusive'), position: 0 }],
    });
    await prisma.contentUnlock.createMany({
        data: claimedSkus.slice(0, 30).map((s, i) => ({
            id: id(`unlock:${s.key}`), userId: id(`user:buyer:${s.ownerIdx}`),
            bundleId: id(`bundle:${products.find((p) => p.key === s.productKey)!.artist.key}`),
            skuId: id(`sku:${s.key}`), grantedAt: daysAgo(25 - (i % 20)),
            notifiedAt: daysAgo(25 - (i % 20)), acknowledgedAt: i % 3 === 0 ? daysAgo(24) : null,
            accessExpiresAt: null, lastAccessedAt: i % 2 === 0 ? daysAgo(3) : null,
            accessCount: i % 9,
        })),
    });
    await prisma.evolutionRule.createMany({
        data: [
            { id: id('evorule:hold'), name: 'Held 30 days', collectionId: id('collection:kaze'), productId: null, thresholdType: EvolutionThresholdType.OWNED_DURATION, thresholdValue: 30, thresholdConfig: null, grantsBundleId: id('bundle:kaze'), isActive: true, archivedAt: null, createdAt: daysAgo(44) },
            { id: id('evorule:claims'), name: 'Five claims', collectionId: id('collection:ronin'), productId: null, thresholdType: EvolutionThresholdType.CLAIM_COUNT, thresholdValue: 5, thresholdConfig: { window: 'lifetime' }, grantsBundleId: id('bundle:ronin'), isActive: true, archivedAt: null, createdAt: daysAgo(43) },
        ],
    });
    await prisma.evolutionEvent.createMany({
        data: claimedSkus.slice(0, 10).map((s, i) => ({
            id: id(`evoevent:${s.key}`), ruleId: i % 2 === 0 ? id('evorule:hold') : id('evorule:claims'),
            skuId: id(`sku:${s.key}`), triggeredAt: daysAgo(8 + i),
        })),
    });

    // ── Orders ──────────────────────────────────────────────────────────────
    const orderStatuses: OrderStatus[] = [
        OrderStatus.DELIVERED, OrderStatus.DELIVERED, OrderStatus.DELIVERED,
        OrderStatus.SHIPPED, OrderStatus.PROCESSING, OrderStatus.PAID,
        OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, OrderStatus.REFUNDED,
    ];
    const orders = Array.from({ length: ORDER_COUNT }, (_, i) => {
        const product = pick(liveProducts, i);
        const market = pick(markets, i);
        const status = pick(orderStatuses, i);
        const unit = market.currency === Currency.INR ? 2400 + product.index * 100 : 29 + product.index * 10;
        return {
            key: `o${i}`, index: i, product, market, status,
            buyerIdx: i % BUYER_COUNT,
            placedAt: daysAgo(Math.floor((i / ORDER_COUNT) * 65), 9 + (i % 10)),
            unit, quantity: 1 + (i % 2),
        };
    });
    await prisma.order.createMany({
        data: orders.map((o) => ({
            id: id(`order:${o.key}`), buyerId: id(`user:buyer:${o.buyerIdx}`),
            productId: id(`product:${o.product.key}`), variantId: null,
            // A SKU is assigned once payment settles, not before.
            skuId: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED].includes(o.status)
                ? null : id(`sku:${o.product.key}:${1 + (o.index % 12)}`),
            quantity: o.quantity, organizationId: id(`org:${o.product.artist.org}`),
            marketId: id(`market:${o.market.key}`), status: o.status,
            unitPrice: dec(o.unit), amount: dec(o.unit * o.quantity),
            currency: o.market.currency, gateway: PaymentGateway.STRIPE,
            termsAcceptedAt: o.placedAt,
            shippedAt: [OrderStatus.SHIPPED, OrderStatus.DELIVERED].includes(o.status) ? daysAgo(Math.max(1, 60 - o.index)) : null,
            deliveredAt: o.status === OrderStatus.DELIVERED ? daysAgo(Math.max(1, 58 - o.index)) : null,
            trackingNote: [OrderStatus.SHIPPED, OrderStatus.DELIVERED].includes(o.status) ? `TRK${900000 + o.index}` : null,
            placedAt: o.placedAt, updatedAt: o.placedAt, archivedAt: null,
        })),
    });
    await prisma.orderAddress.createMany({
        data: orders.flatMap((o) =>
            (['SHIPPING', 'BILLING'] as const).map((usage) => ({
                id: id(`orderaddr:${o.key}:${usage}`), orderId: id(`order:${o.key}`),
                usage, sourceAddressId: id(`address:${o.buyerIdx}`),
                label: 'HOME' as const, labelCustom: null,
                recipientName: `Demo Buyer ${o.buyerIdx}`,
                line1: `${100 + o.buyerIdx} Market Street`, line2: null,
                city: 'San Francisco', state: 'CA', postalCode: '94103',
                countryCode: 'US', phone: null, createdAt: o.placedAt,
            })),
        ),
    });
    await prisma.inventoryReservation.createMany({
        data: orders
            .filter((o) => ![OrderStatus.CANCELLED].includes(o.status))
            .map((o) => ({
                id: id(`reservation:${o.key}`), orderId: id(`order:${o.key}`),
                skuId: id(`sku:${o.product.key}:${1 + (o.index % 12)}`),
                status: o.status === OrderStatus.PENDING_PAYMENT ? ReservationStatus.HELD : ReservationStatus.COMMITTED,
                expiresAt: new Date(o.placedAt.getTime() + 30 * 60 * 1000),
                createdAt: o.placedAt,
            })),
    });
    console.log(`  orders: ${ORDER_COUNT}`);

    // ── Payments, refunds, gateway config ───────────────────────────────────
    const paid = orders.filter((o) => o.status !== OrderStatus.PENDING_PAYMENT && o.status !== OrderStatus.CANCELLED);
    await prisma.paymentTransaction.createMany({
        data: orders.map((o, i) => ({
            id: id(`payment:${o.key}`), orderId: id(`order:${o.key}`),
            gateway: PaymentGateway.STRIPE, gatewayRef: `pi_demo_${o.index}`,
            status: o.status === OrderStatus.PENDING_PAYMENT ? PaymentTransactionStatus.PENDING
                : o.status === OrderStatus.CANCELLED ? PaymentTransactionStatus.FAILED
                    : PaymentTransactionStatus.SUCCEEDED,
            idempotencyKey: `idem_${id(`payment:${o.key}`)}`,
            amount: dec(o.unit * o.quantity), currency: o.market.currency,
            needsReview: i % 17 === 0,
            reviewedById: i % 17 === 0 ? id('user:fin') : null,
            reviewedAt: i % 17 === 0 ? daysAgo(4) : null,
            reviewNote: i % 17 === 0 ? 'Manual review — mismatched billing country.' : null,
            failureReason: o.status === OrderStatus.CANCELLED ? 'card_declined' : null,
            createdAt: o.placedAt, updatedAt: o.placedAt,
        })),
    });
    const refunded = orders.filter((o) => o.status === OrderStatus.REFUNDED);
    await prisma.refundRequest.createMany({
        data: [
            ...refunded.map((o, i) => ({
                id: id(`refund:${o.key}`), orderId: id(`order:${o.key}`),
                requestedById: id(`user:buyer:${o.buyerIdx}`),
                reason: 'Item arrived damaged.', status: RefundStatus.PROCESSED,
                amount: dec(o.unit * o.quantity),
                physicalReturnConfirmedAt: daysAgo(6 + i),
                approvedById: id('user:fin'), approvedAt: daysAgo(6 + i),
                gatewayRefundId: `re_demo_${o.index}`,
                createdAt: daysAgo(9 + i), updatedAt: daysAgo(5 + i),
            })),
            // A few still in the pipeline so "awaiting action" is non-zero.
            ...paid.slice(0, 4).map((o, i) => ({
                id: id(`refund:pending:${o.key}`), orderId: id(`order:${o.key}`),
                requestedById: id(`user:buyer:${o.buyerIdx}`),
                reason: 'Changed my mind.',
                status: pick([RefundStatus.REQUESTED, RefundStatus.AWAITING_RETURN, RefundStatus.APPROVED], i),
                amount: dec(o.unit), physicalReturnConfirmedAt: null,
                approvedById: null, approvedAt: null, gatewayRefundId: null,
                createdAt: daysAgo(3 + i), updatedAt: daysAgo(2 + i),
            })),
        ],
    });
    await prisma.paymentGatewayConfig.createMany({
        data: [
            { id: id('gateway:platform'), scope: GatewayConfigScope.PLATFORM, organizationId: null, gateway: PaymentGateway.STRIPE, isDefault: true, credentialsRef: 'secrets://stripe/platform', status: ConfigStatus.ACTIVE, createdAt: daysAgo(100), updatedAt: daysAgo(100) },
            { id: id('gateway:ronin'), scope: GatewayConfigScope.ORGANIZATION, organizationId: id('org:ronin'), gateway: PaymentGateway.STRIPE, isDefault: false, credentialsRef: 'secrets://stripe/ronin', status: ConfigStatus.ACTIVE, createdAt: daysAgo(80), updatedAt: daysAgo(80) },
        ],
    });
    await prisma.paymentWebhookEvent.createMany({
        data: paid.slice(0, 10).map((o, i) => ({
            id: `evt_demo_${o.index}`, provider: PaymentGateway.STRIPE,
            eventType: 'payment_intent.succeeded',
            payload: { id: `pi_demo_${o.index}`, amount: o.unit * o.quantity },
            signatureVerified: true, processedAt: o.placedAt,
            processingError: i === 9 ? 'retried once' : null, receivedAt: o.placedAt,
        })),
    });

    // ── Finance + royalties ─────────────────────────────────────────────────
    await prisma.royaltyRule.createMany({
        data: artists.map((a, i) => ({
            id: id(`royaltyrule:${a.key}`), organizationId: id(`org:${a.org}`),
            artistId: id(`artist:${a.key}`), collectionId: null, productId: null,
            basis: RoyaltyBasis.GROSS_REVENUE, splitType: 'percentage',
            splitConfig: { artist: 20, brand: 10 }, percentage: dec(20 + i),
            effectiveFrom: daysAgo(90), effectiveTo: null, createdAt: daysAgo(90),
        })),
    });
    await prisma.royaltyLedgerEntry.createMany({
        data: paid.map((o, i) => ({
            id: id(`royaltyentry:${o.key}`), orderId: id(`order:${o.key}`),
            ruleId: id(`royaltyrule:${o.product.artist.key}`),
            amount: dec((o.unit * o.quantity * 0.2).toFixed(2)), currency: o.market.currency,
            entryType: LedgerEntryType.ORIGINAL, adjustsEntryId: null,
            createdAt: o.placedAt,
        })).concat(
            // One correction, so ADJUSTMENT netting is exercised.
            paid.slice(0, 1).map((o) => ({
                id: id(`royaltyentry:adj:${o.key}`), orderId: id(`order:${o.key}`),
                ruleId: id(`royaltyrule:${o.product.artist.key}`),
                amount: dec('-5.00'), currency: o.market.currency,
                entryType: LedgerEntryType.ADJUSTMENT,
                adjustsEntryId: id(`royaltyentry:${o.key}`), createdAt: daysAgo(2),
            })),
        ),
    });
    await prisma.financeLedgerEntry.createMany({
        data: paid.map((o) => ({
            id: id(`finentry:${o.key}`), orderId: id(`order:${o.key}`),
            entryType: LedgerEntryType.ORIGINAL, direction: FinanceDirection.CREDIT,
            amount: dec(o.unit * o.quantity), currency: o.market.currency,
            costOfGoods: dec((o.unit * o.quantity * 0.4).toFixed(2)),
            gatewayFee: dec((o.unit * o.quantity * 0.029 + 0.3).toFixed(2)),
            description: `Order ${o.key}`, createdAt: o.placedAt,
        })),
    });

    // ── Notifications ───────────────────────────────────────────────────────
    await prisma.notificationTemplate.createMany({
        data: [
            { id: id('tmpl:claim'), eventType: 'claims.product.claimed', channel: NotificationChannel.EMAIL, subject: 'You claimed {{productName}}', bodyTemplate: 'Congratulations — {{productName}} #{{serial}} is now yours.', parameters: ['productName', 'serial'], isActive: true, createdAt: daysAgo(100), updatedAt: daysAgo(100) },
            { id: id('tmpl:shipped'), eventType: 'orders.order.shipped', channel: NotificationChannel.EMAIL, subject: 'Your order is on its way', bodyTemplate: 'Tracking: {{tracking}}', parameters: ['tracking'], isActive: true, createdAt: daysAgo(100), updatedAt: daysAgo(100) },
            { id: id('tmpl:unlock'), eventType: 'content.bundle.unlocked', channel: NotificationChannel.IN_APP, subject: null, bodyTemplate: 'New exclusive content unlocked.', parameters: [], isActive: true, createdAt: daysAgo(100), updatedAt: daysAgo(100) },
        ],
    });
    await prisma.notification.createMany({
        data: claimedSkus.slice(0, 25).map((s, i) => ({
            id: id(`notification:${s.key}`), userId: id(`user:buyer:${s.ownerIdx}`),
            templateId: id('tmpl:claim'), channel: NotificationChannel.EMAIL,
            payload: { productName: `Drop ${s.productKey}`, serial: s.serial },
            status: i % 8 === 0 ? NotificationStatus.FAILED : i % 3 === 0 ? NotificationStatus.READ : NotificationStatus.SENT,
            sentAt: daysAgo(20 - (i % 15)),
            readAt: i % 3 === 0 ? daysAgo(19 - (i % 15)) : null,
            failureReason: i % 8 === 0 ? 'mailbox_full' : null,
            createdAt: daysAgo(20 - (i % 15)),
        })),
    });
    await prisma.notificationPreference.createMany({
        data: Array.from({ length: BUYER_COUNT }, (_, i) => [
            { id: id(`notifpref:${i}:email`), userId: id(`user:buyer:${i}`), channel: NotificationChannel.EMAIL, enabled: i % 7 !== 0 },
            { id: id(`notifpref:${i}:inapp`), userId: id(`user:buyer:${i}`), channel: NotificationChannel.IN_APP, enabled: true },
        ]).flat(),
    });

    // ── Social ──────────────────────────────────────────────────────────────
    await prisma.follow.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
            id: id(`follow:${i}`), followerId: id(`user:buyer:${i % BUYER_COUNT}`),
            artistId: id(`artist:${pick(artists, i).key}`),
            followedOrganizationId: null, createdAt: daysAgo(40 - (i % 30)),
        })),
    });
    await prisma.wishlistItem.createMany({
        data: Array.from({ length: 35 }, (_, i) => ({
            id: id(`wishlist:${i}`), userId: id(`user:buyer:${i % BUYER_COUNT}`),
            productId: id(`product:${pick(liveProducts, i).key}`), variantId: null,
            notifyOnAvailable: i % 2 === 0,
            note: i % 6 === 0 ? 'Waiting for restock' : null,
            createdAt: daysAgo(35 - (i % 30)),
        })),
    });

    // ── Resale + search ─────────────────────────────────────────────────────
    await prisma.resaleListing.createMany({
        data: claimedSkus.slice(0, 14).map((s, i) => ({
            id: id(`resale:${s.key}`), sellerId: id(`user:buyer:${s.ownerIdx}`),
            skuId: id(`sku:${s.key}`), price: dec(59 + i * 7), currency: Currency.USD,
            status: pick([ResaleStatus.ACTIVE, ResaleStatus.ACTIVE, ResaleStatus.SOLD, ResaleStatus.CANCELLED, ResaleStatus.BLOCKED], i),
            createdAt: daysAgo(18 - (i % 15)), updatedAt: daysAgo(10),
        })),
    });
    await prisma.searchIndexJob.createMany({
        data: products.slice(0, 8).map((p, i) => ({
            id: id(`searchjob:${p.key}`), entityType: 'Product',
            entityId: id(`product:${p.key}`),
            operation: IndexOperation.UPSERT,
            status: i === 7 ? IndexJobStatus.FAILED : i === 6 ? IndexJobStatus.QUEUED : IndexJobStatus.COMPLETED,
            attempts: i === 7 ? 3 : 1,
            lastError: i === 7 ? 'index timeout' : null,
            createdAt: daysAgo(5), completedAt: i < 6 ? daysAgo(5) : null,
        })),
    });

    // ── Support ─────────────────────────────────────────────────────────────
    await prisma.supportCase.createMany({
        data: claimedSkus.slice(0, 12).map((s, i) => ({
            id: id(`case:${s.key}`), reporterId: id(`user:buyer:${s.ownerIdx}`),
            skuId: id(`sku:${s.key}`), tagId: null,
            caseType: pick([SupportCaseType.LOST, SupportCaseType.DAMAGED, SupportCaseType.STOLEN, SupportCaseType.CLONED, SupportCaseType.DISPUTE], i),
            status: pick([SupportCaseStatus.OPEN, SupportCaseStatus.INVESTIGATING, SupportCaseStatus.RESOLVED, SupportCaseStatus.REJECTED], i),
            description: 'Tag stopped responding after a firmware update.',
            resolutionNote: i % 4 === 2 ? 'Replacement tag issued.' : null,
            resolvedById: i % 4 === 2 ? id('user:support') : null,
            resolvedAt: i % 4 === 2 ? daysAgo(4) : null,
            createdAt: daysAgo(14 - (i % 12)), updatedAt: daysAgo(4),
        })),
    });

    // ── Audit ───────────────────────────────────────────────────────────────
    // AuditEventType may already be seeded by the audit module's own catalog
    // sync; only insert the ones this seed references if they are missing.
    const demoEventTypes = [
        { eventType: 'demo.order.refund.approved', persona: 'hitbox_seller_org', severity: AuditSeverity.WARNING },
        { eventType: 'demo.role.assigned', persona: 'hitbox_seller_org', severity: AuditSeverity.CRITICAL },
        { eventType: 'demo.drop.published', persona: 'hitbox_seller_org', severity: AuditSeverity.INFO },
    ];
    for (const t of demoEventTypes) {
        await prisma.auditEventType.upsert({
            where: { eventType: t.eventType },
            update: {},
            create: {
                eventType: t.eventType, personaGroup: t.persona,
                description: `Demo event: ${t.eventType}`, defaultSeverity: t.severity,
                sourceStories: ['DEMO-1'], isActive: true, createdAt: daysAgo(100),
            },
        });
    }
    for (const severity of [AuditSeverity.INFO, AuditSeverity.WARNING, AuditSeverity.CRITICAL]) {
        await prisma.auditRetentionPolicy.upsert({
            where: { severity },
            update: {},
            create: {
                severity,
                retentionDays: severity === AuditSeverity.CRITICAL ? 2555 : severity === AuditSeverity.WARNING ? 730 : 365,
                notes: `Demo retention policy for ${severity}.`,
            },
        });
    }
    await prisma.auditEvent.createMany({
        data: Array.from({ length: 40 }, (_, i) => {
            const t = pick(demoEventTypes, i);
            return {
                eventId: id(`auditevent:${i}`), occurredAt: daysAgo(25 - (i % 24), 8 + (i % 12)),
                eventType: t.eventType, actorType: AuditActorType.HITBOX_EMPLOYEE,
                actorId: id(pick(['user:admin', 'user:fin', 'user:ops', 'user:drops'], i)),
                // The role held at the time — not re-derived from today's grants.
                actorRoleSnapshot: pick(['HITBOX_SYSTEM_ADMIN', 'HITBOX_FINANCE_ADMIN', 'HITBOX_ORDER_MANAGER', 'HITBOX_DROP_MANAGER'], i),
                organizationId: i % 3 === 0 ? id('org:ronin') : null,
                resourceType: pick(['Order', 'RefundRequest', 'Product', 'RoleAssignment'], i),
                resourceId: id(`order:o${i % ORDER_COUNT}`),
                actionResult: i % 11 === 0 ? AuditActionResult.DENIED : AuditActionResult.SUCCESS,
                severity: t.severity, beforeState: null, afterState: { ok: true },
                ipAddress: `203.0.113.${i % 255}`, userAgent: 'HitBoxAdmin/1.0',
                deviceId: null, correlationId: id(`correlation:${i}`),
                ledgerReferenceId: null, metadata: { demo: true },
                insertedAt: daysAgo(25 - (i % 24), 8 + (i % 12)),
            };
        }),
    });

    // ── Platform config + auth webhook ──────────────────────────────────────
    await prisma.platformConfig.createMany({
        data: [
            { id: id('config:resale'), key: 'feature.resale.enabled', value: true, isFeatureFlag: true, description: 'Secondary market visible to buyers.', updatedById: id('user:admin'), updatedAt: daysAgo(15), createdAt: daysAgo(100) },
            { id: id('config:claimwindow'), key: 'claims.token.ttl_seconds', value: 300, isFeatureFlag: false, description: 'One-shot claim token lifetime.', updatedById: id('user:admin'), updatedAt: daysAgo(30), createdAt: daysAgo(100) },
            { id: id('config:maintenance'), key: 'feature.maintenance_banner', value: false, isFeatureFlag: true, description: 'Show the maintenance banner.', updatedById: null, updatedAt: daysAgo(60), createdAt: daysAgo(100) },
        ],
    });
    await prisma.authWebhookEvent.createMany({
        data: staff.slice(0, 5).map((s, i) => ({
            id: `msg_demo_${i}`, eventType: 'user.created',
            payload: { data: { id: s.clerkId, email_addresses: [{ email_address: s.email }] } },
            processedAt: daysAgo(100 - i), receivedAt: daysAgo(100 - i),
        })),
    });

    console.log('\n▸ done');
}

/**
 * Clears business data, leaving the authorization catalog intact.
 *
 * Ordered child-before-parent because the schema declares no `onDelete`
 * behaviour — every foreign key is `Restrict` by default, so deleting a parent
 * first simply fails.
 */
async function clearBusinessTables(): Promise<void> {
    await prisma.$transaction([
        prisma.auditEvent.deleteMany(),
        prisma.notification.deleteMany(),
        prisma.notificationPreference.deleteMany(),
        prisma.notificationTemplate.deleteMany(),
        prisma.searchIndexJob.deleteMany(),
        prisma.wishlistItem.deleteMany(),
        prisma.follow.deleteMany(),
        prisma.supportCase.deleteMany(),
        prisma.resaleListing.deleteMany(),
        prisma.evolutionEvent.deleteMany(),
        prisma.evolutionRule.deleteMany(),
        prisma.contentUnlock.deleteMany(),
        prisma.contentBundleItem.deleteMany(),
        prisma.contentBundle.deleteMany(),
        prisma.royaltyLedgerEntry.deleteMany(),
        prisma.financeLedgerEntry.deleteMany(),
        prisma.royaltyRule.deleteMany(),
        prisma.refundRequest.deleteMany(),
        prisma.paymentTransaction.deleteMany(),
        prisma.paymentWebhookEvent.deleteMany(),
        prisma.paymentGatewayConfig.deleteMany(),
        prisma.inventoryReservation.deleteMany(),
        prisma.orderAddress.deleteMany(),
        prisma.order.deleteMany(),
        prisma.buyerCollection.deleteMany(),
        prisma.productHistory.deleteMany(),
        prisma.blockchainLedger.deleteMany(),
        prisma.productClaim.deleteMany(),
        prisma.sku.deleteMany(),
        prisma.releaseApproval.deleteMany(),
        prisma.productImage.deleteMany(),
        prisma.mediaAsset.deleteMany(),
        prisma.productPrice.deleteMany(),
        prisma.productVariant.deleteMany(),
        prisma.product.deleteMany(),
        prisma.supplyBatch.deleteMany(),
        prisma.vendor.deleteMany(),
        prisma.artistBrandLink.deleteMany(),
        prisma.artistCollection.deleteMany(),
        prisma.artist.deleteMany(),
        prisma.address.deleteMany(),
        prisma.roleAssignment.deleteMany(),
        prisma.authWebhookEvent.deleteMany(),
        prisma.platformConfig.deleteMany(),
        prisma.user.deleteMany(),
        prisma.marketCountry.deleteMany(),
        prisma.market.deleteMany(),
        prisma.organization.deleteMany(),
    ]);
}

main()
    .catch((error) => {
        console.error('✖ demo seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

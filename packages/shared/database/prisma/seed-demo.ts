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
 *
 * ── Everything is connected ─────────────────────────────────────────────────
 *
 * The catalog is a fixed, named list of typed drops — T-shirts (size × color),
 * caps (color × style), keychains (no variants) and single cards — each linked
 * to its drop type, artist, organization, supply batch and release approval.
 * Every unit belongs to its drop's variant and starts with a MINT ledger row.
 * Every order is one unit of one variant, bought in the buyer's own market at
 * that market's price, and the order's status decides the unit's state:
 * delivered units are mostly claimed by that same buyer (CLAIM ledger row,
 * ownership history, collection entry); PAID orders sit in the packing queue
 * with a placeholder unit; shipped/processing ones have a scanned unit.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
    AcquisitionMethod, ApprovalAuthority, ApprovalStatus, ArtistBrandLinkType, AssetType,
    AuditActionResult, AuditActorType, AuditSeverity, ClaimedStatus,
    ComplianceStatus, ConfigStatus, ContentAccessType, Currency, DropStatus,
    EvolutionThresholdType, GatewayConfigScope, IndexJobStatus,
    IndexOperation, LedgerTxType, NotificationChannel,
    NotificationStatus, OrderStatus, OrganizationType, PaymentGateway,
    PaymentTransactionStatus, Prisma, DropPriceStatus, RefundReason, RefundStatus,
    ResaleStatus, ReservationStatus, RoleScopeType,
    SupplyItemType, SupportCaseStatus, SupportCaseType, TagLifecycleState,
    UserRole, VendorType, VirusScanStatus, Visibility,
} from '@prisma/client';
import { prisma } from '../src/index';
import { seedFinanceDemo } from './seed-finance';
import { seedDropTypes } from './seed-drop-types';

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
/** Orders in the history; the catalog itself is a fixed list (see "The catalog"). */
const ORDER_COUNT = 60;

async function main(): Promise<void> {
    // Real Clerk accounts are put back at the end — see "Real accounts survive a reseed".
    const preserved = await snapshotRealAccounts();
    console.log(`▸ keeping ${preserved.length} real account(s): ${preserved.map((p) => p.email).join(', ') || 'none'}`);

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
        { key: 'lumenadmin', email: 'admin@lumen.demo', name: 'Noa Brand-Admin (Lumen)', clerkId: 'user_demo_lumen_admin', role: 'BRAND_ADMIN', org: 'lumen' },
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
    // Each buyer lives in their preferred market, so an India order ships to
    // India and is charged in INR.
    const ADDRESS_BY_MARKET: Record<string, { street: string; city: string; state: string; postalCode: string; countryCode: string }> = {
        us: { street: 'Market Street', city: 'San Francisco', state: 'CA', postalCode: '94103', countryCode: 'US' },
        in: { street: 'MG Road', city: 'Bengaluru', state: 'KA', postalCode: '560001', countryCode: 'IN' },
        uk: { street: 'Aldersgate Street', city: 'London', state: 'Greater London', postalCode: 'EC1A 1BB', countryCode: 'GB' },
    };
    const buyerMarket = (i: number) => pick(markets, i);
    const buyerAddress = (i: number) => ADDRESS_BY_MARKET[buyerMarket(i).key]!;
    await prisma.address.createMany({
        data: Array.from({ length: BUYER_COUNT }, (_, i) => {
            const a = buyerAddress(i);
            return {
                id: id(`address:${i}`), userId: id(`user:buyer:${i}`),
                label: 'HOME' as const, labelCustom: null,
                recipientName: `Demo Buyer ${i}`,
                line1: `${100 + i} ${a.street}`, line2: i % 4 === 0 ? 'Apt 4B' : null,
                city: a.city, state: a.state, postalCode: a.postalCode, countryCode: a.countryCode,
                phone: null, isDefaultShipping: true, isDefaultBilling: true,
                isActive: true, archivedAt: null,
                createdAt: daysAgo(60), updatedAt: daysAgo(60),
            };
        }),
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
            bio: `${a.name} makes ${a.genre.toLowerCase()} music and limited physical collectibles.`,
            avatarUrl: null, coverUrl: null, genre: a.genre, isPublic: true,
            organizationId: id(`org:${a.org}`),
            userId: a.userKey ? id(`user:${a.userKey}`) : null,
            complianceAttestedAt: daysAgo(100), complianceAttestedBy: id('user:admin'),
            isActive: true, archivedAt: null,
            createdAt: daysAgo(110 - i * 3), updatedAt: daysAgo(20),
        })),
    });
    await prisma.artistCollection.createMany({
        data: artists.map((a, i) => ({
            id: id(`collection:${a.key}`), name: `${a.name} — Season One`, slug: `${a.key}-season-one`,
            description: `${a.name}'s first season of physical drops.`, heroImageUrl: null, position: i,
            artistId: id(`artist:${a.key}`), organizationId: id(`org:${a.org}`),
            isPublic: true, isActive: true, archivedAt: null,
            createdAt: daysAgo(105 - i * 3), updatedAt: daysAgo(20),
        })),
    });
    await prisma.artistBrandLink.createMany({
        data: [
            { id: id('brandlink:kaze-ronin'), artistId: id('artist:kaze'), organizationId: id('org:ronin'), linkType: ArtistBrandLinkType.MERCHANDISE, startDate: daysAgo(80), endDate: null, isActive: true, createdAt: daysAgo(80) },
            { id: id('brandlink:ronin'), artistId: id('artist:ronin'), organizationId: id('org:ronin'), linkType: ArtistBrandLinkType.PRIMARY, startDate: daysAgo(100), endDate: null, isActive: true, createdAt: daysAgo(100) },
            { id: id('brandlink:lumen'), artistId: id('artist:lumen'), organizationId: id('org:lumen'), linkType: ArtistBrandLinkType.PRIMARY, startDate: daysAgo(100), endDate: null, isActive: true, createdAt: daysAgo(100) },
        ],
    });
    console.log(`  artists: ${artists.length}, collections: ${artists.length}`);

    // ── Drop types ──────────────────────────────────────────────────────────
    // Every drop below is typed, so its variants follow the type's rules.
    await seedDropTypes();
    const typeRows = await prisma.dropType.findMany({ select: { id: true, code: true, version: true } });
    const typeByCode = new Map(typeRows.map((t) => [t.code, t]));

    // ── Vendors ─────────────────────────────────────────────────────────────
    // One vendor per kind of goods; every item ships with its NFC chip already
    // embedded, so a chip is never a separate supply line.
    const vendors = [
        { key: 'apparel', name: 'Osaka Merch Co.', type: VendorType.APPAREL, email: 'hello@osakamerch.demo' },
        { key: 'accessories', name: 'Lumen Forge Accessories', type: VendorType.KEYCHAIN, email: 'orders@lumenforge.demo' },
        { key: 'cards', name: 'Kyoto Card Works', type: VendorType.TRADING_CARD, email: 'print@kyotocards.demo' },
    ];
    await prisma.vendor.createMany({
        data: vendors.map((v, i) => ({
            id: id(`vendor:${v.key}`), name: v.name, vendorType: v.type, contactEmail: v.email,
            isActive: true, archivedAt: null, createdAt: daysAgo(115 - i),
        })),
    });

    // ── The catalog ─────────────────────────────────────────────────────────
    // Four product types, each with the variants its type defines:
    //   T-shirts  size × color      Caps  color × style
    //   Keychains no variants       Cards single card
    type TypeCode = 'T_SHIRT' | 'CAP' | 'KEYCHAIN' | 'CARD';
    interface Opt { dimension: string; dimensionLabel: string; code: string; label: string; hexCode: string | null; position: number }
    const COLORS: Record<string, { label: string; hex: string }> = {
        BLK: { label: 'Black', hex: '#1A1A1A' }, WHT: { label: 'White', hex: '#FFFFFF' },
        NVY: { label: 'Navy', hex: '#1F2A44' }, GRY: { label: 'Heather Grey', hex: '#9EA3A8' },
        RED: { label: 'Red', hex: '#C8102E' },
    };
    const STYLES: Record<string, string> = { SNAPBACK: 'Snapback', FITTED: 'Fitted', TRUCKER: 'Trucker', DAD: 'Dad Cap' };
    const size = (code: string): Opt => ({ dimension: 'size', dimensionLabel: 'Size', code, label: code, hexCode: null, position: 0 });
    const color = (code: string, position: number): Opt => ({ dimension: 'color', dimensionLabel: 'Color', code, label: COLORS[code]!.label, hexCode: COLORS[code]!.hex, position });
    const style = (code: string): Opt => ({ dimension: 'style', dimensionLabel: 'Style', code, label: STYLES[code]!, hexCode: null, position: 1 });
    const single = (): Opt => ({ dimension: 'format', dimensionLabel: 'Format', code: 'SINGLE', label: 'Single Card', hexCode: null, position: 0 });

    const teeVariants = (sizes: string[], colors: string[]) => sizes.flatMap((s) => colors.map((c) => [size(s), color(c, 1)]));
    const capVariants = (colors: string[], st: string) => colors.map((c) => [color(c, 0), style(st)]);

    /** Price per unit by type and market: [amount, costOfGoods]. */
    const PRICES: Record<TypeCode, Record<string, [number, number]>> = {
        T_SHIRT: { us: [35, 12], in: [2499, 850], uk: [29, 10] },
        CAP: { us: [30, 9], in: [1999, 650], uk: [25, 8] },
        KEYCHAIN: { us: [15, 4], in: [899, 250], uk: [12, 3] },
        CARD: { us: [25, 3], in: [1499, 200], uk: [20, 2.5] },
    };
    const VENDOR_FOR: Record<TypeCode, { vendor: string; item: SupplyItemType }> = {
        T_SHIRT: { vendor: 'apparel', item: SupplyItemType.APPAREL },
        CAP: { vendor: 'apparel', item: SupplyItemType.APPAREL },
        KEYCHAIN: { vendor: 'accessories', item: SupplyItemType.KEYCHAIN },
        CARD: { vendor: 'cards', item: SupplyItemType.TRADING_CARD },
    };
    const CATEGORY: Record<TypeCode, string> = { T_SHIRT: 'APPAREL', CAP: 'APPAREL', KEYCHAIN: 'ACCESSORY', CARD: 'TRADING_CARD' };

    interface CatalogDrop {
        key: string; name: string; description: string; type: TypeCode;
        /** null = a HitBox in-house drop. */
        artistKey: 'kaze' | 'ronin' | 'lumen' | null;
        status: DropStatus; rarity: string;
        /** Option sets; empty for a type with no variants. */
        variants: Opt[][];
        /** Units minted per variant (or in total, with no variants). 0 = not minted yet. */
        unitsPerVariant: number;
        createdDaysAgo: number;
    }
    const catalog: CatalogDrop[] = [
        // ── On sale ─────────────────────────────────────────────────────────
        { key: 'kaze-tour-tee', name: 'Kaze — Neon Nights Tour Tee', description: 'Heavyweight cotton tour tee from the Neon Nights tour. Every shirt carries its own NFC tag.', type: 'T_SHIRT', artistKey: 'kaze', status: DropStatus.ACTIVE, rarity: 'COMMON', variants: teeVariants(['S', 'M', 'L'], ['BLK', 'WHT']), unitsPerVariant: 8, createdDaysAgo: 95 },
        { key: 'ronin-snapback', name: 'Ronin Crest Snapback', description: 'Embroidered Ronin crest on a structured snapback.', type: 'CAP', artistKey: 'ronin', status: DropStatus.ACTIVE, rarity: 'COMMON', variants: capVariants(['BLK', 'NVY', 'RED'], 'SNAPBACK'), unitsPerVariant: 10, createdDaysAgo: 93 },
        { key: 'lumen-keychain', name: 'Lumen Orbit Keychain', description: 'Enamel orbit keychain with an embedded NFC chip.', type: 'KEYCHAIN', artistKey: 'lumen', status: DropStatus.ACTIVE, rarity: 'COMMON', variants: [], unitsPerVariant: 30, createdDaysAgo: 91 },
        { key: 'kaze-genesis-card', name: 'Kaze Genesis — Single Card', description: 'Foil single card, numbered edition, from Kaze\'s debut season.', type: 'CARD', artistKey: 'kaze', status: DropStatus.ACTIVE, rarity: 'RARE', variants: [[single()]], unitsPerVariant: 40, createdDaysAgo: 90 },
        { key: 'ronin-rookie-card', name: 'Ronin Rookie — Single Card', description: 'Rookie single card with holographic finish.', type: 'CARD', artistKey: 'ronin', status: DropStatus.PUBLISHED, rarity: 'LEGENDARY', variants: [[single()]], unitsPerVariant: 25, createdDaysAgo: 88 },
        { key: 'hitbox-logo-tee', name: 'HitBox Classic Logo Tee', description: 'The HitBox logo tee — in-house, no artist.', type: 'T_SHIRT', artistKey: null, status: DropStatus.ACTIVE, rarity: 'COMMON', variants: teeVariants(['M', 'L', 'XL'], ['WHT']), unitsPerVariant: 6, createdDaysAgo: 86 },
        // ── Sold through ────────────────────────────────────────────────────
        { key: 'lumen-afterglow-tee', name: 'Lumen Afterglow Tee', description: 'Limited run from the Afterglow release. The release window has closed.', type: 'T_SHIRT', artistKey: 'lumen', status: DropStatus.ENDED, rarity: 'RARE', variants: teeVariants(['S', 'M'], ['GRY']), unitsPerVariant: 4, createdDaysAgo: 100 },
        // ── In the pipeline (not minted, not on sale) ───────────────────────
        { key: 'kaze-holo-keychain', name: 'Kaze Holo Keychain', description: 'Holographic acrylic keychain. Approved, minting next.', type: 'KEYCHAIN', artistKey: 'kaze', status: DropStatus.APPROVED, rarity: 'COMMON', variants: [], unitsPerVariant: 0, createdDaysAgo: 20 },
        { key: 'ronin-street-cap', name: 'Ronin Street Fitted Cap', description: 'Fitted cap, waiting on Ronin Collective\'s sign-off.', type: 'CAP', artistKey: 'ronin', status: DropStatus.SUBMITTED, rarity: 'COMMON', variants: capVariants(['BLK', 'RED'], 'FITTED'), unitsPerVariant: 0, createdDaysAgo: 12 },
        { key: 'lumen-foil-card', name: 'Lumen Foil — Single Card', description: 'Rejected: odds disclosure missing.', type: 'CARD', artistKey: 'lumen', status: DropStatus.REJECTED, rarity: 'RARE', variants: [[single()]], unitsPerVariant: 0, createdDaysAgo: 15 },
        { key: 'kaze-winter-tee', name: 'Kaze Winter Tour Tee', description: 'Draft for the winter tour.', type: 'T_SHIRT', artistKey: 'kaze', status: DropStatus.DRAFT, rarity: 'COMMON', variants: teeVariants(['M', 'L'], ['NVY']), unitsPerVariant: 0, createdDaysAgo: 5 },
    ];

    const orgOf = (d: CatalogDrop) => (d.artistKey ? artists.find((a) => a.key === d.artistKey)!.org : 'hitbox');
    const groupCodeOf = (index: number) => `${41000000 + index}0001`;
    const dropMeta = catalog.map((d, index) => {
        const groupCode = groupCodeOf(index);
        const variants = d.variants.map((opts, v) => {
            const codes = opts.map((o) => o.code);
            return {
                key: codes.join('-'), position: v, opts,
                label: opts.map((o) => o.label).join(' / '),
                variantCode: `${groupCode}-${codes.join('-')}`,
                optionName: opts.map((o) => o.dimension).join('/'),
                optionValue: codes.join('/'),
                optionsKey: [...opts].sort((a, b) => a.dimension.localeCompare(b.dimension)).map((o) => `${o.dimension}=${o.code}`).join('|'),
            };
        });
        const minted = d.unitsPerVariant > 0;
        const totalSupply = (variants.length || 1) * (minted ? d.unitsPerVariant : 10);
        const live = d.status === DropStatus.ACTIVE || d.status === DropStatus.PUBLISHED;
        return { ...d, index, groupCode, variants, minted, totalSupply, live, org: orgOf(d) };
    });
    const variantId = (dropKey: string, variantKey: string | null) => (variantKey ? id(`variant:${dropKey}:${variantKey}`) : null);

    await prisma.drop.createMany({
        data: dropMeta.map((d) => {
            const type = typeByCode.get(d.type)!;
            return {
                id: id(`product:${d.key}`), groupCode: d.groupCode, name: d.name, description: d.description,
                collectionId: d.artistKey ? id(`collection:${d.artistKey}`) : null,
                artistId: d.artistKey ? id(`artist:${d.artistKey}`) : null,
                organizationId: id(`org:${d.org}`),
                dropTypeId: type.id, dropTypeVersion: type.version,
                vertical: d.artistKey ? 'music' : 'merch', category: CATEGORY[d.type], rarity: d.rarity,
                purchaseLimit: 2, totalSupply: d.totalSupply,
                releaseStart: d.minted ? daysAgo(75) : null,
                releaseEnd: d.status === DropStatus.ENDED ? daysAgo(30) : null,
                status: d.status,
                publishedAt: d.minted ? daysAgo(d.createdDaysAgo - 12) : null,
                complianceStatus: d.status === DropStatus.REJECTED ? ComplianceStatus.FLAGGED
                    : d.status === DropStatus.DRAFT || d.status === DropStatus.SUBMITTED ? ComplianceStatus.PENDING
                        : ComplianceStatus.CLEARED,
                oddsDisclosureRef: null,
                isAgeSpecific: false, minimumAge: null,
                isActive: true, archivedAt: null,
                createdAt: daysAgo(d.createdDaysAgo), updatedAt: daysAgo(Math.min(d.createdDaysAgo, 10)),
            };
        }),
    });
    await prisma.dropVariant.createMany({
        data: dropMeta.flatMap((d) => d.variants.map((v) => ({
            id: variantId(d.key, v.key)!, productId: id(`product:${d.key}`),
            variantCode: v.variantCode, label: v.label,
            optionName: v.optionName, optionValue: v.optionValue, optionsKey: v.optionsKey,
            position: v.position, totalSupply: d.minted ? d.unitsPerVariant : null,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(d.createdDaysAgo), updatedAt: daysAgo(Math.min(d.createdDaysAgo, 10)),
        }))),
    });
    await prisma.dropVariantOption.createMany({
        data: dropMeta.flatMap((d) => d.variants.flatMap((v) => v.opts.map((o) => ({
            id: id(`variant-option:${d.key}:${v.key}:${o.dimension}`), variantId: variantId(d.key, v.key)!,
            dimensionCode: o.dimension, dimensionLabel: o.dimensionLabel,
            valueCode: o.code, valueLabel: o.label, hexCode: o.hexCode, position: o.position,
            createdAt: daysAgo(d.createdDaysAgo),
        })))),
    });
    // A base price per market, plus one per variant — checkout prices by variant.
    await prisma.dropPrice.createMany({
        data: dropMeta.flatMap((d) => [null, ...d.variants.map((v) => v.key)].flatMap((vKey) =>
            markets.map((m) => {
                const [amount, cogs] = PRICES[d.type][m.key]!;
                return {
                    id: id(`price:${d.key}:${vKey ?? 'base'}:${m.key}`), dropId: id(`product:${d.key}`),
                    variantId: variantId(d.key, vKey), marketId: id(`market:${m.key}`),
                    amount: dec(amount), isFree: false, costOfGoods: dec(cogs),
                    status: DropPriceStatus.ACTIVE,
                    effectiveFrom: daysAgo(d.createdDaysAgo),
                    createdAt: daysAgo(d.createdDaysAgo), updatedAt: daysAgo(d.createdDaysAgo),
                };
            }))),
    });
    console.log(`  drops: ${dropMeta.length} (${dropMeta.reduce((n, d) => n + d.variants.length, 0)} variants)`);

    // ── Release approvals ───────────────────────────────────────────────────
    // Who signs off follows the owner: an individual artist approves their own
    // drop, a brand approves its artists' drops, an in-house drop auto-passes.
    const brandApprover: Record<string, string> = { ronin: 'brandadmin', lumen: 'lumenadmin' };
    const approvalFor = (d: (typeof dropMeta)[number]) => {
        if (d.org === 'hitbox') return { authority: ApprovalAuthority.NONE, artistId: null, orgId: null, decider: null };
        if (d.org === 'kaze') return { authority: ApprovalAuthority.ARTIST, artistId: id('artist:kaze'), orgId: null, decider: 'artist' };
        return { authority: ApprovalAuthority.ORGANIZATION, artistId: null, orgId: id(`org:${d.org}`), decider: brandApprover[d.org]! };
    };
    await prisma.releaseApproval.createMany({
        data: dropMeta
            .filter((d) => d.status !== DropStatus.DRAFT)
            .map((d) => {
                const a = approvalFor(d);
                const pending = d.status === DropStatus.SUBMITTED;
                const rejected = d.status === DropStatus.REJECTED;
                const submitted = daysAgo(d.createdDaysAgo - 2);
                const decided = pending ? null : daysAgo(d.createdDaysAgo - 4);
                const signed = !pending && !rejected && a.authority !== ApprovalAuthority.NONE;
                return {
                    id: id(`approval:${d.key}`), productId: id(`product:${d.key}`),
                    approverId: id('user:drops'),
                    authority: a.authority, requiredArtistId: a.artistId, requiredOrganizationId: a.orgId,
                    legalComplianceAccepted: signed,
                    legalComplianceAcceptedAt: signed ? decided : null,
                    legalComplianceVersion: signed ? 'terms-2026-03' : null,
                    status: pending ? ApprovalStatus.PENDING : rejected ? ApprovalStatus.REJECTED : ApprovalStatus.APPROVED,
                    comment: rejected ? 'Odds disclosure missing for a randomised card.'
                        : a.authority === ApprovalAuthority.NONE ? 'Auto-approved: in-house drop with no owner to ask.' : null,
                    version: 1, decidedAt: decided,
                    complianceStatus: rejected ? ComplianceStatus.FLAGGED : pending ? ComplianceStatus.PENDING : ComplianceStatus.CLEARED,
                    oddsDisclosureRef: null,
                    checkedById: decided && a.decider ? id(`user:${a.decider}`) : null,
                    checkedAt: decided && a.decider ? decided : null,
                    createdAt: submitted, updatedAt: decided ?? submitted,
                };
            }),
    });

    // ── Media ───────────────────────────────────────────────────────────────
    await prisma.mediaAsset.createMany({
        data: [
            ...dropMeta.map((d, i) => ({
                id: id(`asset:drop:${d.key}`), assetType: AssetType.DROP_IMAGE,
                storageRef: `drop-images/products/${id(`product:${d.key}`)}/${id(`asset:drop:${d.key}`)}.jpg`,
                fileName: `${d.key}.jpg`, mimeType: 'image/jpeg', sizeBytes: 400000 + i * 1000,
                checksum: null, virusScanStatus: VirusScanStatus.CLEAN,
                uploadedById: id('user:drops'), organizationId: id(`org:${d.org}`),
                artistId: null, productId: id(`product:${d.key}`), collectionId: null,
                archivedAt: null, createdAt: daysAgo(d.createdDaysAgo),
            })),
            {
                id: id('asset:legal'), assetType: AssetType.LEGAL_DOCUMENT,
                storageRef: `legal-documents/organizations/${id('org:ronin')}/${id('asset:legal')}.pdf`,
                fileName: 'brand-agreement.pdf', mimeType: 'application/pdf', sizeBytes: 120000,
                checksum: null, virusScanStatus: VirusScanStatus.CLEAN,
                uploadedById: id('user:admin'), organizationId: id('org:ronin'),
                artistId: null, productId: null, collectionId: null,
                archivedAt: null, createdAt: daysAgo(100),
            },
            {
                id: id('asset:exclusive'), assetType: AssetType.EXCLUSIVE_CONTENT,
                storageRef: `exclusive-content/collections/${id('collection:kaze')}/${id('asset:exclusive')}.mp4`,
                fileName: 'neon-nights-backstage.mp4', mimeType: 'video/mp4', sizeBytes: 48000000,
                checksum: null, virusScanStatus: VirusScanStatus.CLEAN,
                uploadedById: id('user:content'), organizationId: id('org:kaze'),
                artistId: id('artist:kaze'), productId: null, collectionId: id('collection:kaze'),
                archivedAt: null, createdAt: daysAgo(40),
            },
        ],
    });
    await prisma.dropImage.createMany({
        data: dropMeta.map((d) => ({
            id: id(`image:${d.key}`), productId: id(`product:${d.key}`),
            assetId: id(`asset:drop:${d.key}`), position: 0, isPrimary: true,
            altText: d.name, archivedAt: null, createdAt: daysAgo(d.createdDaysAgo),
        })),
    });

    // ── Supply + units ──────────────────────────────────────────────────────
    // Each minted drop has one accepted consignment from the vendor that makes
    // that kind of goods, and its units are numbered #1…#N across variants.
    interface Unit {
        key: string; dropKey: string; variantKey: string | null; serial: number;
        skuCode: string; tagId: string; createdAt: Date; batchRef: string; vendorKey: string;
        // Filled in by the order pass below.
        orderKey?: string;
        claim?: { buyerIdx: number; claimedAt: Date; claimKey: string; price: number; currency: Currency };
    }
    const units: Unit[] = [];
    const pools = new Map<string, Unit[]>();
    const supplyBatches: Prisma.SupplyBatchCreateManyInput[] = [];
    for (const d of dropMeta.filter((x) => x.minted)) {
        const vendor = VENDOR_FOR[d.type];
        const batchRef = `${vendor.vendor.slice(0, 3).toUpperCase()}-2026-${String(100 + d.index)}`;
        const mintedAt = daysAgo(d.createdDaysAgo - 10);
        supplyBatches.push({
            id: id(`batch:${d.key}`), vendorId: id(`vendor:${vendor.vendor}`), itemType: vendor.item,
            quantity: d.totalSupply, batchRef, receivedAt: daysAgo(d.createdDaysAgo - 8),
            sourceFileRef: null, enteredById: id('user:drops'), notes: `${d.name} — chips embedded at manufacture`,
            dropId: id(`product:${d.key}`), status: 'ACCEPTED',
            rowsReceived: d.totalSupply, rowsAccepted: d.totalSupply, rowsRejected: 0,
            createdAt: daysAgo(d.createdDaysAgo - 8),
        });
        let serial = 1;
        for (const v of d.variants.length ? d.variants : [null]) {
            const pool: Unit[] = [];
            for (let n = 0; n < d.unitsPerVariant; n += 1) {
                const key = `${d.key}:${serial}`;
                const unit: Unit = {
                    key, dropKey: d.key, variantKey: v?.key ?? null, serial,
                    skuCode: `${d.groupCode}-${String(serial).padStart(6, '0')}`,
                    tagId: `04${createHash('sha1').update(`tag:${key}`).digest('hex').slice(0, 12).toUpperCase()}`,
                    createdAt: mintedAt, batchRef, vendorKey: vendor.vendor,
                };
                units.push(unit);
                pool.push(unit);
                serial += 1;
            }
            pools.set(`${d.key}|${v?.key ?? ''}`, pool);
        }
    }
    await prisma.supplyBatch.createMany({ data: supplyBatches });

    // ── Orders ──────────────────────────────────────────────────────────────
    // A believable order history, oldest first. Every order is one unit of one
    // variant, bought by a buyer in their own market at that market's price,
    // and its lifecycle decides what happened to the unit:
    //
    //   delivered   → most were claimed by the buyer (tap on the tag)
    //   refunded    → delivered, returned, never claimed
    //   shipped / processing → the unit was scanned at packing (unitAssignedAt)
    //   paid        → waiting in the packing queue: placeholder unit, not scanned
    //   pending     → a live checkout hold
    //   cancelled   → payment failed, hold released, unit back in stock
    const sellable = dropMeta.filter((d) => d.minted);
    const turn = new Map<string, number>();
    const usedUnits = new Set<string>();
    const takeUnit = (d: (typeof dropMeta)[number], consume: boolean): Unit | null => {
        const variantKeys = d.variants.length ? d.variants.map((v) => v.key) : [''];
        const start = turn.get(d.key) ?? 0;
        turn.set(d.key, start + 1);
        for (let k = 0; k < variantKeys.length; k += 1) {
            const pool = pools.get(`${d.key}|${variantKeys[(start + k) % variantKeys.length]}`)!;
            const unit = pool.find((u) => !usedUnits.has(u.key));
            if (unit) {
                if (consume) usedUnits.add(unit.key);
                return unit;
            }
        }
        return null;
    };
    const statusFor = (i: number): OrderStatus => {
        if (i < 40) return i % 9 === 4 ? OrderStatus.REFUNDED : i % 11 === 7 ? OrderStatus.CANCELLED : OrderStatus.DELIVERED;
        if (i < 47) return i === 44 ? OrderStatus.CANCELLED : OrderStatus.SHIPPED;
        if (i < 51) return OrderStatus.PROCESSING;
        if (i < 57) return OrderStatus.PAID;
        return OrderStatus.PENDING_PAYMENT;
    };
    const placedAtFor = (i: number): Date => {
        if (i < 40) return daysAgo(64 - i, 9 + (i % 10));          // 64 … 25 days ago
        if (i < 47) return daysAgo(10 - (i - 40), 10 + (i % 6));   // 10 … 4 days ago
        if (i < 51) return daysAgo(3 - Math.floor((i - 47) / 2), 11); // 3 … 2 days ago
        if (i < 57) return new Date(NOW.getTime() - (57 - i) * 3 * 3600_000); // last ~18 h
        return new Date(NOW.getTime() - (ORDER_COUNT - i) * 4 * 60_000); // minutes ago
    };
    const hours = (from: Date, h: number) => new Date(Math.min(from.getTime() + h * 3600_000, NOW.getTime() - 60_000));

    interface DemoOrder {
        key: string; index: number; drop: (typeof dropMeta)[number]; unit: Unit; variantKey: string | null;
        buyerIdx: number; market: (typeof markets)[number]; status: OrderStatus;
        placedAt: Date; paidAt: Date | null; assignedAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null;
        unitPrice: number; holdsUnit: boolean;
    }
    const orders: DemoOrder[] = [];
    let claimNo = 0;
    for (let i = 0; i < ORDER_COUNT; i += 1) {
        const status = statusFor(i);
        const placedAt = placedAtFor(i);
        // Rotate across drops; the sold-out drop only sold in its window.
        let drop: (typeof dropMeta)[number] | null = null;
        let unit: Unit | null = null;
        for (let k = 0; k < sellable.length && !unit; k += 1) {
            const candidate = sellable[(i + k) % sellable.length]!;
            if (candidate.status === DropStatus.ENDED && placedAt > daysAgo(30)) continue;
            unit = takeUnit(candidate, status !== OrderStatus.CANCELLED);
            if (unit) drop = candidate;
        }
        if (!drop || !unit) continue;

        const buyerIdx = (i * 7 + 3) % BUYER_COUNT;
        const market = buyerMarket(buyerIdx);
        const paid = status !== OrderStatus.PENDING_PAYMENT && status !== OrderStatus.CANCELLED;
        const assigned = paid && status !== OrderStatus.PAID;
        const shipped = status === OrderStatus.SHIPPED || status === OrderStatus.DELIVERED || status === OrderStatus.REFUNDED;
        const delivered = status === OrderStatus.DELIVERED || status === OrderStatus.REFUNDED;
        const order: DemoOrder = {
            key: `o${i}`, index: i, drop, unit, variantKey: unit.variantKey, buyerIdx, market, status, placedAt,
            paidAt: paid ? hours(placedAt, 0.05) : null,
            assignedAt: assigned ? hours(placedAt, 20) : null,
            shippedAt: shipped ? hours(placedAt, 44) : null,
            deliveredAt: delivered ? hours(placedAt, 120) : null,
            unitPrice: PRICES[drop.type][market.key]![0],
            holdsUnit: status !== OrderStatus.CANCELLED,
        };
        if (status !== OrderStatus.CANCELLED) unit.orderKey = order.key;
        // Three in four delivered items get tapped and claimed a day later.
        if (status === OrderStatus.DELIVERED && i % 4 !== 3) {
            unit.claim = {
                buyerIdx, claimedAt: hours(order.deliveredAt!, 24), claimKey: `HBPC${String(100001 + claimNo++)}`,
                price: order.unitPrice, currency: market.currency,
            };
        }
        orders.push(order);
    }

    // Units, now that the order pass decided each one's fate.
    await prisma.sku.createMany({
        data: units.map((u) => {
            const claimed = Boolean(u.claim);
            return {
                id: id(`sku:${u.key}`), skuCode: u.skuCode,
                productId: id(`product:${u.dropKey}`), variantId: variantId(u.dropKey, u.variantKey),
                serialNumber: u.serial,
                ownerId: claimed ? id(`user:buyer:${u.claim!.buyerIdx}`) : null,
                claimedStatus: claimed ? ClaimedStatus.CLAIMED : ClaimedStatus.UNCLAIMED,
                tagId: u.tagId, provisioningBatchId: u.batchRef,
                // BOUND until the buyer's first tap makes it ACTIVE.
                tagLifecycleState: claimed ? TagLifecycleState.ACTIVE : TagLifecycleState.BOUND,
                vendorId: id(`vendor:${u.vendorKey}`),
                vendorAuthenticatedAt: u.createdAt, claimToken: null,
                claimTokenIssuedAt: null, claimTokenUsedAt: claimed ? u.claim!.claimedAt : null,
                resaleBlocked: false, resaleBlockedReason: null,
                lastTapCounter: claimed ? 2 + (u.serial % 5) : 0,
                tamperStatus: null,
                isActive: true, archivedAt: null,
                createdAt: u.createdAt, updatedAt: claimed ? u.claim!.claimedAt : u.createdAt,
            };
        }),
    });
    const claimedUnits = units.filter((u) => u.claim);
    console.log(`  units: ${units.length} across ${sellable.length} drops (${claimedUnits.length} claimed)`);

    await prisma.order.createMany({
        data: orders.map((o) => ({
            id: id(`order:${o.key}`), buyerId: id(`user:buyer:${o.buyerIdx}`),
            productId: id(`product:${o.drop.key}`), variantId: variantId(o.drop.key, o.variantKey),
            // A paid order holds its unit; before packing it is the placeholder.
            skuId: o.status === OrderStatus.PENDING_PAYMENT || o.status === OrderStatus.CANCELLED ? null : id(`sku:${o.unit.key}`),
            quantity: 1, organizationId: id(`org:${o.drop.org}`),
            marketId: id(`market:${o.market.key}`), status: o.status,
            unitPrice: dec(o.unitPrice), amount: dec(o.unitPrice),
            currency: o.market.currency, gateway: PaymentGateway.STRIPE,
            termsAcceptedAt: o.placedAt, paidAt: o.paidAt,
            unitAssignedAt: o.assignedAt, unitAssignedById: o.assignedAt ? id('user:ops') : null,
            shippedAt: o.shippedAt, deliveredAt: o.deliveredAt,
            trackingNote: o.shippedAt ? `DHL ${7740000 + o.index}` : o.status === OrderStatus.CANCELLED ? 'card_declined' : null,
            placedAt: o.placedAt,
            updatedAt: o.deliveredAt ?? o.shippedAt ?? o.assignedAt ?? o.paidAt ?? o.placedAt,
            archivedAt: null,
        })),
    });
    await prisma.orderAddress.createMany({
        data: orders.flatMap((o) => {
            const a = buyerAddress(o.buyerIdx);
            return (['SHIPPING', 'BILLING'] as const).map((usage) => ({
                id: id(`orderaddr:${o.key}:${usage}`), orderId: id(`order:${o.key}`),
                usage, sourceAddressId: id(`address:${o.buyerIdx}`),
                label: 'HOME' as const, labelCustom: null,
                recipientName: `Demo Buyer ${o.buyerIdx}`,
                line1: `${100 + o.buyerIdx} ${a.street}`, line2: null,
                city: a.city, state: a.state, postalCode: a.postalCode,
                countryCode: a.countryCode, phone: null, createdAt: o.placedAt,
            }));
        }),
    });
    await prisma.inventoryReservation.createMany({
        data: orders.map((o) => ({
            id: id(`reservation:${o.key}`), orderId: id(`order:${o.key}`), skuId: id(`sku:${o.unit.key}`),
            status: o.status === OrderStatus.PENDING_PAYMENT ? ReservationStatus.HELD
                : o.status === OrderStatus.CANCELLED ? ReservationStatus.RELEASED
                    : ReservationStatus.COMMITTED,
            // Pending checkouts are live holds; the rest expired long ago, which is fine once committed.
            expiresAt: o.status === OrderStatus.PENDING_PAYMENT
                ? new Date(NOW.getTime() + 25 * 60_000)
                : new Date(o.placedAt.getTime() + 15 * 60_000),
            createdAt: o.placedAt,
        })),
    });
    const byStatus = orders.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
    console.log(`  orders: ${orders.length} ${JSON.stringify(byStatus)}`);

    // ── Provenance: MINT for every unit, CLAIM for every claimed one ────────
    // Same hash rule as the running app: SHA-256(groupCode + tagId + owner + time).
    const ledgerHash = (groupCode: string, tagId: string, owner: string, at: Date) =>
        createHash('sha256').update([groupCode, tagId, owner, at.toISOString()].join('+')).digest('hex');
    const groupOf = (u: Unit) => dropMeta.find((d) => d.key === u.dropKey)!.groupCode;
    const handleOf = (buyerIdx: number) => `collector_${buyerIdx}`;
    await prisma.blockchainLedger.createMany({
        data: units.flatMap((u) => {
            const groupCode = groupOf(u);
            const mintHash = ledgerHash(groupCode, u.tagId, 'HitBox', u.createdAt);
            const rows: Prisma.BlockchainLedgerCreateManyInput[] = [{
                id: id(`ledger:${u.key}:0`), skuId: id(`sku:${u.key}`), sequenceNo: 0,
                previousHash: null, currentHash: mintHash, txType: LedgerTxType.MINT,
                sellerDigitalSignature: `sig_hitbox_${groupCode}`, buyerDigitalSignature: null, receiverPublicKey: null,
                payload: { ownerLabel: 'HitBox' }, actorType: 'SYSTEM', actorRef: null, reason: 'Minted',
                occurredAt: u.createdAt, createdAt: u.createdAt,
            }];
            if (u.claim) {
                const owner = handleOf(u.claim.buyerIdx);
                const claimId = id(`claim:${u.key}`);
                rows.push({
                    id: id(`ledger:${u.key}:1`), skuId: id(`sku:${u.key}`), sequenceNo: 1,
                    previousHash: mintHash, currentHash: ledgerHash(groupCode, u.tagId, owner, u.claim.claimedAt),
                    txType: LedgerTxType.CLAIM,
                    sellerDigitalSignature: `sig_hitbox_${groupCode}`, buyerDigitalSignature: `sig_buyer_${claimId}`,
                    receiverPublicKey: `pk_${id(`user:buyer:${u.claim.buyerIdx}`)}`,
                    payload: { ownerLabel: owner, claimId, toUserId: id(`user:buyer:${u.claim.buyerIdx}`), amount: u.claim.price.toFixed(2), currency: u.claim.currency },
                    actorType: 'USER', actorRef: id(`user:buyer:${u.claim.buyerIdx}`), reason: 'Claimed by tap',
                    occurredAt: u.claim.claimedAt, createdAt: u.claim.claimedAt,
                });
            }
            return rows;
        }),
    });

    // ── Claims, ownership history, buyer collections ────────────────────────
    const dropOfUnit = (u: Unit) => dropMeta.find((d) => d.key === u.dropKey)!;
    await prisma.skuClaim.createMany({
        data: claimedUnits.map((u) => ({
            id: id(`claim:${u.key}`), claimCode: u.claim!.claimKey,
            claimedNo: 1, claimedAt: u.claim!.claimedAt,
            userId: id(`user:buyer:${u.claim!.buyerIdx}`), skuId: id(`sku:${u.key}`),
            productId: id(`product:${u.dropKey}`),
            artistId: dropOfUnit(u).artistKey ? id(`artist:${dropOfUnit(u).artistKey}`) : null,
            collectionId: dropOfUnit(u).artistKey ? id(`collection:${dropOfUnit(u).artistKey}`) : null,
            revokedAt: null, revokedReason: null,
        })),
    });
    await prisma.skuHistory.createMany({
        data: claimedUnits.map((u) => ({
            id: id(`history:${u.key}`), skuId: id(`sku:${u.key}`),
            ownerId: id(`user:buyer:${u.claim!.buyerIdx}`), acquiredVia: AcquisitionMethod.CLAIM,
            price: dec(u.claim!.price), currency: u.claim!.currency,
            startedAt: u.claim!.claimedAt, endedAt: null, isCurrent: true,
        })),
    });
    await prisma.buyerCollection.createMany({
        data: claimedUnits.map((u, i) => ({
            id: id(`buyercollection:${u.key}`), userId: id(`user:buyer:${u.claim!.buyerIdx}`),
            skuId: id(`sku:${u.key}`),
            visibility: i % 4 === 0 ? Visibility.PUBLIC : Visibility.PRIVATE,
            shareToken: i % 4 === 0 ? id(`share:${u.key}`).replace(/-/g, '') : null,
            acquiredAt: u.claim!.claimedAt, archivedAt: null,
        })),
    });

    // ── Content + evolution ─────────────────────────────────────────────────
    // Holders of an artist's items unlock that artist's bundle.
    await prisma.contentBundle.createMany({
        data: artists.map((a, i) => ({
            id: id(`bundle:${a.key}`), name: `${a.name} — Backstage`,
            description: 'Unreleased footage for holders.',
            productId: null, collectionId: id(`collection:${a.key}`),
            accessType: i === 0 ? ContentAccessType.OWNER_ONLY : ContentAccessType.EVOLUTION_GRANT,
            isActive: true, archivedAt: null,
            createdAt: daysAgo(60 - i * 2), updatedAt: daysAgo(15),
        })),
    });
    await prisma.contentBundleItem.createMany({
        data: [{ id: id('bundleitem:kaze'), bundleId: id('bundle:kaze'), assetId: id('asset:exclusive'), position: 0 }],
    });
    const artistClaims = claimedUnits.filter((u) => dropOfUnit(u).artistKey);
    await prisma.contentUnlock.createMany({
        data: artistClaims.map((u, i) => ({
            id: id(`unlock:${u.key}`), userId: id(`user:buyer:${u.claim!.buyerIdx}`),
            bundleId: id(`bundle:${dropOfUnit(u).artistKey}`),
            skuId: id(`sku:${u.key}`), grantedAt: u.claim!.claimedAt,
            notifiedAt: u.claim!.claimedAt, acknowledgedAt: i % 3 === 0 ? hours(u.claim!.claimedAt, 6) : null,
            accessExpiresAt: null, lastAccessedAt: i % 2 === 0 ? daysAgo(3) : null,
            accessCount: i % 5,
        })),
    });
    await prisma.evolutionRule.createMany({
        data: [
            { id: id('evorule:hold'), name: 'Held 30 days', collectionId: id('collection:kaze'), productId: null, thresholdType: EvolutionThresholdType.OWNED_DURATION, thresholdValue: 30, thresholdConfig: Prisma.JsonNull, grantsBundleId: id('bundle:kaze'), isActive: true, archivedAt: null, createdAt: daysAgo(60) },
            { id: id('evorule:claims'), name: 'Five claims', collectionId: id('collection:ronin'), productId: null, thresholdType: EvolutionThresholdType.CLAIM_COUNT, thresholdValue: 5, thresholdConfig: { window: 'lifetime' }, grantsBundleId: id('bundle:ronin'), isActive: true, archivedAt: null, createdAt: daysAgo(60) },
        ],
    });
    // Kaze items held 30+ days have crossed the "Held 30 days" threshold.
    const heldLong = claimedUnits.filter((u) => dropOfUnit(u).artistKey === 'kaze' && u.claim!.claimedAt <= daysAgo(30));
    await prisma.evolutionEvent.createMany({
        data: heldLong.map((u) => ({
            id: id(`evoevent:${u.key}`), ruleId: id('evorule:hold'),
            skuId: id(`sku:${u.key}`), triggeredAt: new Date(u.claim!.claimedAt.getTime() + 30 * 86_400_000),
        })),
    });

    // ── Payments, refunds, gateway config ───────────────────────────────────
    await prisma.paymentTransaction.createMany({
        data: orders.map((o, i) => ({
            id: id(`payment:${o.key}`), orderId: id(`order:${o.key}`),
            gateway: PaymentGateway.STRIPE, gatewayRef: `pi_demo_${o.index}`,
            status: o.status === OrderStatus.PENDING_PAYMENT ? PaymentTransactionStatus.PENDING
                : o.status === OrderStatus.CANCELLED ? PaymentTransactionStatus.FAILED
                    : PaymentTransactionStatus.SUCCEEDED,
            idempotencyKey: `idem_${id(`payment:${o.key}`)}`,
            amount: dec(o.unitPrice), currency: o.market.currency,
            needsReview: i === 12,
            reviewedById: i === 12 ? id('user:fin') : null,
            reviewedAt: i === 12 ? daysAgo(4) : null,
            reviewNote: i === 12 ? 'Manual review — billing country differs from card country.' : null,
            failureReason: o.status === OrderStatus.CANCELLED ? 'card_declined' : null,
            createdAt: o.placedAt, updatedAt: o.paidAt ?? o.placedAt,
        })),
    });
    const refunded = orders.filter((o) => o.status === OrderStatus.REFUNDED);
    // Two recent deliveries with a return in progress, so "awaiting action" is non-zero.
    const returning = orders.filter((o) => o.status === OrderStatus.DELIVERED && !o.unit.claim).slice(-2);
    await prisma.refundRequest.createMany({
        data: [
            ...refunded.map((o, i) => ({
                id: id(`refund:${o.key}`), orderId: id(`order:${o.key}`),
                requestedById: id(`user:buyer:${o.buyerIdx}`),
                reason: `${o.drop.name} arrived damaged.`, status: RefundStatus.PROCESSED,
                reasonCode: RefundReason.DEFECTIVE_ITEM,
                amount: dec(o.unitPrice), currency: o.market.currency,
                physicalReturnRequired: true,
                physicalReturnConfirmedAt: hours(o.deliveredAt!, 96),
                // The item was damaged; its NFC tag came back intact.
                nfcTagCondition: 'INTACT' as const,
                approvedById: id('user:fin'), approvedAt: hours(o.deliveredAt!, 100),
                gatewayRefundId: `re_demo_${o.index}`,
                processedAt: hours(o.deliveredAt!, 102),
                createdAt: hours(o.deliveredAt!, 30), updatedAt: hours(o.deliveredAt!, 100 + i),
            })),
            ...returning.map((o, i) => ({
                id: id(`refund:pending:${o.key}`), orderId: id(`order:${o.key}`),
                requestedById: id(`user:buyer:${o.buyerIdx}`),
                reason: 'Wrong size — would like to return it.',
                status: i === 0 ? RefundStatus.REQUESTED : RefundStatus.AWAITING_RETURN,
                reasonCode: RefundReason.BUYER_CHANGED_MIND,
                amount: dec(o.unitPrice), currency: o.market.currency,
                physicalReturnRequired: true, physicalReturnConfirmedAt: null,
                approvedById: null, approvedAt: null, gatewayRefundId: null,
                createdAt: daysAgo(3 - i), updatedAt: daysAgo(2 - i),
            })),
        ],
    });
    await prisma.paymentGatewayConfig.createMany({
        data: [
            { id: id('gateway:platform'), scope: GatewayConfigScope.PLATFORM, organizationId: null, gateway: PaymentGateway.STRIPE, isDefault: true, credentialsRef: 'secrets://stripe/platform', status: ConfigStatus.ACTIVE, createdAt: daysAgo(120), updatedAt: daysAgo(120) },
            { id: id('gateway:ronin'), scope: GatewayConfigScope.ORGANIZATION, organizationId: id('org:ronin'), gateway: PaymentGateway.STRIPE, isDefault: false, credentialsRef: 'secrets://stripe/ronin', status: ConfigStatus.ACTIVE, createdAt: daysAgo(90), updatedAt: daysAgo(90) },
        ],
    });
    const paidOrders = orders.filter((o) => o.paidAt);
    await prisma.paymentWebhookEvent.createMany({
        data: paidOrders.slice(-10).map((o) => ({
            id: `evt_demo_${o.index}`, provider: PaymentGateway.STRIPE,
            eventType: 'payment_intent.succeeded',
            payload: { id: `pi_demo_${o.index}`, amount: o.unitPrice, currency: o.market.currency },
            signatureVerified: true, processedAt: o.paidAt!, processingError: null, receivedAt: o.paidAt!,
        })),
    });

    // ── Finance + royalties ─────────────────────────────────────────────────
    // Derived by `seed-finance.ts` from the drops, orders and claims above,
    // using @hitbox/finance's own calculators. It also links each claim to the
    // order that paid for it (Order.claimId).
    const finance = await seedFinanceDemo();
    console.log(
        `  finance: ${finance.rules} rules, ${finance.entries} royalty entries, ` +
        `${finance.payouts} payouts, ${finance.adjustments} adjustments, ` +
        `${finance.financeEntries} ledger lines ` +
        `(${finance.ordersLinkedToClaims} orders linked to their claim)`,
    );

    // ── Notifications ───────────────────────────────────────────────────────
    await prisma.notificationTemplate.createMany({
        data: [
            { id: id('tmpl:claim'), eventType: 'claims.product.claimed', channel: NotificationChannel.EMAIL, subject: 'You claimed {{productName}}', bodyTemplate: 'Congratulations — {{productName}} #{{serial}} is now yours.', parameters: ['productName', 'serial'], isActive: true, createdAt: daysAgo(120), updatedAt: daysAgo(120) },
            { id: id('tmpl:shipped'), eventType: 'orders.order.shipped', channel: NotificationChannel.EMAIL, subject: 'Your order is on its way', bodyTemplate: 'Tracking: {{tracking}}', parameters: ['tracking'], isActive: true, createdAt: daysAgo(120), updatedAt: daysAgo(120) },
            { id: id('tmpl:unlock'), eventType: 'content.bundle.unlocked', channel: NotificationChannel.IN_APP, subject: null, bodyTemplate: 'New exclusive content unlocked.', parameters: [], isActive: true, createdAt: daysAgo(120), updatedAt: daysAgo(120) },
        ],
    });
    await prisma.notification.createMany({
        data: [
            ...claimedUnits.map((u, i) => ({
                id: id(`notification:claim:${u.key}`), userId: id(`user:buyer:${u.claim!.buyerIdx}`),
                templateId: id('tmpl:claim'), channel: NotificationChannel.EMAIL,
                payload: { productName: dropOfUnit(u).name, serial: u.serial },
                status: i % 9 === 0 ? NotificationStatus.FAILED : i % 3 === 0 ? NotificationStatus.READ : NotificationStatus.SENT,
                sentAt: u.claim!.claimedAt, readAt: i % 3 === 0 ? hours(u.claim!.claimedAt, 2) : null,
                failureReason: i % 9 === 0 ? 'mailbox_full' : null, createdAt: u.claim!.claimedAt,
            })),
            ...orders.filter((o) => o.shippedAt).map((o) => ({
                id: id(`notification:shipped:${o.key}`), userId: id(`user:buyer:${o.buyerIdx}`),
                templateId: id('tmpl:shipped'), channel: NotificationChannel.EMAIL,
                payload: { tracking: `DHL ${7740000 + o.index}` },
                status: NotificationStatus.SENT, sentAt: o.shippedAt!, readAt: null,
                failureReason: null, createdAt: o.shippedAt!,
            })),
        ],
    });
    await prisma.notificationPreference.createMany({
        data: Array.from({ length: BUYER_COUNT }, (_, i) => [
            { id: id(`notifpref:${i}:email`), userId: id(`user:buyer:${i}`), channel: NotificationChannel.EMAIL, enabled: i % 7 !== 0 },
            { id: id(`notifpref:${i}:inapp`), userId: id(`user:buyer:${i}`), channel: NotificationChannel.IN_APP, enabled: true },
        ]).flat(),
    });

    // ── Social ──────────────────────────────────────────────────────────────
    // Buyers follow the artists whose items they claimed.
    const follows = new Map<string, { buyerIdx: number; artistKey: string; at: Date }>();
    for (const u of artistClaims) {
        const k = `${u.claim!.buyerIdx}:${dropOfUnit(u).artistKey}`;
        if (!follows.has(k)) follows.set(k, { buyerIdx: u.claim!.buyerIdx, artistKey: dropOfUnit(u).artistKey!, at: u.claim!.claimedAt });
    }
    await prisma.follow.createMany({
        data: [...follows.values()].map((f) => ({
            id: id(`follow:${f.buyerIdx}:${f.artistKey}`), followerId: id(`user:buyer:${f.buyerIdx}`),
            artistId: id(`artist:${f.artistKey}`), followedOrganizationId: null, createdAt: f.at,
        })),
    });
    // Wishlists: a specific variant of something on sale.
    const live = dropMeta.filter((d) => d.live);
    await prisma.wishlistItem.createMany({
        data: Array.from({ length: 24 }, (_, i) => {
            const d = pick(live, i);
            const v = d.variants.length ? pick(d.variants, i) : null;
            return {
                id: id(`wishlist:${i}`), userId: id(`user:buyer:${(i * 3) % BUYER_COUNT}`),
                productId: id(`product:${d.key}`), variantId: variantId(d.key, v?.key ?? null),
                notifyOnAvailable: i % 2 === 0,
                note: i % 6 === 0 ? `Waiting for ${v?.label ?? 'a restock'}` : null,
                createdAt: daysAgo(30 - i),
            };
        }),
    });

    // ── Resale + search ─────────────────────────────────────────────────────
    // Owners listing what they hold, at a markup, in the currency they paid in.
    await prisma.resaleListing.createMany({
        data: claimedUnits.slice(0, 10).map((u, i) => ({
            id: id(`resale:${u.key}`), sellerId: id(`user:buyer:${u.claim!.buyerIdx}`),
            skuId: id(`sku:${u.key}`), price: dec(Math.round(u.claim!.price * 1.6)), currency: u.claim!.currency,
            status: i % 4 === 3 ? ResaleStatus.CANCELLED : ResaleStatus.ACTIVE,
            createdAt: hours(u.claim!.claimedAt, 48), updatedAt: hours(u.claim!.claimedAt, 48),
        })),
    });
    await prisma.searchIndexJob.createMany({
        data: dropMeta.map((d, i) => ({
            id: id(`searchjob:${d.key}`), entityType: 'Product',
            entityId: id(`product:${d.key}`),
            operation: IndexOperation.UPSERT,
            status: i === dropMeta.length - 1 ? IndexJobStatus.QUEUED : IndexJobStatus.COMPLETED,
            attempts: 1, lastError: null,
            createdAt: daysAgo(Math.min(d.createdDaysAgo, 5)),
            completedAt: i === dropMeta.length - 1 ? null : daysAgo(Math.min(d.createdDaysAgo, 5)),
        })),
    });

    // ── Support ─────────────────────────────────────────────────────────────
    // Owners reporting problems with items they hold.
    const supportIssues = [
        { type: SupportCaseType.DAMAGED, status: SupportCaseStatus.RESOLVED, text: 'Print is peeling after the first wash.', note: 'Replacement shipped.' },
        { type: SupportCaseType.LOST, status: SupportCaseStatus.INVESTIGATING, text: 'Lost my keychain on a train — can the tag be frozen?', note: null },
        { type: SupportCaseType.DISPUTE, status: SupportCaseStatus.OPEN, text: 'Someone else says this card is theirs.', note: null },
        { type: SupportCaseType.DAMAGED, status: SupportCaseStatus.REJECTED, text: 'Corner is bent.', note: 'Within manufacturing tolerance.' },
    ];
    await prisma.supportCase.createMany({
        data: claimedUnits.slice(0, supportIssues.length).map((u, i) => {
            const issue = supportIssues[i]!;
            const done = issue.status === SupportCaseStatus.RESOLVED || issue.status === SupportCaseStatus.REJECTED;
            return {
                id: id(`case:${u.key}`), reporterId: id(`user:buyer:${u.claim!.buyerIdx}`),
                skuId: id(`sku:${u.key}`), tagId: null,
                caseType: issue.type, status: issue.status, description: issue.text,
                resolutionNote: issue.note, resolvedById: done ? id('user:support') : null,
                resolvedAt: done ? daysAgo(4) : null,
                createdAt: daysAgo(14 - i * 2), updatedAt: daysAgo(4),
            };
        }),
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
                severity: t.severity, beforeState: Prisma.JsonNull, afterState: { ok: true },
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

    // ── Real accounts back ──────────────────────────────────────────────────
    await restoreRealAccounts(
        preserved,
        new Map(staff.map((member) => [id(`user:${member.key}`), member.key])),
    );

    console.log('\n▸ done');
}

// ── Real accounts survive a reseed ──────────────────────────────────────────
//
// Demo personas use placeholder Clerk ids (`user_demo_…`, `user_test_…`).
// Anything else is a real Clerk account someone signs in with — an admin
// re-linked with `db:link-admin`, an artist linked with `db:link-artist`, a
// teammate. Clearing them would lock those people out, so they are
// snapshotted before the wipe and put back afterwards:
//
//   - an account that IS a seeded persona (same deterministic id, e.g. the
//     admin or the Kaze artist row) gets its real email + Clerk id back on the
//     freshly seeded row — keeping the persona's artist link and roles;
//   - any other account is recreated with the same id, and its role grants
//     are restored (organization scopes resolved by slug).

interface PreservedAccount {
    id: string; clerkId: string; email: string; fullName: string | null; handle: string | null;
    phone: string | null; isActive: boolean; createdAt: Date;
    roles: { roleName: string; scopeType: RoleScopeType; orgSlug: string | null }[];
}

async function snapshotRealAccounts(): Promise<PreservedAccount[]> {
    const users = await prisma.user.findMany({
        where: { NOT: [{ clerkId: { startsWith: 'user_demo_' } }, { clerkId: { startsWith: 'user_test_' } }] },
        select: { id: true, clerkId: true, email: true, fullName: true, handle: true, phone: true, isActive: true, createdAt: true },
    });
    const preserved: PreservedAccount[] = [];
    for (const u of users) {
        const grants = await prisma.roleAssignment.findMany({
            where: { userId: u.id, revokedAt: null },
            select: { scopeType: true, scopeId: true, role: { select: { name: true } } },
        });
        const orgIds = grants.map((g) => g.scopeId).filter((x): x is string => x !== null);
        const orgs = orgIds.length
            ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, slug: true } })
            : [];
        preserved.push({
            ...u,
            roles: grants.map((g) => ({
                roleName: g.role.name,
                scopeType: g.scopeType,
                orgSlug: g.scopeId ? orgs.find((o) => o.id === g.scopeId)?.slug ?? null : null,
            })),
        });
    }
    return preserved;
}

async function restoreRealAccounts(
    preserved: PreservedAccount[],
    seededPersonaIds: Map<string, string>,
): Promise<void> {
    if (preserved.length === 0) return;
    const roles = new Map((await prisma.role.findMany({ select: { id: true, name: true } })).map((r) => [r.name, r.id]));
    const orgs = new Map((await prisma.organization.findMany({ select: { id: true, slug: true } })).map((o) => [o.slug, o.id]));

    for (const account of preserved) {
        const persona = seededPersonaIds.get(account.id);
        if (persona) {
            await prisma.user.update({
                where: { id: account.id },
                data: { clerkId: account.clerkId, email: account.email, updatedAt: new Date() },
            });
        } else {
            const handleTaken = account.handle
                ? await prisma.user.findUnique({ where: { handle: account.handle }, select: { id: true } })
                : null;
            await prisma.user.create({
                data: {
                    id: account.id, clerkId: account.clerkId, email: account.email,
                    fullName: account.fullName, handle: handleTaken ? null : account.handle, phone: account.phone,
                    role: UserRole.USER, profileVisibility: Visibility.PRIVATE,
                    isActive: account.isActive, deactivatedAt: null, archivedAt: null,
                    createdAt: account.createdAt, updatedAt: new Date(),
                },
            });
        }

        for (const grant of account.roles) {
            const roleId = roles.get(grant.roleName);
            const scopeId = grant.orgSlug ? orgs.get(grant.orgSlug) ?? null : null;
            if (!roleId || (grant.orgSlug && !scopeId)) continue;
            const exists = await prisma.roleAssignment.findFirst({
                where: { userId: account.id, roleId, scopeType: grant.scopeType, scopeId, revokedAt: null },
                select: { id: true },
            });
            if (exists) continue;
            await prisma.roleAssignment.create({
                data: {
                    id: randomUUID(), userId: account.id, roleId,
                    scopeType: grant.scopeType, scopeId,
                    grantedById: id('user:admin'), grantedAt: new Date(), revokedAt: null,
                },
            });
        }
        console.log(`  kept real account ${account.email}${persona ? ` (as the ${persona} persona)` : ''} — ${account.roles.map((r) => r.roleName).join(', ') || 'no roles'}`);
    }
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
        // v3.1 tables. ExceptionCase has no FKs; the other three are placed by
        // their constraints — NfcVerification before NfcTag, NfcTag before both
        // Sku and SupplyBatch, and CogsReconciliation before Drop, which it
        // references ON DELETE RESTRICT and would otherwise block.
        prisma.exceptionCase.deleteMany(),
        prisma.nfcVerification.deleteMany(),
        prisma.nfcTag.deleteMany(),
        prisma.wishlistItem.deleteMany(),
        prisma.follow.deleteMany(),
        prisma.supportCase.deleteMany(),
        prisma.resaleListing.deleteMany(),
        prisma.evolutionEvent.deleteMany(),
        prisma.evolutionRule.deleteMany(),
        prisma.contentUnlock.deleteMany(),
        prisma.contentBundleItem.deleteMany(),
        prisma.contentBundle.deleteMany(),
        // Entries reference the payout batch and the rule, so they go first;
        // the batch itself references Artist and Organization, so it has to be
        // gone well before those are deleted below.
        prisma.royaltyLedgerEntry.deleteMany(),
        prisma.royaltyPayout.deleteMany(),
        prisma.royaltyRule.deleteMany(),
        prisma.adjustmentEntry.deleteMany(),
        prisma.financeLedgerEntry.deleteMany(),
        prisma.refundRequest.deleteMany(),
        prisma.paymentTransaction.deleteMany(),
        prisma.paymentWebhookEvent.deleteMany(),
        prisma.paymentGatewayConfig.deleteMany(),
        prisma.inventoryReservation.deleteMany(),
        prisma.orderAddress.deleteMany(),
        prisma.order.deleteMany(),
        prisma.buyerCollection.deleteMany(),
        prisma.skuHistory.deleteMany(),
        prisma.blockchainLedger.deleteMany(),
        prisma.skuClaim.deleteMany(),
        prisma.sku.deleteMany(),
        prisma.releaseApproval.deleteMany(),
        prisma.dropImage.deleteMany(),
        prisma.mediaAsset.deleteMany(),
        prisma.dropPrice.deleteMany(),
        prisma.dropVariant.deleteMany(),
        prisma.cogsReconciliation.deleteMany(),
        prisma.drop.deleteMany(),
        prisma.supplyBatch.deleteMany(),
        prisma.vendor.deleteMany(),
        prisma.artistBrandLink.deleteMany(),
        prisma.artistCollection.deleteMany(),
        prisma.artist.deleteMany(),
        prisma.address.deleteMany(),
        prisma.roleAssignment.deleteMany(),
        prisma.authWebhookEvent.deleteMany(),
        prisma.platformConfig.deleteMany(),
        // Three RESTRICT columns point at User (inviter, acceptor, revoker),
        // so an invitation outlives nobody: it has to go before the users do.
        prisma.staffInvitation.deleteMany(),
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

import { Router } from 'express';
import type { Request } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus, env } from '@hitbox/shared';
import { createAuthModule } from '@hitbox/auth';
import { createAccessControlModule } from '@hitbox/access-control';
import { createAuditModule, correlationIdOf } from '@hitbox/audit';
import { buildFinanceAccess, createFinanceModule } from '@hitbox/finance';
import { buildPaymentAccess, createPaymentsModule } from '@hitbox/payments';
import { createDashboardModule } from '@hitbox/dashboard';
import { createMediaModule, isPublicKey, S3ObjectStorage } from '@hitbox/media';
import { createUsersModule } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
import { createDiscoverModule } from '@hitbox/discover';
import { createMarketplaceModule } from '@hitbox/marketplace';
import { createCollectionsModule } from '@hitbox/collections';
import { createArtistModule } from '@hitbox/artist';
import { createClaimsModule } from '@hitbox/claims';
import { createMarketsModule } from '@hitbox/markets';
import { createOrdersModule } from '@hitbox/orders';
import { createReleasesModule } from '@hitbox/releases';
import { createSkusModule } from '@hitbox/skus';
import {
    buildBuyerTaxAccess,
    buildTaxAccess,
    createTaxModule,
    S3DocumentStorage,
    supplierProfilesFromEnv,
} from '@hitbox/tax';
import { createLeadsModule } from '@hitbox/leads';
import { buildRoutes } from './routes';

export interface Bootstrapped {
    /** Mobile platform routes, mounted at /api/v1 (see app.ts). */
    apiRouter: Router;
    /**
     * Public website (lead capture) routes, mounted at /app/web/v1 — a
     * separate route namespace on this SAME server/port, not a separate app.
     * Owns its own database (@hitbox/leads); everything else in this file
     * shares the mobile platform's @hitbox/database.
     */
    leadsRouter: Router;
    /**
     * Payment provider callbacks, mounted at /webhooks/payments — outside
     * /api/v1 and on their own budget (see app.ts). A 503 router when no
     * webhook signing secret is configured: an unverified payment webhook is a
     * way to mark any order paid, so "no secret" means "no endpoint".
     */
    webhookRouter: Router;
    /**
     * Frees stock holds whose checkout never completed. Call it from a
     * scheduler; it is idempotent and safe to run concurrently.
     */
    releaseExpiredReservations(): Promise<number>;
    /**
     * Subscribes the authorization cache to cross-instance invalidation
     * broadcasts. Until this runs, each process still caches locally but only
     * learns about another instance's revoke when its short L1 TTL lapses.
     */
    startCaches(): Promise<void>;
    /** Releases cache pub/sub connections on graceful shutdown. */
    stopCaches(): Promise<void>;
}

/**
 * Composition root — the ONLY place where modules learn about each other.
 * Order matters: users exposes the account-lookup port, auth consumes it,
 * then every module's router is built with auth's requireAuth middleware.
 */
export function bootstrap(): Bootstrapped {
    const usersModule = createUsersModule({ prisma, eventBus });

    const authModule = createAuthModule({
        prisma,
        eventBus,
        accounts: usersModule.accountLookup,
    });

    // Authorization. Depends on nothing but prisma + the event bus; the
    // principal resolver is the adapter that lets it read the authenticated
    // account without importing @hitbox/auth (see §6 of the architecture doc
    // — consumer defines the port, bootstrap connects it).
    const accessControlModule = createAccessControlModule({
        prisma,
        eventBus,
        resolvePrincipalId: (req) => req.auth?.accountId,
        // Staff provisioning: access-control decides who gets which role, auth
        // owns Clerk and does the emailing. Consumer declares the port, provider
        // writes the adapter — see docs/authorization/admin-provisioning.md.
        identityInvitations: authModule.invitations,
        invitationTtlHours: env.ADMIN_INVITATION_TTL_HOURS,
    });

    // The dashboard reads the caller's grants through the guard's own
    // per-request memo — one permission load serves a dozen section checks.
    const dashboardModule = createDashboardModule({
        prisma,
        resolvePrincipal: (req) => accessControlModule.guard.describePrincipal(req),
    });

    // Media needs a bucket. Without one the routes are not mounted at all
    // rather than mounted-but-broken: an upload endpoint that 500s after
    // creating a MediaAsset row leaves orphaned registry entries behind.
    //
    // No `scanPipeline` and no `scanCallback` — this deployment runs no
    // scanner and no SQS queue, so assets are created SKIPPED and are
    // servable immediately, and POST /scan-result is not mounted. See
    // docs/media/s3-configuration.md §8.
    const objectStorage = env.MEDIA_S3_BUCKET
        ? new S3ObjectStorage({
            bucket: env.MEDIA_S3_BUCKET,
            // ap-south-1 in production. The fallback only keeps a
            // half-configured local deploy from crashing at boot — a
            // wrong region makes presigned URLs fail at S3, not here.
            region: env.MEDIA_S3_REGION ?? 'us-east-1',
            endpoint: env.MEDIA_S3_ENDPOINT,
            forcePathStyle: Boolean(env.MEDIA_S3_ENDPOINT),
            publicBaseUrl: env.MEDIA_S3_PUBLIC_BASE_URL,
        })
        : null;

    /**
     * Products' IMediaUrlResolver port. The catalog stores image *keys*
     * (`ProductImage → MediaAsset.storageRef`) and needs URLs to render; only
     * this adapter knows the bucket and which prefixes are public.
     *
     * `isPublicKey` is the gate: a private key returns null rather than a URL
     * that would 403, because a public catalog feed cannot sign a GET. Product
     * images live under `drop-images/`, so in practice this always resolves.
     */
    const mediaUrls = objectStorage
        ? { publicUrl: (ref: string) => (isPublicKey(ref) ? objectStorage.publicUrl(ref) : null) }
        : undefined;

    const mediaModule = env.MEDIA_S3_BUCKET && objectStorage
        ? createMediaModule({
            prisma,
            guard: accessControlModule.guard,
            storage: objectStorage,
            bucket: env.MEDIA_S3_BUCKET,
            resolveCaller: async (req: Request) => {
                const principal = await accessControlModule.guard.describePrincipal(req);
                const orgIds = [
                    ...new Set(
                        principal.roles
                            .map((role) => role.organizationId)
                            .filter((id): id is string => id !== null),
                    ),
                ];
                // A caller holding the capability globally is unrestricted;
                // otherwise they are confined to their own organizations.
                const global = principal.permissions.includes(
                    'assets-documents-upload:manage:global',
                );
                return { userId: principal.userId, organizationIds: global ? null : orgIds };
            },
        })
        : null;

    /**
     * Serialized units. Built BEFORE products because products consumes its
     * minting port — the consumer is constructed with the provider in hand,
     * which is what keeps the dependency one-directional.
     *
     * `resolvePrincipal` is the adapter that lets skus read the caller's
     * grants without importing the authorization module: it decides how much
     * of a unit to reveal from those grants alone, never from the request.
     */
    const skusModule = createSkusModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        resolvePrincipal: (req) => accessControlModule.guard.describePrincipal(req),
    });

    /**
     * Markets. Built BEFORE products because products consumes its lookup
     * port: a `ProductPrice` names a market and inherits that market's
     * settlement currency, so the catalog cannot validate a price without it.
     */
    const marketsModule = createMarketsModule({
        prisma,
        guard: accessControlModule.guard,
    });

    const productsModule = createProductsModule({
        prisma,
        eventBus,
        mediaUrls,
        guard: accessControlModule.guard,
        skuMinting: skusModule.minting,
        // Media owns MediaAsset, so media answers "is this a real, live,
        // public-prefix image?" before products joins a gallery row to it.
        // Undefined on a deploy with no bucket — image attachment is then
        // refused with a clear error instead of writing unvalidated joins.
        mediaAssets: mediaModule?.assets,
        // Markets owns Market, so markets answers "does this market exist, is
        // it live, and what currency does it settle in?" before the catalog
        // writes a price against it.
        markets: marketsModule.markets,
    });

    /**
     * What an admin caller may see, derived from their own grants.
     *
     * Shared by orders and releases because both answer the same three
     * questions: which organizations do you reach, may you see money, may you
     * see buyers. Resolved here — never from the request — so a client cannot
     * widen its own view by sending an organizationId.
     */
    const adminView = async (req: Request) => {
        const principal = await accessControlModule.guard.describePrincipal(req);
        const has = (prefix: string) =>
            principal.permissions.some((key) => key.startsWith(prefix));
        const global = principal.permissions.some((key) => key.endsWith(':global'));
        const orgIds = [
            ...new Set(
                principal.roles
                    .map((role) => role.organizationId)
                    .filter((id): id is string => id !== null),
            ),
        ];
        return {
            userId: principal.userId,
            organizationIds: global ? null : orgIds,
            canSeeMoney: has('payment-royalty:'),
            canSeeBuyer: has('buyer-profile:'),
            canOverride: principal.permissions.includes('release-approval:override:global'),
        };
    };

    const ordersModule = createOrdersModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        resolveCaller: adminView,
    });

    const releasesModule = createReleasesModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        resolveCaller: adminView,
    });

    const discoverModule = createDiscoverModule({
        catalog: productsModule.discovery,
    });

    const marketplaceModule = createMarketplaceModule({
        catalog: productsModule.listings,
    });

    // Artist provides ArtistCollection capacity; collections consumes it for
    // the buyer collection-progress stat.
    const artistModule = createArtistModule({ prisma });

    const collectionsModule = createCollectionsModule({
        prisma,
        artistStats: artistModule.collectionStats,
        mediaUrls,
    });

    // NFC authenticity domain: single-tap claim, verify a tag, and read the
    // provenance ledger. Owns ProductClaim + BlockchainLedger.
    const claimsModule = createClaimsModule({ prisma, eventBus, mediaUrls });
    const claimsRouters = claimsModule.createRouters(authModule.requireAuth);

    // ── Money ───────────────────────────────────────────────────────────────
    //
    // Four modules, one direction of dependency:
    //
    //     payments ──▶ orders     (place, settle, cancel, refund an order)
    //     payments ──▶ finance    (book the sale / refund / chargeback,
    //                              reverse the artist's royalty)
    //     payments ──▶ claims     (revoke ownership on a refund)
    //     finance  ──▶ orders     (what was this unit sold for, and what did
    //                              it cost — via IOrderRevenueSource)
    //     finance  ◀── claims     (by EVENT: accrue when a tag is tapped)
    //
    // Nothing points back. Checkout lives in payments rather than orders for
    // exactly that reason — see docs/finance/module-boundaries.md.

    /**
     * The compliance trail. Constructed here for its `recorder` port, which
     * finance and payments write every money movement through; the audit read
     * API is a separate surface and is not mounted by this change.
     */
    const auditModule = createAuditModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        resolveReader: async (req: Request) => {
            const principal = await accessControlModule.guard.describePrincipal(req);
            const orgId = principal.roles
                .map((role) => role.organizationId)
                .find((id): id is string => id !== null);
            const global = principal.permissions.includes('audit-log:read:global');
            return {
                actor: { type: 'HITBOX_EMPLOYEE' as const, id: principal.userId },
                scope:
                    global || !orgId
                        ? ({ kind: 'GLOBAL' } as const)
                        : ({ kind: 'ORGANIZATION', organizationId: orgId } as const),
                correlationId: correlationIdOf(req as Request & { correlationId?: string }),
            };
        },
    });

    /**
     * Finance. Accrues on `claims.product.claimed` (the subscription is inside
     * the factory) and reads the sale behind a claim through orders' adapter,
     * never through the Order table.
     */
    const financeModule = createFinanceModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        audit: auditModule.recorder,
        orderRevenue: ordersModule.revenue,
        resolveAccess: async (req: Request) =>
            buildFinanceAccess(await accessControlModule.guard.describePrincipal(req)),
    });

    /**
     * Payments. No gateway adapter is wired on this deployment: the platform
     * records the order and the pending charge, the buyer completes payment in
     * the provider's own flow, and the *webhook* is what settles the order —
     * which is how card payments actually work, and the only statement about
     * money this system treats as authoritative. Refunds are issued in the
     * provider's dashboard and their reference supplied to `/process`.
     *
     * Without STRIPE_WEBHOOK_SECRET the webhook route is not mounted at all.
     */
    const paymentsModule = createPaymentsModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        audit: auditModule.recorder,
        orders: ordersModule.ledger,
        finance: financeModule.postings,
        royalties: financeModule.royaltyReversal,
        claims: claimsModule.revocation,
        webhookSigningSecret: env.STRIPE_WEBHOOK_SECRET,
        webhookToleranceSeconds: env.PAYMENT_WEBHOOK_TOLERANCE_SECONDS,
        holdSeconds: env.INVENTORY_HOLD_SECONDS,
        resolveAccess: async (req: Request) =>
            buildPaymentAccess(await accessControlModule.guard.describePrincipal(req)),
        // requireAuth has already run on every route that uses this, so
        // `req.auth` is present; the non-null assertion is the same one the
        // access-control principal resolver makes one line above.
        resolveBuyer: (req: Request) => req.auth?.accountId as string,
    });

    /**
     * Tax & invoicing. Built after finance and orders because it consumes both
     * — the order behind an invoice, and the payout behind a Form 16A /
     * 1099-NEC — and after artist for the "which artist is this user" lookup.
     *
     * It subscribes to `payments.order.settled` inside the factory: tax is due
     * on the supply, so the invoice is issued when the order settles, NOT when
     * the item is claimed. That is the one place it deliberately differs from
     * finance's accrual trigger — see docs/tax/invoice-generation.md §2.
     *
     * Storage is its own `S3DocumentStorage` against the same bucket, not the
     * media module's adapter: media presigns PUT URLs for a browser to upload
     * through, and an invoice is produced by the server and must never be
     * writable by a client. Null on a deploy with no bucket — invoices are
     * still issued and every figure still recorded, and only the document
     * routes report storage unavailable.
     */
    const taxDocumentStorage = env.MEDIA_S3_BUCKET
        ? new S3DocumentStorage({
            bucket: env.MEDIA_S3_BUCKET,
            region: env.MEDIA_S3_REGION ?? 'us-east-1',
            endpoint: env.MEDIA_S3_ENDPOINT,
            forcePathStyle: Boolean(env.MEDIA_S3_ENDPOINT),
            kmsKeyId: env.TAX_S3_KMS_KEY_ID,
        })
        : null;

    const taxModule = createTaxModule({
        prisma,
        eventBus,
        guard: accessControlModule.guard,
        audit: auditModule.recorder,
        orders: ordersModule.invoicing,
        payouts: financeModule.payoutReporting,
        artists: artistModule.ownership,
        storage: taxDocumentStorage,
        suppliers: supplierProfilesFromEnv(process.env),
        logoPath: env.TAX_INVOICE_LOGO_PATH,
        resolveAccess: async (req: Request) =>
            buildTaxAccess(await accessControlModule.guard.describePrincipal(req)),
        // Always BUYER scope, even for a caller who also holds
        // payment-royalty:read:global — the buyer surface's contract is "your
        // own receipts", and a wider grant must not change what it returns.
        resolveBuyerAccess: async (req: Request) =>
            buildBuyerTaxAccess(await accessControlModule.guard.describePrincipal(req)),
    });

    const apiRouter = buildRoutes({
        auth: authModule.router,
        users: usersModule.createRouter(authModule.requireAuth),
        products: productsModule.createRouter(authModule.requireAuth),
        discover: discoverModule.router,
        marketplace: marketplaceModule.router,
        collections: collectionsModule.createRouter(authModule.requireAuth),
        claims: claimsRouters.claims,
        verify: claimsRouters.verify,
        ledger: claimsRouters.ledger,
        authz: accessControlModule.createSelfRouter(authModule.requireAuth),
        adminAuthz: accessControlModule.createAdminRouter(authModule.requireAuth),
        adminDashboard: dashboardModule.createRouter(authModule.requireAuth),
        adminMedia: mediaModule
            ? mediaModule.createRouter(authModule.requireAuth)
            : mediaUnavailableRouter(),
        adminMarkets: marketsModule.createRouter(authModule.requireAuth),
        adminOrders: ordersModule.createRouter(authModule.requireAuth),
        adminReleases: releasesModule.createRouter(authModule.requireAuth),
        adminProducts: productsModule.createAdminRouter(authModule.requireAuth),
        adminProductSkus: skusModule.createProductRouter(authModule.requireAuth),
        adminSkus: skusModule.createRouter(authModule.requireAuth),
        payments: paymentsModule.createBuyerRouter(authModule.requireAuth),
        adminPayments: paymentsModule.createAdminRouter(authModule.requireAuth),
        adminFinance: financeModule.createRouter(authModule.requireAuth),
        tax: taxModule.createBuyerRouter(authModule.requireAuth),
        adminTax: taxModule.createAdminRouter(authModule.requireAuth),
    });

    // Public website (hitboxcollectibles.com) — its own database, no
    // dependency on anything above. See docs/repo-structure.md.
    const leadsModule = createLeadsModule();

    return {
        apiRouter,
        leadsRouter: leadsModule.router,
        webhookRouter: paymentsModule.createWebhookRouter() ?? webhooksUnavailableRouter(),
        releaseExpiredReservations: () => paymentsModule.releaseExpiredReservations(),
        startCaches: () => accessControlModule.startCache(),
        stopCaches: () => accessControlModule.stopCache(),
    };
}

/**
 * Stands in for the payment webhook route when no signing secret is
 * configured.
 *
 * The distinction this preserves is worth the extra router: a 503 says "this
 * deployment cannot verify payment callbacks", while an unmounted route would
 * 404 and look to the provider — and to whoever is debugging — exactly like a
 * misconfigured URL. What it must never do is accept the delivery.
 */
function webhooksUnavailableRouter(): Router {
    const router = Router();
    router.use((_req, res) => {
        res.status(503).json({
            error: {
                code: 'WEBHOOKS_UNAVAILABLE',
                message:
                    'Payment webhooks are not configured on this deployment (no signing secret).',
                details: null,
            },
        });
    });
    return router;
}

/**
 * Stands in for the media routes when no bucket is configured, so a
 * misconfigured deploy returns a clear 503 rather than a confusing 404 that
 * looks like the feature was never built.
 */
function mediaUnavailableRouter(): Router {
    const router = Router();
    router.use((_req, res) => {
        res.status(503).json({
            error: {
                code: 'STORAGE_UNAVAILABLE',
                message: 'Media storage is not configured on this deployment.',
                details: null,
            },
        });
    });
    return router;
}

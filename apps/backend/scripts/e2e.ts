/**
 * End-to-end API harness for the NFC single-tap claim flow + ledger.
 *
 * Composes the REAL feature modules but swaps the Clerk `requireAuth` middleware
 * for a stub that sets `req.auth` to a chosen seeded user — so every line of our
 * own code (routing, DTO validation, service logic, $transactions, hash chain,
 * error mapping) is exercised; only Clerk's third-party token verification is
 * bypassed (it needs a live JWT we can't mint here).
 *
 * Simulates two different people tapping the same tag: the first claims it, the
 * second is told it's "already claimed by <name>".
 *
 * Env (DATABASE_URL etc.) is provided by the orchestrator. Writes a markdown
 * report to REPORT_PATH.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import express from 'express';
import type { RequestHandler } from 'express';
import { prisma } from '@hitbox/database';
import { eventBus } from '@hitbox/shared';
import type { AuthContext } from '@hitbox/auth';
import { createAuthzModule } from '@hitbox/authz';
import { createUsersModule } from '@hitbox/users';
import { createProductsModule } from '@hitbox/products';
import { createDiscoverModule } from '@hitbox/discover';
import { createMarketplaceModule } from '@hitbox/marketplace';
import { createCollectionsModule } from '@hitbox/collections';
import { createArtistModule } from '@hitbox/artist';
import { createClaimsModule } from '@hitbox/claims';
import { buildRoutes } from '../src/routes';
import { buildAppSurface } from '../src/surfaces/app.surface';
import { buildPublicSurface } from '../src/surfaces/public.surface';
import { buildAdminSurface } from '../src/surfaces/admin.surface';
import { buildManageSurface } from '../src/surfaces/manage.surface';
import { createApp } from '../src/app';

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;
const REPORT_PATH = process.env.REPORT_PATH ?? 'nfc-api-e2e-test-report.md';

// ── stubbed auth ──────────────────────────────────────────────────────────
let currentAuth: AuthContext | null = null;
const stubAuth: RequestHandler = (req, _res, next) => {
    req.auth = currentAuth ?? undefined;
    next();
};
const authFor = (u: { id: string; clerkUserId: string; email: string }): AuthContext => ({
    accountId: u.id,
    clerkUserId: u.clerkUserId,
    email: u.email,
    sessionId: null,
    // Freshly verified first factor, so step-up-gated routes are reachable.
    factorVerificationAge: [0, -1],
});

// ── tiny test recorder ──────────────────────────────────────────────────────
interface Step {
    n: number; group: string; name: string;
    method: string; path: string; reqBody?: unknown; as?: string;
    status: number; expectStatus: number;
    checks: { label: string; pass: boolean }[];
    resp: unknown;
}
const steps: Step[] = [];
let seq = 0;

/** Recompute the ledger hash exactly per the demo spec, to prove it. */
const expectedHash = (productId: string, tag: string | null, ownerId: string, dateTime: string): string =>
    createHash('sha256').update([productId, tag ?? '', ownerId, dateTime].join('+')).digest('hex');

/** Poll until a predicate holds (for the async product-created event). */
async function waitUntil(pred: () => Promise<boolean>, tries = 50, delayMs = 100): Promise<boolean> {
    for (let i = 0; i < tries; i += 1) {
        if (await pred()) return true;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
}

async function call(
    group: string, name: string, method: string, path: string,
    opts: { auth?: AuthContext | null; asLabel?: string; body?: unknown; expectStatus: number; checks?: (r: any) => { label: string; pass: boolean }[] } = { expectStatus: 200 },
): Promise<any> {
    currentAuth = opts.auth ?? null;
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => null);
    const checks = [
        { label: `status ${opts.expectStatus}`, pass: res.status === opts.expectStatus },
        ...(opts.checks ? opts.checks(json) : []),
    ];
    seq += 1;
    steps.push({ n: seq, group, name, method, path, reqBody: opts.body, as: opts.asLabel, status: res.status, expectStatus: opts.expectStatus, checks, resp: json });
    return json;
}

async function main() {
    // Two throwaway test users (fresh DB — no cleanup needed).
    const buyer = await prisma.user.create({ data: { clerkUserId: 'e2e_buyer', email: 'e2e-buyer@test.local', username: 'jameela', firstName: 'Jameela', lastName: 'Khan' } });
    const other = await prisma.user.create({ data: { clerkUserId: 'e2e_other', email: 'e2e-other@test.local', username: 'akash', firstName: 'Akash', lastName: 'Rao' } });
    const buyerAuth = authFor(buyer);
    const otherAuth = authFor(other);

    // Build app with real modules + stub auth.
    const usersModule = createUsersModule({ prisma, eventBus });
    const productsModule = createProductsModule({ prisma, eventBus });
    const discoverModule = createDiscoverModule({ catalog: productsModule.discovery });
    const marketplaceModule = createMarketplaceModule({ catalog: productsModule.listings });
    const artistModule = createArtistModule({ prisma });
    const collectionsModule = createCollectionsModule({ prisma, artistStats: artistModule.collectionStats });
    const claimsModule = createClaimsModule({ prisma, eventBus });

    // Real authorization module: only Clerk token verification is stubbed, so
    // permission and resource-policy checks are exercised for real. This
    // requires the authz catalog to be seeded (`pnpm authz:seed`).
    const authzModule = createAuthzModule({
        prisma,
        eventBus,
        users: usersModule.userDirectory,
    });
    const requirePermission = authzModule.requirePermission;

    // Both tappers need the baseline USER role, which the Clerk webhook would
    // normally trigger via the users.provisioned event.
    await authzModule.roleAssignments.ensureDefaultRole(buyer.id);
    await authzModule.roleAssignments.ensureDefaultRole(other.id);

    const authzRouters = authzModule.createRouters(stubAuth);
    const claimsRouters = claimsModule.createRouters(stubAuth, requirePermission);
    const productsRouter = productsModule.createRouter(stubAuth, requirePermission);
    const usersRouter = usersModule.createRouter(stubAuth, requirePermission);
    const collectionsRouter = collectionsModule.createRouter(stubAuth, requirePermission);

    const api = buildRoutes({
        public: buildPublicSurface({
            auth: express.Router(),
            discover: discoverModule.router,
            marketplace: marketplaceModule.router,
            verify: claimsRouters.verify,
            ledger: claimsRouters.ledger,
        }),
        app: buildAppSurface({
            authzManifest: authzRouters.manifest,
            users: usersRouter,
            products: productsRouter,
            collections: collectionsRouter,
            claims: claimsRouters.claims,
        }),
        admin: buildAdminSurface({
            authzManifest: authzRouters.manifest,
            authzAdmin: authzRouters.admin,
            organizations: authzRouters.organizations,
            products: productsRouter,
            users: usersRouter,
        }),
        manage: buildManageSurface({
            authzManifest: authzRouters.manifest,
            organizations: authzRouters.organizations,
            products: productsRouter,
        }),
    });
    const app = createApp(api);
    const server = app.listen(PORT);
    await new Promise((r) => server.once('listening', r));

    const TAG = 'E2ETAG0000001';

    // 1. health
    await call('Health', 'Health check', 'GET', '/api/v1/health', {
        expectStatus: 200, checks: (r) => [{ label: 'status ok', pass: r?.status === 'ok' }],
    });

    // 2. create product (authed) with an NFC tag
    const created = await call('Setup', 'Create product with NFC tag', 'POST', '/api/v1/products', {
        auth: buyerAuth, asLabel: 'jameela', expectStatus: 201,
        body: { name: 'Aurora Genesis Card #001', type: 'INDIVIDUAL', category: 'TRADING_CARD', genre: 'MUSIC', rarity: 'RARE', priceInDollars: 49.99, inventoryUnit: 10, tagId: TAG, images: [{ title: 'cover', url: 'https://example.com/e2e.png' }] },
        checks: (r) => [
            { label: 'has cuid id', pass: typeof r?.data?.id === 'string' },
            { label: 'productCode 12 chars', pass: r?.data?.productCode?.length === 12 },
            { label: 'tagId echoed', pass: r?.data?.tagId === TAG },
            { label: 'claimedStatus UNCLAIMED', pass: r?.data?.claimedStatus === 'UNCLAIMED' },
        ],
    });
    const productId: string = created?.data?.id;

    // 3. product by tag
    await call('Products', 'Get product by tag', 'GET', `/api/v1/products/tag/${TAG}`, {
        expectStatus: 200, checks: (r) => [{ label: 'id matches created', pass: r?.data?.id === productId }],
    });

    // 4. verify — unclaimed
    await call('Verify', 'Verify before claim (unclaimed)', 'GET', `/api/v1/verify/${TAG}`, {
        expectStatus: 200, checks: (r) => [
            { label: 'valid true', pass: r?.data?.valid === true },
            { label: 'claimed false', pass: r?.data?.claimed === false },
            { label: 'owner null', pass: r?.data?.owner === null },
        ],
    });

    // The "First Time" origin record is written asynchronously by the
    // product-created event — wait for it to land.
    await waitUntil(async () => {
        const r = (await (await fetch(`${BASE}/api/v1/ledger/${TAG}`)).json()) as any;
        return Array.isArray(r?.data) && r.data.length >= 1;
    });

    // 5. ledger before claim — the HitBox "First Time" origin record exists
    await call('Ledger', 'Ledger before claim (First Time origin record, HitBox)', 'GET', `/api/v1/ledger/${TAG}`, {
        expectStatus: 200, checks: (r) => {
            const d = r?.data ?? [];
            return [
                { label: '1 origin row', pass: d.length === 1 },
                { label: 'seq0 MINT, owner=HitBox', pass: d[0]?.txType === 'MINT' && d[0]?.ownerId === 'HitBox' },
                { label: 'claimHistory=No, p2p=No', pass: d[0]?.claimHistory === false && d[0]?.peerToPeerTrading === false },
                { label: 'productId(12) + tag present', pass: d[0]?.productId?.length === 12 && d[0]?.tag === TAG },
                { label: 'hash = SHA256(productId+tag+owner+dateTime)', pass: d[0]?.hash === expectedHash(d[0]?.productId, d[0]?.tag, d[0]?.ownerId, d[0]?.dateTime) },
            ];
        },
    });
    await call('Products', 'History before claim (empty)', 'GET', `/api/v1/products/tag/${TAG}/history`, {
        expectStatus: 200, checks: (r) => [{ label: 'empty', pass: Array.isArray(r?.data) && r.data.length === 0 }],
    });

    // 6. FIRST TAP — jameela claims it
    await call('Claim flow', 'First tap — jameela claims (unclaimed → CLAIMED)', 'POST', `/api/v1/claim/${TAG}`, {
        auth: buyerAuth, asLabel: 'jameela', expectStatus: 200, body: { visibility: 'PUBLIC' },
        checks: (r) => [
            { label: 'outcome CLAIMED', pass: r?.data?.outcome === 'CLAIMED' },
            { label: 'claimedByYou true', pass: r?.data?.claimedByYou === true },
            { label: 'owner = jameela', pass: r?.data?.owner?.username === 'jameela' && r?.data?.owner?.id === buyer.id },
            { label: 'claim.claimCode HBPC######', pass: /^HBPC\d{6}$/.test(r?.data?.claim?.claimCode ?? '') },
            { label: 'message says "You claimed"', pass: typeof r?.data?.message === 'string' && r.data.message.includes('You claimed') },
        ],
    });

    // 7. SECOND TAP by someone else — akash re-taps
    await call('Claim flow', 'Re-tap by akash (already claimed → shows owner name)', 'POST', `/api/v1/claim/${TAG}`, {
        auth: otherAuth, asLabel: 'akash', expectStatus: 200, body: {},
        checks: (r) => [
            { label: 'outcome ALREADY_CLAIMED', pass: r?.data?.outcome === 'ALREADY_CLAIMED' },
            { label: 'claimedByYou false', pass: r?.data?.claimedByYou === false },
            { label: 'owner reported = jameela', pass: r?.data?.owner?.username === 'jameela' },
            { label: 'message names the owner', pass: typeof r?.data?.message === 'string' && r.data.message.includes('jameela') && r.data.message.includes('already claimed') },
            { label: 'no claim record returned', pass: r?.data?.claim === null },
        ],
    });

    // 8. RE-TAP by the owner — jameela taps her own
    await call('Claim flow', 'Re-tap by jameela herself (already own)', 'POST', `/api/v1/claim/${TAG}`, {
        auth: buyerAuth, asLabel: 'jameela', expectStatus: 200, body: {},
        checks: (r) => [
            { label: 'outcome ALREADY_CLAIMED', pass: r?.data?.outcome === 'ALREADY_CLAIMED' },
            { label: 'claimedByYou true', pass: r?.data?.claimedByYou === true },
            { label: 'message says "You already own"', pass: typeof r?.data?.message === 'string' && r.data.message.includes('You already own') },
        ],
    });

    // 9. verify after claim
    await call('Verify', 'Verify after claim (owner = jameela)', 'GET', `/api/v1/verify/${TAG}`, {
        expectStatus: 200, checks: (r) => [
            { label: 'claimed true', pass: r?.data?.claimed === true },
            { label: 'owner = jameela', pass: r?.data?.owner?.username === 'jameela' },
            { label: 'ledgerLength 2 (MINT+CLAIM)', pass: r?.data?.ledgerLength === 2 },
        ],
    });

    // 10. ledger — First Time (HitBox) + Claim (jameela), per the spec columns
    await call('Ledger', 'Ledger after claim (origin + claim record, per spec)', 'GET', `/api/v1/ledger/${TAG}`, {
        expectStatus: 200, checks: (r) => {
            const d = r?.data ?? [];
            return [
                { label: '2 rows', pass: d.length === 2 },
                { label: 'seq0 MINT owner=HitBox, claimHistory=No, p2p=No', pass: d[0]?.txType === 'MINT' && d[0]?.ownerId === 'HitBox' && d[0]?.claimHistory === false && d[0]?.peerToPeerTrading === false },
                { label: 'seq1 CLAIM owner=jameela, claimHistory=Yes, p2p=Yes', pass: d[1]?.txType === 'CLAIM' && d[1]?.ownerId === 'jameela' && d[1]?.claimHistory === true && d[1]?.peerToPeerTrading === true },
                { label: 'same productId + tag on both rows', pass: d[0]?.productId === d[1]?.productId && d[0]?.tag === TAG && d[1]?.tag === TAG },
                { label: 'origin hash = SHA256(productId+tag+owner+dateTime)', pass: d[0]?.hash === expectedHash(d[0]?.productId, d[0]?.tag, d[0]?.ownerId, d[0]?.dateTime) },
                { label: 'claim hash = SHA256(productId+tag+owner+dateTime)', pass: d[1]?.hash === expectedHash(d[1]?.productId, d[1]?.tag, d[1]?.ownerId, d[1]?.dateTime) },
                { label: 'chain link: seq1.previousHash == seq0.hash', pass: !!d[0]?.hash && d[1]?.previousHash === d[0]?.hash },
            ];
        },
    });

    // 11. history after claim — one open period
    await call('Products', 'History after claim (1 open period, jameela)', 'GET', `/api/v1/products/tag/${TAG}/history`, {
        expectStatus: 200, checks: (r) => [
            { label: '1 period', pass: Array.isArray(r?.data) && r.data.length === 1 },
            { label: 'owner=jameela, open', pass: r?.data?.[0]?.ownerId === buyer.id && r?.data?.[0]?.ownershipEndDate === null },
        ],
    });

    // ── error / edge cases ───────────────────────────────────────────────────
    await call('Errors', 'Claim unknown tag → 404', 'POST', '/api/v1/claim/NOSUCHTAG', {
        auth: buyerAuth, asLabel: 'jameela', expectStatus: 404,
        checks: (r) => [{ label: 'code TAG_NOT_FOUND', pass: r?.error?.code === 'CLAIMS_TAG_NOT_FOUND' }],
    });
    await call('Errors', 'Verify unknown tag → 404', 'GET', '/api/v1/verify/NOSUCHTAG', {
        expectStatus: 404, checks: (r) => [{ label: 'code TAG_NOT_FOUND', pass: r?.error?.code === 'CLAIMS_TAG_NOT_FOUND' }],
    });
    await call('Errors', 'Claim without auth → 401', 'POST', `/api/v1/claim/${TAG}`, {
        auth: null, expectStatus: 401,
        checks: (r) => [{ label: 'code UNAUTHENTICATED', pass: r?.error?.code === 'UNAUTHENTICATED' }],
    });
    await call('Errors', 'Create product missing name → 422', 'POST', '/api/v1/products', {
        auth: buyerAuth, asLabel: 'jameela', expectStatus: 422, body: { type: 'INDIVIDUAL', category: 'OTHER', genre: 'OTHER' },
        checks: (r) => [{ label: 'code VALIDATION_ERROR', pass: r?.error?.code === 'VALIDATION_ERROR' }],
    });

    server.close();
    await prisma.$disconnect();

    // ── report ───────────────────────────────────────────────────────────────
    const total = steps.reduce((a, s) => a + s.checks.length, 0);
    const passed = steps.reduce((a, s) => a + s.checks.filter((c) => c.pass).length, 0);
    const stepFails = steps.filter((s) => s.checks.some((c) => !c.pass));

    writeFileSync(REPORT_PATH, renderReport({ total, passed, stepFails: stepFails.length }));

    const line = (s: Step) => `${s.checks.every((c) => c.pass) ? 'PASS' : 'FAIL'}  #${s.n} [${s.group}] ${s.name} — ${s.method} ${s.path} → ${s.status}`;
    for (const s of steps) console.log(line(s));
    console.log(`\n${passed}/${total} assertions passed across ${steps.length} calls; ${stepFails.length} step(s) with failures.`);
    process.exit(stepFails.length === 0 ? 0 : 1);
}

function renderReport(sum: { total: number; passed: number; stepFails: number }): string {
    const now = process.env.RUN_TS ?? '(build-time)';
    const badge = sum.stepFails === 0 ? '✅ ALL PASSED' : `❌ ${sum.stepFails} STEP(S) FAILED`;
    let md = `# NFC Claim API — End-to-End Test Report\n\n`;
    md += `**Result: ${badge}** — ${sum.passed}/${sum.total} assertions passed across ${steps.length} API calls.\n\n`;
    md += `- Run at: ${now}\n`;
    md += `- Environment: throwaway local PostgreSQL (isolated; the production Neon DB was never touched)\n`;
    md += `- Migration applied: \`20260723120000_add_ledger_provenance_chain\`\n`;
    md += `- Auth: Clerk \`requireAuth\` replaced by a stub injecting \`req.auth\` for a seeded user, so two different "tappers" (jameela, akash) could be simulated. All other code paths are the real modules.\n\n`;
    md += `> The stub means Clerk's own JWT verification isn't exercised here — every other layer (routing, Zod validation, services, Prisma \`$transaction\`s, the hash chain, error mapping) is.\n\n`;
    md += `---\n\n`;

    let group = '';
    for (const s of steps) {
        if (s.group !== group) { group = s.group; md += `## ${group}\n\n`; }
        const ok = s.checks.every((c) => c.pass);
        md += `### ${ok ? '✅' : '❌'} #${s.n} ${s.name}\n\n`;
        md += `\`${s.method} ${s.path}\`${s.as ? ` — as **${s.as}**` : ''} → **${s.status}** (expected ${s.expectStatus})\n\n`;
        if (s.reqBody !== undefined) md += `Request body:\n\n\`\`\`json\n${JSON.stringify(s.reqBody, null, 2)}\n\`\`\`\n\n`;
        md += `Checks:\n\n`;
        for (const c of s.checks) md += `- ${c.pass ? '✅' : '❌'} ${c.label}\n`;
        md += `\nResponse:\n\n\`\`\`json\n${JSON.stringify(s.resp, null, 2)}\n\`\`\`\n\n`;
    }
    return md;
}

main().catch((err) => { console.error(err); process.exit(1); });

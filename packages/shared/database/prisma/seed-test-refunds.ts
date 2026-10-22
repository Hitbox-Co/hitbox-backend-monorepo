/**
 * Test data for the refund flow (docs/orders/order-payments-and-refunds-api.md).
 *
 *   pnpm db:seed:test-refunds
 *
 * Non-destructive: it never deletes anything. It picks existing demo orders
 * that have NO refund yet and puts one refund on each, in a different state of
 * the workflow — so every button (`allowedActions`) has something to press:
 *
 *   A  REQUESTED        return required, item not back   (claimed unit → tests claim revocation)
 *   B  REQUESTED        no return required (duplicate charge)
 *   C  AWAITING_RETURN  item back, tag INTACT             → ready to approve
 *   D  AWAITING_RETURN  item back, tag DAMAGED (claimed)  → approve + process tests resale block
 *   E  APPROVED         approved by override (lost parcel) → ready to process
 *   F  REJECTED         history only
 *   G  PROCESSED        then FAILED at Stripe (gatewayStatus) — reuses a demo refund
 *
 * It also lists untouched orders you can start a NEW refund on from the order
 * page. Re-running uses the next orders without refunds, until none are left.
 *
 * Every row matches what the real endpoints would have written at that step;
 * reasons are prefixed "[TEST]" so they are easy to spot.
 */
import { createHash } from 'node:crypto';
import { prisma } from '../src/index';

type RefundSeed = {
    label: string;
    wantClaimed: boolean | null;
    orderStatuses: string[];
    data: (order: { amount: string; placedAt: Date }) => Record<string, unknown>;
    next: string;
};

const hoursAfter = (base: Date, h: number) => new Date(Math.min(base.getTime() + h * 3600_000, Date.now() - 60_000));
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function uuidFrom(label: string): string {
    const h = createHash('sha1').update(`hitbox-test-refund:${label}`).digest('hex');
    return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, ((parseInt(h[16]!, 16) & 3) | 8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join('-');
}

async function main(): Promise<void> {
    const approver = await prisma.user.findFirst({ where: { email: 'order.manager@hitbox.demo' }, select: { id: true } });
    if (!approver) throw new Error('order.manager@hitbox.demo not found — run `pnpm db:seed:demo` first.');

    const scenarios: RefundSeed[] = [
        {
            label: 'A', wantClaimed: true, orderStatuses: ['DELIVERED'],
            data: () => ({
                status: 'REQUESTED', reasonCode: 'DEFECTIVE_ITEM', physicalReturnRequired: true,
                reason: '[TEST] Print is peeling after the first wash.',
                createdAt: daysAgo(2), updatedAt: daysAgo(2),
            }),
            next: 'confirm-return (INTACT) → approve → process — buyer had claimed it, so the claim gets revoked',
        },
        {
            label: 'B', wantClaimed: false, orderStatuses: ['DELIVERED'],
            data: () => ({
                status: 'REQUESTED', reasonCode: 'DUPLICATE_CHARGE', physicalReturnRequired: false,
                reason: '[TEST] Charged twice for the same order.',
                createdAt: daysAgo(1), updatedAt: daysAgo(1),
            }),
            next: 'approve straight away (no return needed) → process',
        },
        {
            label: 'C', wantClaimed: false, orderStatuses: ['DELIVERED'],
            data: () => ({
                status: 'AWAITING_RETURN', reasonCode: 'NOT_AS_DESCRIBED', physicalReturnRequired: true,
                reason: '[TEST] Colour is different from the product photos.',
                physicalReturnConfirmedAt: daysAgo(1), nfcTagCondition: 'INTACT',
                createdAt: daysAgo(5), updatedAt: daysAgo(1),
            }),
            next: 'approve → process',
        },
        {
            label: 'D', wantClaimed: true, orderStatuses: ['DELIVERED'],
            data: () => ({
                status: 'AWAITING_RETURN', reasonCode: 'DEFECTIVE_TAG', physicalReturnRequired: true,
                reason: '[TEST] The NFC tag stopped responding.',
                physicalReturnConfirmedAt: daysAgo(1), nfcTagCondition: 'DAMAGED',
                createdAt: daysAgo(6), updatedAt: daysAgo(1),
            }),
            next: 'approve → process — tag came back DAMAGED, so resale gets blocked and the claim revoked',
        },
        {
            label: 'E', wantClaimed: null, orderStatuses: ['SHIPPED'],
            data: () => ({
                status: 'APPROVED', reasonCode: 'NOT_DELIVERED', physicalReturnRequired: true,
                reason: '[TEST] Courier confirmed the parcel was lost in transit.',
                approvedById: approver.id, approvedAt: daysAgo(0.5),
                createdAt: daysAgo(2), updatedAt: daysAgo(0.5),
            }),
            next: 'process (pass gatewayRefundId, e.g. "re_test_E")',
        },
        {
            label: 'F', wantClaimed: false, orderStatuses: ['DELIVERED'],
            data: () => ({
                status: 'REJECTED', reasonCode: 'BUYER_CHANGED_MIND', physicalReturnRequired: true,
                reason: '[TEST] Changed my mind after 40 days.',
                rejectionReason: 'Outside the 30-day return window.',
                createdAt: daysAgo(4), updatedAt: daysAgo(3),
            }),
            next: 'nothing — terminal; shows in history',
        },
    ];

    const used = new Set<string>();
    const created: { label: string; refundId: string; orderId: string; product: string; amount: string; status: string; next: string }[] = [];

    for (const s of scenarios) {
        const order = await prisma.order.findFirst({
            where: {
                status: { in: s.orderStatuses as never },
                refundRequests: { none: {} },
                id: { notIn: [...used] },
                skuId: { not: null },
                ...(s.wantClaimed === null ? {} : { sku: { claimedStatus: s.wantClaimed ? 'CLAIMED' : 'UNCLAIMED' } }),
            },
            orderBy: { placedAt: 'desc' },
            select: { id: true, buyerId: true, amount: true, currency: true, placedAt: true, drop: { select: { name: true } } },
        });
        if (!order) {
            console.log(`• ${s.label}: no suitable order left (${s.orderStatuses.join('/')}, claimed=${s.wantClaimed}) — skipped`);
            continue;
        }
        used.add(order.id);
        const refundId = uuidFrom(`${s.label}:${order.id}`);
        const extra = s.data({ amount: order.amount.toFixed(2), placedAt: order.placedAt });
        await prisma.refundRequest.create({
            data: {
                id: refundId,
                orderId: order.id,
                requestedById: order.buyerId,
                amount: order.amount,
                currency: order.currency,
                ...(extra as object),
            } as never,
        });
        created.push({
            label: s.label, refundId, orderId: order.id, product: order.drop.name,
            amount: `${order.amount.toFixed(2)} ${order.currency}`, status: String(extra.status), next: s.next,
        });
    }

    console.log('\n✔ refund test scenarios');
    for (const c of created) {
        console.log(`\n  ${c.label}  ${c.status.padEnd(15)} ${c.product} — ${c.amount}`);
        console.log(`     refund ${c.refundId}`);
        console.log(`     order  ${c.orderId}`);
        console.log(`     next:  ${c.next}`);
    }

    // G — a refund that was PROCESSED and then failed at Stripe (closed card).
    // Reuses a demo refund that is already PROCESSED, because a failed refund
    // only exists after the whole process step ran (order REFUNDED, claim
    // revoked…), which this seed does not fake. Only the provider status
    // changes; re-running leaves an existing G alone.
    const existingG = await prisma.refundRequest.findFirst({
        where: { status: 'PROCESSED', gatewayStatus: 'FAILED' },
        select: { id: true, orderId: true },
    });
    const g = existingG ?? await prisma.refundRequest.findFirst({
        where: { status: 'PROCESSED', OR: [{ gatewayStatus: 'SUCCEEDED' }, { gatewayStatus: null }] },
        orderBy: { processedAt: 'desc' },
        select: { id: true, orderId: true },
    });
    if (g && !existingG) {
        await prisma.refundRequest.update({
            where: { id: g.id },
            data: { gatewayStatus: 'FAILED', gatewayFailureReason: 'expired_or_canceled_card', gatewayStatusAt: daysAgo(0.2) },
        });
    }
    if (g) {
        console.log(`\n  G  PROCESSED but Stripe FAILED (gatewayStatus=FAILED, expired_or_canceled_card)`);
        console.log(`     refund ${g.id}`);
        console.log(`     order  ${g.orderId}`);
        console.log('     next:  nothing to press — the UI should show "Refund failed — buyer not paid" (money.refundFailed > 0)');
    }

    // Orders to start a brand-new refund on, from the order page.
    const fresh = await prisma.order.findMany({
        where: { status: { in: ['DELIVERED', 'SHIPPED', 'PROCESSING', 'PAID'] }, refundRequests: { none: {} }, id: { notIn: [...used] } },
        orderBy: { placedAt: 'desc' },
        distinct: ['status'],
        select: { id: true, status: true, amount: true, currency: true, drop: { select: { name: true } } },
    });
    console.log('\n  Start a NEW refund on (order page → Refund):');
    for (const o of fresh) console.log(`     ${o.status.padEnd(10)} ${o.id}  ${o.drop.name} — ${o.amount.toFixed(2)} ${o.currency}`);
    console.log('\n  Processing: with STRIPE_SECRET_KEY set, run `pnpm db:stripe:test-charges` first, then Process with {}.');
    console.log('  Without a Stripe key, send { "gatewayRefundId": "re_test_…" }.');
}

main()
    .catch((error) => {
        console.error('✖ refund test seed failed:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

/**
 * Real Stripe TEST-mode charges behind the refund test data, so "Process"
 * can issue a real (test) refund through the Stripe adapter.
 *
 *   pnpm db:stripe:test-charges                 every open [TEST] refund
 *   pnpm db:stripe:test-charges -- <orderId>…   these orders as well
 *
 * Why it exists: seeded payments carry made-up references (`pi_demo_12`).
 * Stripe has never heard of them, so a refund against one fails with
 * "No such payment_intent". This creates a matching PaymentIntent in your
 * Stripe test account — paid with Stripe's test card `pm_card_visa` — and
 * points the order's settled PaymentTransaction at it.
 *
 * Safety:
 *   - refuses anything but an `sk_test_…` key, so it cannot charge a card;
 *   - only touches payments whose ref is missing or `pi_demo_…`;
 *   - idempotent: the Stripe idempotency key is per payment row, and a row
 *     already pointing at a real intent is skipped.
 *
 * Uses STRIPE_SECRET_KEY_PLATFORM, falling back to STRIPE_SECRET_KEY — the
 * same key the backend resolves for `secrets://stripe/platform`. If you give an
 * organization its own STRIPE_SECRET_KEY_<ORG>, it must be the same test
 * account, or refunds on that org's orders will not find the charge.
 */
import { prisma } from '../src/index';

const key = (process.env['STRIPE_SECRET_KEY_PLATFORM'] ?? process.env['STRIPE_SECRET_KEY'] ?? '').trim();

async function createTestIntent(input: {
    paymentId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
}): Promise<string> {
    const body = new URLSearchParams({
        amount: String(input.amountMinor),
        currency: input.currency.toLowerCase(),
        payment_method: 'pm_card_visa',
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
        description: `HitBox test charge for order ${input.orderId}`,
        'metadata[orderId]': input.orderId,
        'metadata[paymentTransactionId]': input.paymentId,
        'metadata[hitboxTestCharge]': 'true',
    });
    const response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': `hitbox-test-charge:${input.paymentId}`,
        },
        body,
    });
    const json = (await response.json()) as { id?: string; status?: string; error?: { message?: string } };
    if (!response.ok || !json.id) throw new Error(json.error?.message ?? `HTTP ${response.status}`);
    if (json.status !== 'succeeded') throw new Error(`intent ${json.id} is ${json.status}, not succeeded`);
    return json.id;
}

async function main(): Promise<void> {
    if (!key.startsWith('sk_test_')) {
        throw new Error('Set STRIPE_SECRET_KEY to a Stripe TEST key (sk_test_…) in .env. Live keys are refused.');
    }

    const extraOrderIds = process.argv.slice(2).filter((arg) => /^[0-9a-f-]{36}$/i.test(arg));
    const openTestRefunds = await prisma.refundRequest.findMany({
        where: { status: { in: ['REQUESTED', 'AWAITING_RETURN', 'APPROVED'] }, reason: { startsWith: '[TEST]' } },
        select: { orderId: true },
    });
    const orderIds = [...new Set([...openTestRefunds.map((r) => r.orderId), ...extraOrderIds])];
    if (orderIds.length === 0) {
        console.log('Nothing to do — run `pnpm db:seed:test-refunds` first, or pass order ids.');
        return;
    }

    let linked = 0;
    for (const orderId of orderIds) {
        const payment = await prisma.paymentTransaction.findFirst({
            where: { orderId, status: 'SUCCEEDED' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, gatewayRef: true, amount: true, currency: true },
        });
        if (!payment) {
            console.log(`• ${orderId}  no settled payment — skipped`);
            continue;
        }
        if (payment.gatewayRef && !payment.gatewayRef.startsWith('pi_demo_')) {
            console.log(`• ${orderId}  already linked to ${payment.gatewayRef}`);
            continue;
        }
        try {
            const intentId = await createTestIntent({
                paymentId: payment.id,
                orderId,
                // Every HitBox currency (USD/INR/GBP) has two decimals.
                amountMinor: Math.round(Number(payment.amount.toFixed(2)) * 100),
                currency: payment.currency,
            });
            await prisma.paymentTransaction.update({ where: { id: payment.id }, data: { gatewayRef: intentId } });
            linked += 1;
            console.log(`✔ ${orderId}  ${payment.amount.toFixed(2)} ${payment.currency} → ${intentId}`);
        } catch (error) {
            console.log(`✖ ${orderId}  ${(error as Error).message}`);
        }
    }
    console.log(`\n${linked} order(s) now have a real Stripe test charge. Press Process on their refunds without a gatewayRefundId.`);
}

main()
    .catch((error) => {
        console.error('✖', (error as Error).message);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signature verification, implemented directly.
 *
 * This is the security boundary of the entire payments module. The endpoint it
 * guards can mark any order paid, so "did Stripe actually send this?" has to
 * be answered before anything else happens — and answered by cryptography, not
 * by trusting a field in the body.
 *
 * The scheme (Stripe's `Signature` header, v1):
 *
 *     Stripe-Signature: t=1699999999,v1=5257a86…,v1=<older key's signature>
 *     signed_payload   = "{t}.{raw request body}"
 *     expected         = HMAC-SHA256(signed_payload, signing_secret)
 *
 * Three things this does that a naive version gets wrong, all of which are
 * real vulnerabilities rather than style points:
 *
 *   **It hashes the raw bytes.** `JSON.stringify(req.body)` is not the request
 *   body — key order, whitespace and unicode escaping all differ — so a
 *   re-serialised payload never matches, and the usual "fix" is to stop
 *   verifying. `app.ts` captures `req.rawBody` for exactly this.
 *
 *   **It compares in constant time.** `===` on a hex digest leaks, through
 *   timing, how many leading characters an attacker guessed right, which turns
 *   forging a signature into a few thousand requests.
 *
 *   **It enforces a timestamp window.** Without it a delivery captured once is
 *   replayable forever, signature and all. The idempotency table stops the
 *   *same* event being processed twice, but this is what stops an old, valid,
 *   captured event being fed back in at a chosen moment.
 */

export interface VerifyResult {
    verified: boolean;
    /** Why it failed, for the log and the stored webhook row. */
    reason?: 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'TIMESTAMP_OUT_OF_RANGE' | 'NO_MATCH';
    timestamp?: number;
}

/** Parses `t=…,v1=…,v1=…` into its parts, tolerating unknown fields. */
function parseSignatureHeader(header: string): { timestamp: number | null; signatures: string[] } {
    let timestamp: number | null = null;
    const signatures: string[] = [];

    for (const part of header.split(',')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key === 't') {
            const parsed = Number.parseInt(value, 10);
            timestamp = Number.isFinite(parsed) ? parsed : null;
        } else if (key === 'v1') {
            signatures.push(value);
        }
    }
    return { timestamp, signatures };
}

/** Constant-time hex comparison that does not throw on a length mismatch. */
function matches(expected: string, candidate: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function verifyStripeSignature(input: {
    rawBody: Buffer | string;
    signatureHeader: string | undefined;
    secret: string;
    /** Seconds. Stripe's own default is 300. */
    toleranceSeconds: number;
    /** Injectable for tests; defaults to now. */
    now?: Date;
}): VerifyResult {
    if (!input.signatureHeader) return { verified: false, reason: 'MISSING_HEADER' };

    const { timestamp, signatures } = parseSignatureHeader(input.signatureHeader);
    if (timestamp === null || signatures.length === 0) {
        return { verified: false, reason: 'MALFORMED_HEADER' };
    }

    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    // Both directions: a timestamp far in the future is as suspect as an old
    // one, and rejecting only the past would let a forged future timestamp sit
    // valid indefinitely.
    if (Math.abs(nowSeconds - timestamp) > input.toleranceSeconds) {
        return { verified: false, reason: 'TIMESTAMP_OUT_OF_RANGE', timestamp };
    }

    const payload = Buffer.concat([
        Buffer.from(`${timestamp}.`, 'utf8'),
        typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody,
    ]);
    const expected = createHmac('sha256', input.secret).update(payload).digest('hex');

    // Stripe sends one v1 per active signing secret during a key rotation, so
    // any match counts. Every candidate is compared — no early return — so the
    // number of comparisons does not depend on which one matched.
    let verified = false;
    for (const candidate of signatures) {
        if (matches(expected, candidate)) verified = true;
    }

    return verified ? { verified: true, timestamp } : { verified: false, reason: 'NO_MATCH', timestamp };
}

import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { verifyStripeSignature } from '../src/domain/webhook-signature';

const SECRET = 'whsec_test_secret_value';
const NOW = new Date('2026-09-16T12:00:00Z');

function sign(body: string, secret = SECRET, at = NOW): string {
    const timestamp = Math.floor(at.getTime() / 1000);
    const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return `t=${timestamp},v1=${signature}`;
}

const BODY = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

/**
 * This endpoint can mark any order paid, so these are the tests that matter
 * most in the module. Each one corresponds to a way the check could be wrong
 * in a way that still "works" in development.
 */
describe('verifyStripeSignature', () => {
    it('accepts a correctly signed payload', () => {
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: sign(BODY),
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(true);
    });

    it('accepts the raw bytes as a Buffer, exactly as Express captured them', () => {
        const result = verifyStripeSignature({
            rawBody: Buffer.from(BODY, 'utf8'),
            signatureHeader: sign(BODY),
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(true);
    });

    /**
     * The whole point: a body that changed after signing must not verify, even
     * by one character.
     */
    it('rejects a tampered body', () => {
        const header = sign(BODY);
        const tampered = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', x: 1 });

        const result = verifyStripeSignature({
            rawBody: tampered,
            signatureHeader: header,
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('NO_MATCH');
    });

    it('rejects a signature made with a different secret', () => {
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: sign(BODY, 'whsec_someone_elses_secret'),
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('NO_MATCH');
    });

    /**
     * Without the timestamp window, a delivery captured once is replayable
     * forever, signature and all.
     */
    it('rejects a delivery older than the tolerance window', () => {
        const old = new Date(NOW.getTime() - 10 * 60 * 1000);
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: sign(BODY, SECRET, old),
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('TIMESTAMP_OUT_OF_RANGE');
    });

    it('rejects a timestamp far in the future too', () => {
        const future = new Date(NOW.getTime() + 10 * 60 * 1000);
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: sign(BODY, SECRET, future),
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('TIMESTAMP_OUT_OF_RANGE');
    });

    it('rejects a missing header', () => {
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: undefined,
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('MISSING_HEADER');
    });

    it('rejects a malformed header', () => {
        for (const header of ['', 'garbage', 't=abc,v1=xyz', 'v1=onlysignature']) {
            const result = verifyStripeSignature({
                rawBody: BODY,
                signatureHeader: header,
                secret: SECRET,
                toleranceSeconds: 300,
                now: NOW,
            });
            expect(result.verified).toBe(false);
        }
    });

    /** Stripe sends one v1 per active secret during a key rotation. */
    it('accepts when any of several v1 signatures matches', () => {
        const valid = sign(BODY);
        const timestamp = valid.split(',')[0];
        const good = valid.split('v1=')[1];
        const header = `${timestamp},v1=${'0'.repeat(64)},v1=${good}`;

        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: header,
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(true);
    });

    it('does not throw on a signature of the wrong length', () => {
        const timestamp = Math.floor(NOW.getTime() / 1000);
        const result = verifyStripeSignature({
            rawBody: BODY,
            signatureHeader: `t=${timestamp},v1=short`,
            secret: SECRET,
            toleranceSeconds: 300,
            now: NOW,
        });
        expect(result.verified).toBe(false);
    });
});

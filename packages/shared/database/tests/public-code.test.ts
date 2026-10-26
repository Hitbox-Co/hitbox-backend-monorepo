import { describe, expect, it } from 'vitest';
import {
    PUBLIC_CODE_PREFIXES,
    generatePublicCode,
    publicCodeIssuedAt,
} from '../src/public-code';

/** Crockford Base32, lowercase, minus i/l/o/u. */
const BODY = /^[0-9abcdefghjkmnpqrstvwxyz]{19}$/;

describe('shape', () => {
    it('is prefix + 19 characters', () => {
        const code = generatePublicCode('odr');
        expect(code).toHaveLength(22);
        expect(code.slice(0, 3)).toBe('odr');
        expect(code.slice(3)).toMatch(BODY);
    });

    it('fits the VARCHAR(32) column with room to spare', () => {
        expect(generatePublicCode('odr').length).toBeLessThanOrEqual(32);
    });

    it('never emits i, l, o or u in the generated body', () => {
        // The whole point of Crockford: `1` vs `l` and `0` vs `O` are
        // indistinguishable read down a phone, and dropping `u` means a code
        // cannot spell an obscenity.
        //
        // The PREFIX is exempt — it is a chosen word, not generated, and `odr`
        // legitimately contains an `o`. Only the 19 generated characters are
        // constrained, so the bodies are what this checks.
        const bodies = Array.from({ length: 2000 }, () =>
            generatePublicCode('odr').slice(3),
        ).join('');
        expect(bodies).not.toMatch(/[ilou]/);
    });
});

describe('uniqueness', () => {
    it('produces no duplicates across 200k codes', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200_000; i += 1) seen.add(generatePublicCode('odr'));
        expect(seen.size).toBe(200_000);
    });

    it('produces no duplicates within a single millisecond', () => {
        // The case that actually matters: the timestamp is identical, so only
        // the 50 random bits separate these.
        const now = Date.now();
        const seen = new Set<string>();
        for (let i = 0; i < 50_000; i += 1) seen.add(generatePublicCode('odr', now));
        expect(seen.size).toBe(50_000);
    });
});

describe('the time component', () => {
    it('reads back the millisecond it was issued at', () => {
        const now = Date.now();
        expect(publicCodeIssuedAt(generatePublicCode('odr', now)).getTime()).toBe(now);
    });

    it('sorts codes chronologically as plain strings', () => {
        const early = generatePublicCode('odr', Date.UTC(2026, 0, 1));
        const later = generatePublicCode('odr', Date.UTC(2026, 6, 1));
        expect(early < later).toBe(true);
    });

    it('still encodes a date a century out', () => {
        const far = Date.UTC(2125, 0, 1);
        expect(publicCodeIssuedAt(generatePublicCode('odr', far)).getTime()).toBe(far);
    });

    it('rejects a malformed code rather than returning a wrong date', () => {
        expect(() => publicCodeIssuedAt('odrIIIIIIIII0000000000')).toThrow();
    });
});

describe('the prefix registry', () => {
    it('covers every table with a distinct prefix', () => {
        const prefixes = Object.values(PUBLIC_CODE_PREFIXES);
        expect(new Set(prefixes).size).toBe(prefixes.length);
    });

    it('uses three lowercase letters throughout', () => {
        for (const prefix of Object.values(PUBLIC_CODE_PREFIXES)) {
            expect(prefix).toMatch(/^[a-z]{3}$/);
        }
    });

    it('matches the examples that were asked for', () => {
        expect(PUBLIC_CODE_PREFIXES.Order).toBe('odr');
        expect(PUBLIC_CODE_PREFIXES.Invoice).toBe('inv');
    });
});

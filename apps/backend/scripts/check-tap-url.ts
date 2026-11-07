/**
 * Offline check of a real tag URL: does it decrypt, and does its MAC match?
 *
 *   pnpm --filter @hitbox/backend exec tsx scripts/check-tap-url.ts "<url read from the tag>" [secrets-file]
 *
 * Reads Key 00/01/02 and the chip UID from scripts/secrets/nfc-test-tag.json, or
 * from the file you name (e.g. scripts/secrets/nfc-test-tag-pertag.json for a
 * per-tag chip). Both are git-ignored. Touches NO database and NO server, so it cannot use up the
 * chip's counter: reading a tag with any NFC reader just raises the chip's own
 * counter, and the server accepts any value higher than the last one it saw.
 *
 * What it tells you, step by step:
 *   1. e decrypts under Key 01        → the PICC key is right
 *   2. UID inside e is your chip      → the right chip, right batch
 *   3. c matches under Key 02         → the CMAC key is right AND the tag signs
 *                                       an empty input, which is what the server
 *                                       computes
 * When a step fails it also tries your other keys, to show if two were swapped
 * or the chip still has its factory (all-zero) keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSdmMac, decryptPicc, verifySdmMac } from '@hitbox/skus';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
if (!url) {
    console.error('Usage: tsx scripts/check-tap-url.ts "<url read from the tag>"');
    process.exit(2);
}

const input = JSON.parse(readFileSync(resolve(here, process.argv[3] ?? 'secrets/nfc-test-tag.json'), 'utf8')) as Record<string, string>;
const key = (name: string) => Buffer.from((input[name] ?? '').replace(/[\s:-]/g, ''), 'hex');
const keys: Record<string, Buffer> = {
    'Key 00 (master)': key('key0'),
    'Key 01 (PICC)': key('key1'),
    'Key 02 (CMAC)': key('key2'),
    'factory all-zero key': Buffer.alloc(16),
};
const expectedUid = (input.tagUid ?? '').replace(/[\s:-]/g, '').toUpperCase();
const PICC = keys['Key 01 (PICC)']!;
const CMAC = keys['Key 02 (CMAC)']!;

// ── read the three values (same spellings the app accepts) ────────────────────
const query = url.split('#')[0]!.split('?')[1] ?? '';
const params = new Map<string, string>();
for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) params.set(pair.slice(0, eq).toLowerCase(), decodeURIComponent(pair.slice(eq + 1)));
}
const first = (...names: string[]) => names.map((n) => params.get(n)).find((v) => v !== undefined);
const b = first('b');
const u = first('u');
const e = first('e', 'picc', 'picc_data', 'piccdata');
const c = first('c', 'cmac');

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
let failed = false;

console.log(`\nURL: ${url.replace(/(e|picc|picc_data|c|cmac)=[0-9a-f]+/gi, '$1=…')}`);
console.log(b !== undefined ? `b = ${b}` : `u present: ${u ? 'yes' : 'no (missing)'}`);

if (!e || !/^[0-9a-f]{32}$/i.test(e)) {
    bad(`PICC data (e / picc) is missing or not 32 hex characters${e ? ` (got ${e.length})` : ''}`);
    if (e && /^0+$/.test(e)) bad('it is all zeros: SDM mirroring is not switched on, this is the template');
    process.exit(1);
}
if (!c || !/^[0-9a-f]{16}$/i.test(c)) {
    bad(`CMAC (c / cmac) is missing or not 16 hex characters${c ? ` (got ${c.length})` : ''}`);
    if (c && /^0+$/.test(c)) bad('it is all zeros: SDM mirroring is not switched on, this is the template');
    process.exit(1);
}

// ── 1. decrypt e ─────────────────────────────────────────────────────────────
console.log('\n1. Decrypt e (PICC data)');
const picc = decryptPicc(e, PICC);
if (picc) {
    ok(`decrypts under Key 01 → UID ${picc.uidHex}, counter ${picc.counter}`);
} else {
    failed = true;
    bad('does not decrypt under Key 01');
    for (const [name, k] of Object.entries(keys)) {
        const p = decryptPicc(e, k);
        if (p && k !== PICC) {
            bad(
                name.startsWith('factory')
                    ? '...but it DOES decrypt under the factory all-zero key → the chip still has its factory keys; Key 01 was never written to it'
                    : `...but it DOES decrypt under ${name} → the PICC data key slot is wrong`,
            );
        }
    }
}

// ── 2. is it your chip ───────────────────────────────────────────────────────
if (picc) {
    console.log('\n2. Which chip');
    if (u !== undefined && u.toUpperCase() !== picc.uidHex) {
        failed = true;
        bad('u in the URL differs from the UID inside e (the server answers UID_MISMATCH)');
    }
    if (expectedUid && picc.uidHex === expectedUid) ok(`UID matches your registered chip (${expectedUid})`);
    else {
        failed = true;
        bad(`UID ${picc.uidHex} is not the registered chip (${expectedUid || 'none in the secrets file'})`);
    }
}

// ── 3. the MAC ───────────────────────────────────────────────────────────────
console.log('\n3. Check c (CMAC)');
if (picc) {
    if (verifySdmMac(c, CMAC, picc)) {
        ok('matches under Key 02, signing an empty input, exactly as the server computes it');
    } else {
        failed = true;
        bad('does NOT match under Key 02');
        const expected = computeSdmMac(CMAC, picc).toString('hex').toUpperCase();
        console.log(`    server would expect c = ${expected}`);
        console.log(`    the tag gave          c = ${c.toUpperCase()}`);
        for (const [name, k] of Object.entries(keys)) {
            if (k !== CMAC && verifySdmMac(c, k, picc)) {
                bad(
                    name.startsWith('factory')
                        ? '...but it DOES match under the factory all-zero key → Key 02 was never written to the chip'
                        : `...but it DOES match under ${name} → the CMAC key slot is wrong`,
                );
            }
        }
        console.log('    If every key above is right, the tag is probably signing part of the URL');
        console.log('    instead of an empty input (MAC input offset ≠ MAC offset). The server');
        console.log('    only accepts a MAC over empty input.');
    }
}

console.log(failed ? '\nRESULT: the server would REFUSE this tap.\n' : '\nRESULT: the server would ACCEPT this tap (if its counter is higher than the last one seen).\n');
process.exit(failed ? 1 : 0);

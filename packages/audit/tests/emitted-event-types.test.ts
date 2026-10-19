import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isKnownAuditEventType } from '../src/domain/audit-event-catalog';

/**
 * Recording an event type that is not in the catalog fails at runtime (the
 * recorder throws, and `AuditEvent.eventType` is a foreign key to the seeded
 * catalog), rolling back whatever transaction was recording it. Unit tests
 * with a fake recorder cannot see that, so this scans every module's
 * `*_AUDIT_EVENTS` constant and requires each value to be registered.
 */
/**
 * Types other modules already emit without a catalog row. They pre-date this
 * check and are not fixed here; the list may only shrink, so a NEW unregistered
 * type still fails.
 */
const KNOWN_UNREGISTERED = new Set([
    'audit.retention-policy.changed',
    'audit.write.dropped',
    'tax.adjustment.approve',
    'tax.artist-document.download',
    'tax.artist-document.review',
    'tax.configuration.change',
    'tax.filing.create',
    'tax.filing.file',
    'tax.invoice.download',
    'tax.invoice.issue',
    'tax.invoice.void',
]);

const packagesDir = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (name === 'node_modules') return [];
        return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
    });
}

function emittedTypes(): { file: string; type: string }[] {
    const found: { file: string; type: string }[] = [];
    for (const pkg of readdirSync(packagesDir)) {
        const src = path.join(packagesDir, pkg, 'src');
        try {
            if (!statSync(src).isDirectory()) continue;
        } catch {
            continue;
        }
        for (const file of sourceFiles(src)) {
            const text = readFileSync(file, 'utf8');
            const blocks = text.matchAll(/export const \w*AUDIT_EVENTS\s*=\s*\{([\s\S]*?)\}\s*as const/g);
            for (const block of blocks) {
                for (const value of block[1]!.matchAll(/:\s*'([a-z0-9_.-]+)'/g)) {
                    found.push({ file: path.relative(packagesDir, file), type: value[1]! });
                }
            }
        }
    }
    return found;
}

describe('emitted audit event types', () => {
    const emitted = emittedTypes();

    it('finds the constants it is meant to check', () => {
        const types = emitted.map((e) => e.type);
        expect(types).toEqual(
            expect.arrayContaining(['royalty.payout.approve', 'royalty.payout.reject', 'drop.pricing.create']),
        );
    });

    it('registers every emitted event type in the catalog', () => {
        const missing = emitted.filter(
            (e) => !isKnownAuditEventType(e.type) && !KNOWN_UNREGISTERED.has(e.type),
        );
        expect(missing).toEqual([]);
    });
});

import { AppError } from '@hitbox/shared';
import { AUDIT_ERROR_CODES } from '../constants/audit.constant';
import type { AuditEventCursor } from '../repository/audit-event.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The keyset position, as an opaque string for the client.
 *
 * Opaque on purpose: it is `(occurredAt, eventId)`, which is the primary key's
 * ordering, and clients that learn to construct one start paging by
 * hand-rolled timestamps and skip rows. Encoded, not signed — it carries no
 * authority, and the query it resumes is re-authorised and re-scoped on every
 * request, so a forged cursor can only move a reader around inside the trail
 * they were already allowed to read.
 */
export function encodeCursor(cursor: AuditEventCursor): string {
    const payload = JSON.stringify({
        o: cursor.occurredAt.toISOString(),
        e: cursor.eventId,
    });
    return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): AuditEventCursor {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        throw invalidCursor();
    }

    if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
    const { o, e } = parsed as { o?: unknown; e?: unknown };
    if (typeof o !== 'string' || typeof e !== 'string') throw invalidCursor();

    const occurredAt = new Date(o);
    if (Number.isNaN(occurredAt.getTime())) throw invalidCursor();

    // eventId reaches a uuid column. Rejected here rather than at the
    // database, where a non-uuid string is a 500 from a cast failure instead
    // of the 400 a malformed cursor deserves.
    if (!UUID.test(e)) throw invalidCursor();

    return { occurredAt, eventId: e };
}

function invalidCursor(): AppError {
    return AppError.badRequest(
        'That cursor is not one this API issued. Start the query again without a cursor.',
        AUDIT_ERROR_CODES.INVALID_CURSOR,
    );
}

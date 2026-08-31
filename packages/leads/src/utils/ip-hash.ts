import { createHash } from 'node:crypto';

/**
 * One-way hash of the client IP — never store the raw address (docs
 * §2.6: "ipHash — hash it, do not store the raw address"). Salted with a
 * server-side secret so the hash isn't reversible via a rainbow table of
 * the (small) IPv4/IPv6 address space; the salt does NOT need to be a
 * managed secret — its only job is to make precomputed-table attacks
 * pointless, not to gate access — but it must stay stable so the same
 * visitor hashes the same way across requests (e.g. for rate-limit/abuse
 * correlation without ever retaining the address itself).
 */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
    if (!ip) return null;
    return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/** First hop of X-Forwarded-For, falling back to the socket address. */
export function extractClientIp(req: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
    socket?: { remoteAddress?: string };
}): string | null {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return first?.trim() || req.ip || req.socket?.remoteAddress || null;
}

import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CORRELATION_ID_HEADER = 'x-correlation-id';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * Stitches every audit event from this request together. Present on
             * every request once `correlationId()` is mounted, so an audit call
             * site never has to invent one — and never has to decide whether to
             * skip the field.
             */
            correlationId?: string;
        }
    }
}

export interface CorrelationIdOptions {
    /**
     * Adopt a valid `x-correlation-id` from the request instead of generating
     * one.
     *
     * Off by default, and it should stay off at the edge. A client that
     * chooses its own correlation id can attach its requests to someone
     * else's — or reuse one id forever, so that every audit query for that
     * correlation returns an unusable pile. Turn it on only for a trusted
     * internal hop (a gateway, or a job runner continuing a traced request),
     * behind whatever authenticates that hop.
     */
    trustInboundHeader?: boolean;
}

/**
 * Assigns a correlation id and echoes it back.
 *
 * Mount this first, ahead of authentication: a DENIED authorization result is
 * one of the most useful things in the trail, and it happens before the
 * request has an identity, so the id has to exist before anything can fail.
 */
export function correlationId(options: CorrelationIdOptions = {}): RequestHandler {
    return (req, res, next) => {
        const inbound = req.header(CORRELATION_ID_HEADER);
        const adopted =
            options.trustInboundHeader && inbound && UUID.test(inbound) ? inbound : undefined;

        req.correlationId = adopted ?? randomUUID();
        res.setHeader(CORRELATION_ID_HEADER, req.correlationId);
        next();
    };
}

/**
 * The request's correlation id, or a fresh one.
 *
 * The fallback is not laziness: an audit write must never fail because a route
 * was mounted without the middleware. A one-off id leaves that event harder to
 * join — a correlation with exactly one row in it — which is strictly better
 * than not recording the event at all, and is itself the signal that a route
 * is missing the middleware.
 */
export function correlationIdOf(req: { correlationId?: string }): string {
    return req.correlationId ?? randomUUID();
}

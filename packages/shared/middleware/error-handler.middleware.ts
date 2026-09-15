import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';
import { logger } from '../logger';
import { isProduction } from '../config/env';


interface ErrorBody {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}

/**
 * Reports the type of the value that failed validation, and a short preview
 * of it, so `"Expected number, received string"` comes with the string.
 *
 * Deliberately not the whole value: a body can be large, and a validation
 * error on a token or an address should not echo it back into logs and browser
 * consoles. 60 characters is enough to recognise `"500"` or `"2026-13-45"`.
 */
function describeReceived(
    path: (string | number)[],
    body: unknown,
): { receivedType?: string; received?: string } {
    if (path.length === 0 || body === undefined || body === null) return {};

    let cursor: unknown = body;
    for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return {};
        cursor = (cursor as Record<string | number, unknown>)[key];
    }
    if (cursor === undefined) return { receivedType: 'undefined' };

    const receivedType = cursor === null ? 'null' : Array.isArray(cursor) ? 'array' : typeof cursor;
    if (cursor === null || typeof cursor === 'object') return { receivedType };

    const preview = String(cursor);
    return {
        receivedType,
        received: preview.length > 60 ? `${preview.slice(0, 60)}…` : preview,
    };
}

/** 404 for unmatched routes — mount after all routers. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
    next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
}


/**
 * Single error boundary of the app — mount LAST.
 */
export function errorHandler(
    error: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    // Zod validation errors → 422 with field-level details
    if (error instanceof ZodError) {
        // A root-level "Required" means the schema was handed `undefined`,
        // which for a body-parsing route means Express never parsed a body at
        // all. Express 5 leaves `req.body` undefined (v4 gave `{}`), so the
        // most common cause — a missing or wrong Content-Type — surfaced as an
        // unreadable 422 pointing at no field. Say what actually happened.
        const bodyMissing =
            req.body === undefined &&
            error.issues.some((issue) => issue.path.length === 0 && issue.code === 'invalid_type');

        if (bodyMissing) {
            res.status(400).json({
                error: {
                    code: 'BODY_REQUIRED',
                    message:
                        'No request body was parsed. Send a JSON body with ' +
                        'Content-Type: application/json.',
                    details: {
                        contentType: req.headers['content-type'] ?? null,
                        hint:
                            req.headers['content-type']
                                ? 'The Content-Type is not application/json, so the JSON body parser skipped this request.'
                                : 'No Content-Type header was sent.',
                    },
                },
            } satisfies ErrorBody);
            return;
        }

        const body: ErrorBody = {
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: error.issues.map((issue) => ({
                    path: issue.path.join('.'),
                    message: issue.message,
                    code: issue.code,
                    // What arrived, so the client can see the mismatch without
                    // guessing. Only the *type* and a short preview — never the
                    // whole value, which may be large or sensitive.
                    ...describeReceived(issue.path, req.body),
                })),
            },
        };
        res.status(422).json(body);
        return;
    }

    // Known, operational errors
    if (error instanceof AppError && error.isOperational) {
        logger.warn({ code: error.code, path: req.path }, error.message);
        const body: ErrorBody = {
            error: { code: error.code, message: error.message, details: error.details },
        };
        res.status(error.statusCode).json(body);
        return;
    }

    // Bugs / unknown errors: log everything
    logger.error({ err: error, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: isProduction ? 'Something went wrong' : String(error),
        },
    } satisfies ErrorBody);
}
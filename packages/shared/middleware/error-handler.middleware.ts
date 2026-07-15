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
        const body: ErrorBody = {
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: error.issues.map((issue) => ({
                    path: issue.path.join('.'),
                    message: issue.message,
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
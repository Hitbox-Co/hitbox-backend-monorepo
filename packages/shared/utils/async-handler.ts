import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
) => Promise<unknown>;

/**
 * Wraps an async route handler so rejections reach the error middleware.
 * (Express 5 does this natively; the wrapper keeps handlers uniform and
 * typings happy while @types/express is still v4.)
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
    return (req, res, next) => {
        handler(req, res, next).catch(next);
    };
}

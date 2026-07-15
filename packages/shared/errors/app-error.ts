export class AppError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number = 500,
        public readonly code: string = 'INTERNAL_ERROR',
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'AppError';
        Error.captureStackTrace(this, this.constructor);
    }

    get isOperational(): boolean {
        return this.statusCode < 500;
    }

    static badRequest(
        message: string,
        code = 'BAD_REQUEST',
        details?: unknown
    ): AppError {
        return new AppError(message, 400, code, details);
    }

    static unauthorized(
        message = 'Authentication required',
        code = 'UNAUTHENTICATED'
    ): AppError {
        return new AppError(message, 401, code);
    }

    static forbidden(
        message = 'Insufficient permissions',
        code = 'FORBIDDEN'
    ): AppError {
        return new AppError(message, 403, code);
    }

    static notFound(
        message = 'Resource not found',
        code = 'NOT_FOUND'
    ): AppError {
        return new AppError(message, 404, code);
    }

    static tooManyRequests(
        message = 'Too many requests, please try again later',
        code = 'RATE_LIMITED',
        details?: unknown,
    ): AppError {
        return new AppError(message, 429, code, details);
    }

    static conflict(
        message: string,
        code = 'CONFLICT',
        details?: unknown
    ): AppError {
        return new AppError(message, 409, code, details);
    }
}
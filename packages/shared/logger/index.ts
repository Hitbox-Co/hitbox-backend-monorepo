import pino, { type Logger } from 'pino';
import { env, isDevelopment } from '../config/env';

export const logger: Logger = pino({
    level: env.LOG_LEVEL,
    base: { service: 'hitbox-backend' },
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.token',
            '*.secret',
        ],
        censor: '[REDACTED]',
    },
    ...(isDevelopment
        ? {
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
        }
        : {}),
});

export function createModuleLogger(module: string): Logger {
    return logger.child({ module });
}

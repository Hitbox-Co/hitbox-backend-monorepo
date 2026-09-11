/**
 * Runs before any module import. @hitbox/shared validates process.env at
 * import time and exits on failure, so the required vars must exist here.
 * Values are dummies — no test in this package touches a real database.
 */
process.env.NODE_ENV = 'production'; // avoids the pino-pretty dev transport
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';

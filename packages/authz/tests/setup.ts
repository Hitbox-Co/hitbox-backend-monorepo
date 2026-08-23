/**
 * Runs before any module import. @hitbox/shared validates process.env at
 * import time and exits on failure, so the required vars must exist here.
 * Values are dummies — no test touches a real DB, Redis or Clerk.
 */
process.env.NODE_ENV = 'production'; // avoids the pino-pretty dev transport in tests
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
process.env.CLERK_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
// No REDIS_URL: the permission cache degrades to its in-process tier, which is
// exactly what we want to exercise deterministically.
delete process.env.REDIS_URL;

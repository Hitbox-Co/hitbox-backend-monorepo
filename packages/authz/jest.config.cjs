/**
 * Jest config for @hitbox/authz. Mirrors @hitbox/auth: ESM TypeScript source
 * compiled to CommonJS through ts-jest so `jest.mock` hoisting behaves, and
 * workspace deps (which live outside node_modules) are transformed too.
 */
/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    setupFiles: ['<rootDir>/tests/setup.ts'],
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
};

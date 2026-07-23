/**
 * Jest config for @hitbox/auth.
 *
 * The package ships as ESM TypeScript, but tests compile through ts-jest to
 * CommonJS so `jest.mock` hoisting behaves normally (no ESM loader gymnastics).
 * Workspace deps (@hitbox/shared) resolve to real paths under packages/* — i.e.
 * outside node_modules — so they are transformed too.
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

/**
 * Jest config for @hitbox/tax.
 *
 * Same shape as @hitbox/finance: the package ships as ESM TypeScript, tests
 * compile through ts-jest to CommonJS so `jest.mock` hoisting behaves normally.
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

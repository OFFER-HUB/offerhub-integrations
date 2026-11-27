/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/packages'],
    testMatch: ['**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    moduleNameMapper: {
        '^@offerhub/sdk$': '<rootDir>/packages/sdk/src',
        '^@offerhub-orchestrator/adapter-trustlesswork$': '<rootDir>/packages/adapter-trustlesswork/src',
        '^@offerhub-orchestrator/adapter-blindpay$': '<rootDir>/packages/adapter-blindpay/src',
        // ky is ESM-only; tests never reach the network, so a stub is enough
        '^ky$': '<rootDir>/tests/mocks/ky.mock.js',
        // Handle .js extensions in relative TypeScript imports (ESM style)
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    target: 'ES2022',
                    module: 'CommonJS',
                    moduleResolution: 'node',
                    esModuleInterop: true,
                    experimentalDecorators: true,
                    emitDecoratorMetadata: true,
                    strict: true,
                    skipLibCheck: true,
                },
            },
        ],
    },
    transformIgnorePatterns: ['node_modules/(?!(ky)/)'],
    verbose: true,
};

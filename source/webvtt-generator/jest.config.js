module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: [
        '**/*.js',
        '!jest.config.js',
        '!coverage/**',
        '!node_modules/**'
    ],
    coverageReporters: [
        'text',
        'lcov',
        'html'
    ],
    coverageDirectory: 'coverage',
    testMatch: [
        '**/*.spec.js',
        '**/*.test.js'
    ],
    verbose: true
};
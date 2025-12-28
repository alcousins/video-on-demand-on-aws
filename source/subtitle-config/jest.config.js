module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: [
        '**/*.js',
        '!jest.config.js',
        '!coverage/**'
    ],
    coverageReporters: [
        'text',
        'lcov'
    ]
};
/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: ['lib/**/*.js'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov']
};

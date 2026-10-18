module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/src/test/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist-check/'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/test/**'],
  // The first render in a file pays the cold Babel transform of the whole navigation tree (tens of seconds on CI).
  testTimeout: 30000,
  // React Native's VirtualizedList schedules batching timers that outlive the test and keep Jest's process alive.
  forceExit: true,
};

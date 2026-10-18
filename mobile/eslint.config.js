// Flat ESLint config: Expo's recommended rules plus a few that matter for this app's safety goals.
const expo = require('eslint-config-expo/flat');

module.exports = [
  ...expo,
  { ignores: ['dist/', 'dist-check/', '.expo/', 'node_modules/', 'coverage/'] },
  {
    rules: {
      // Secrets and tokens must never reach the console directly; use src/core/logger.ts (redacting).
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    // The logger is the one place allowed to touch the console.
    files: ['src/core/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Node scripts run in CI, not in the app: console output is their interface.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**'],
    rules: { 'no-console': 'off' },
  },
];

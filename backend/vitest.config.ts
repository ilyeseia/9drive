import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    // Postgres/Redis live behind an SSH tunnel (~66ms per round trip), so
    // burst-style tests need far more headroom than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
})

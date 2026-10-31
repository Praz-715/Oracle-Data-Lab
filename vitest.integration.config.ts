import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Integration tests run against a real Oracle test database configured through ODL_TEST_* env vars.
export default defineConfig({
  resolve: {
    alias: { '~~': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
})

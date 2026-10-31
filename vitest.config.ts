import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests cover pure server logic (generators, DDL, histograms) and need no database.
export default defineConfig({
  resolve: {
    alias: { '~~': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})

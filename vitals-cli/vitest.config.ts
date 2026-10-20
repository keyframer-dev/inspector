import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [{ find: '@keyframerdev/inspector-protocol/vitals', replacement: path.resolve(__dirname, '../protocol/vitals.ts') }],
  },
  test: { include: ['src/**/*.test.ts'], globals: false, testTimeout: 30000 },
})

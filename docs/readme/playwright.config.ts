import { defineConfig } from '@playwright/test'

// Regenerates the README images. Not part of `npm run smoke`: run it with
// `npm run readme:shots`, which builds the test-seam dist first and the plain
// dist after.
export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  timeout: 600_000,
  workers: 1,
  reporter: [['list']],
})

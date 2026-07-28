import { defineConfig } from 'vitest/config'

// vitest's testTimeout is WALL CLOCK, and it keeps running while a worker is
// descheduled. This suite fans 32 files across two projects onto ncpu workers, and
// the jsdom/React files inflate ~10x under that contention (measured: FieldRow
// 210ms alone -> 2250ms in a full run; App 416ms -> 3665ms). The 5s default leaves
// no headroom on a loaded machine, where purely synchronous render tests were
// observed failing with "Test timed out in 5000ms". 20s cannot mask a real hang
// (nothing here asserts a deadline); it only stops scheduling noise failing a
// green suite.
const TIMEOUTS = { testTimeout: 20_000, hookTimeout: 20_000 }

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['host/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
          ...TIMEOUTS,
        },
      },
      {
        // The panel's compile-time test-seam flag (see Task 18); vite build defines
        // it from the JFF_TEST_SEAM env var, unit tests always have the seam on.
        define: { __JFF_TEST_SEAM__: 'true' },
        test: {
          name: 'extension',
          environment: 'jsdom',
          // .tsx too, or React component tests are silently never collected.
          include: ['extension/src/**/*.test.{ts,tsx}'],
          // globals:true registers the afterEach hook @testing-library/react needs
          // for auto-cleanup; without it every render leaks into the next test.
          globals: true,
          ...TIMEOUTS,
        },
      },
    ],
  },
})

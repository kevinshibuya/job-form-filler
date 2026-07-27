import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['host/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
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
        },
      },
    ],
  },
})

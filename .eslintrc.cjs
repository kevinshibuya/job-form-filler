/* ESLint 8 classic config. `root: true` stops any cascade above this repo.
   No type-aware rules, so no `project` and no per-workspace tsconfig wiring. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  env: { es2022: true, browser: true, node: true },
  ignorePatterns: ['**/dist/', '**/dist-types/', 'node_modules/', '**/*.d.ts'],
  rules: {},
  overrides: [
    {
      // The host is the ONE workspace where a stray stdout write corrupts the
      // native-messaging channel irrecoverably. host/src/index.ts opts out of the
      // stdout rule with a file-level `/* eslint-disable no-restricted-properties */`
      // (Task 11 Step 9); it is the only file allowed to write frames.
      files: ['host/src/**/*.ts'],
      rules: {
        'no-console': 'error',
        'no-restricted-properties': ['error', {
          object: 'process',
          property: 'stdout',
          message: 'Only host/src/index.ts may write to stdout, and only via encodeMessage().',
        }],
      },
    },
  ],
}

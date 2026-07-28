import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // MEASURED, not guessed. Every test launches its own Chromium with the unpacked
  // extension, and that launch is the step whose cost tracks machine load rather
  // than anything this code does. Same suite, same commit, back to back:
  //   idle   -> 11 passed in 1.7m; heaviest foundation test 4.7s
  //   loaded -> 2 failed in 6.5m;  that same test 31.4s, i.e. ~7x
  // At 60s the launch alone could consume half the budget, so a loaded machine
  // failed tests that pass every time in isolation. 180s restores real headroom.
  // This cannot mask a hang: nothing in the suite asserts a deadline, and the
  // per-assertion timeouts below each spec remain the actual behavioural budgets.
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})

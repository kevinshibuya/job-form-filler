import { test, expect } from '@playwright/test'
import { launchWithExtension, panelUrl } from './ext'

test('the panel connects through its port layer and renders a green self-check, with zero console errors', async () => {
  const ext = await launchWithExtension()
  try {
    const panel = await ext.context.newPage()
    // The fake-host flag swaps connectNative for the in-page fake: native messaging
    // cannot be driven headlessly. It only exists in JFF_TEST_SEAM=1 builds; the
    // real handshake is the MANUAL Task 23 checklist.
    await panel.goto(panelUrl(ext.extensionId, '?jffFakeHost=1'))
    await expect(panel.locator('[data-jff-banner="ok"]')).toBeVisible()
    await expect(panel.locator('[data-jff-banner="ok"]')).toContainText('Host ready')
    await expect(panel.locator('[data-jff-tab]')).toBeVisible()
    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
  }
})

test('without the fake flag the panel reports the host as unreachable instead of hanging', async () => {
  const ext = await launchWithExtension()
  try {
    const panel = await ext.context.newPage()
    await panel.goto(panelUrl(ext.extensionId))
    // No native host is installed in the test profile, so connectNative fails fast
    // (twice: the retrying port re-attempts once with the same requestId).
    await expect(panel.locator('[data-jff-banner="error"]')).toContainText('Local host unreachable', { timeout: 15_000 })
  } finally {
    await ext.close()
  }
})

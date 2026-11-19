import { test, expect } from '@playwright/test'
import { launchWithExtension, panelUrl, settingsUrl, type LaunchedExtension } from './ext'

/**
 * The settings page in a real Chrome (spec #66, ticket #77): it loads, its root
 * renders, and the console holds no error. The Side panel's link opens it once
 * and then focuses it, and a step marked done survives a reload.
 */

let ext: LaunchedExtension

test.beforeAll(async () => {
  ext = await launchWithExtension()
})

test.afterAll(async () => {
  // Zero console errors across every test in this file.
  expect(ext.consoleErrors).toEqual([])
  await ext.close()
})

const settingsPages = () => ext.context.pages().filter((p) => p.url().startsWith(settingsUrl(ext.extensionId)))

test('the settings page loads, its root renders and the console holds no error', async () => {
  const page = await ext.context.newPage()
  await page.goto(settingsUrl(ext.extensionId))
  await expect(page.locator('[data-jff-settings-root]')).toBeVisible()
  await expect(page.locator('[data-jff-wizard-loaded]')).toBeVisible()
  await expect(page.locator('[data-jff-step]')).toHaveCount(8)
  expect(await page.title()).toBe('Mail · Settings · job-form-filler')

  // A step marked done is read back from the extension's real storage.
  const mark = page.locator('[data-jff-step="2"]').getByRole('switch')
  await mark.click()
  await expect(mark).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.locator('[data-jff-step="2"]').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await page.close()
  expect(ext.consoleErrors).toEqual([])
})

test('the Side panel link opens the settings page once, then focuses it', async () => {
  // ?tabId=-1 binds the panel to no tab, so it scans nothing (foundation.spec.ts).
  const panel = await ext.context.newPage()
  await panel.goto(panelUrl(ext.extensionId, '?tabId=-1'))
  const link = panel.getByRole('link', { name: 'Settings' })

  const opened = ext.context.waitForEvent('page', { predicate: (p) => p.url().startsWith(settingsUrl(ext.extensionId)) })
  await link.click()
  const settings = await opened
  await expect(settings.locator('[data-jff-settings-root]')).toBeVisible()
  expect(settingsPages()).toHaveLength(1)

  await panel.bringToFront()
  await link.click()
  await expect.poll(() => settings.evaluate(() => document.visibilityState)).toBe('visible')
  expect(settingsPages()).toHaveLength(1)
  await settings.close()
  await panel.close()
})

import { test, expect, chromium, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXT_DIST, panelUrl, type LaunchedExtension } from '../../e2e/ext'
import { seedOnboardedProfile, seedResume } from '../../e2e/seed'
import { startFixtureServer } from '../../e2e/static-server'
import { startHost } from '../../e2e/hostBridge'

/**
 * Takes the README images from the repo's own synthetic fixture form
 * (e2e/fixtures/greenhouse-apply/fixture-form.html), a throwaway Chromium
 * profile and a real host process wired to the fake `claude` and `codex` in
 * e2e/bin. The persona is the e2e one (Ada Lovelace). Nothing touches a real
 * Chrome profile or ~/.job-form-filler.
 *
 * Every image is a 1280 px wide composite at 2x, cropped to its subject. The
 * panel renders in the dark theme; the fixture form has no dark theme.
 */
const OUT = dirname(fileURLToPath(import.meta.url))
const PANEL_W = 420
const H = 820

async function launchDark(): Promise<LaunchedExtension> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'jff-shots-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    viewport: { width: 1280 - PANEL_W, height: H },
    args: [`--disable-extensions-except=${EXT_DIST}`, `--load-extension=${EXT_DIST}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(sw.url()).host
  return { context, extensionId, consoleErrors: [], close: () => context.close() }
}

async function tabIdForUrl(ext: LaunchedExtension, needle: string): Promise<number> {
  const lookup = await ext.context.newPage()
  await lookup.goto(`chrome-extension://${ext.extensionId}/manifest.json`)
  const id = await lookup.evaluate(async (n) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((t) => (t.url ?? '').includes(n))?.id ?? null
  }, needle)
  await lookup.close()
  if (id === null) throw new Error(`no tab matching ${needle}`)
  return id
}

/** Lays the page and the panel side by side, the way Chrome shows a side panel. */
async function compose(ext: LaunchedExtension, left: Buffer | null, right: Buffer, file: string, clip: 'all' | 'panel'): Promise<void> {
  const page = await ext.context.newPage()
  await page.setViewportSize({ width: 1280, height: H })
  const img = (b: Buffer, w: number) => `<img src="data:image/png;base64,${b.toString('base64')}" style="display:block;width:${w}px;height:${H}px">`
  await page.setContent(`<!doctype html><body style="margin:0;background:#0a0a0a">
    <div id="shot" style="display:flex;width:1280px">
      ${left ? img(left, 1280 - PANEL_W) : ''}
      <div id="panel" style="border-left:1px solid #333">${img(right, PANEL_W - 1)}</div>
    </div></body>`)
  const target = page.locator(clip === 'all' ? '#shot' : '#panel')
  writeFileSync(resolve(OUT, file), await target.screenshot())
  await page.close()
}

async function panelShot(panel: Page): Promise<Buffer> {
  await panel.setViewportSize({ width: PANEL_W - 1, height: H })
  return panel.screenshot()
}

test('README images', async () => {
  const fixtures = await startFixtureServer()
  const host = await startHost({ mode: 'ok' })
  const ext = await launchDark()
  try {
    // Onboarding wall: an empty profile and no resume.
    const blank = await ext.context.newPage()
    await blank.goto(`${fixtures.origin}/plain-form.html`)
    const blankTab = await tabIdForUrl(ext, 'plain-form.html')
    const gate = await ext.context.newPage()
    await gate.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await gate.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${blankTab}`))
    await expect(gate.getByLabel(/^Full name/)).toBeVisible({ timeout: 60_000 })
    await compose(ext, null, await panelShot(gate), 'onboarding.png', 'panel')
    await gate.close()
    await blank.close()

    // Scan, review and fill, with the synthetic persona stored.
    seedOnboardedProfile(host.dbPath, { firstName: 'Ada', lastName: 'Lovelace' })
    await seedResume(ext)

    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/fixture-form.html`)
    // The fixture's reCAPTCHA stub stops every scan; the full-loop e2e removes it the same way.
    await target.evaluate(() => { document.querySelector('.g-recaptcha')?.remove() })
    const tabId = await tabIdForUrl(ext, 'fixture-form.html')

    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-banner="ok"]')).toBeVisible({ timeout: 60_000 })
    await expect(panel.locator('li[data-jff-tier="auto"]').first()).toBeVisible({ timeout: 60_000 })
    await expect(target.locator('#email')).toHaveValue('ada@example.com')
    await compose(ext, null, await panelShot(panel), 'review.png', 'panel')

    const bugRow = panel.locator('li[data-jff-tier="needs_input"]', { hasText: 'Describe a hard bug you fixed' })
    await bugRow.getByRole('button', { name: 'Generate with AI' }).click()
    await expect(bugRow.locator('textarea')).toHaveValue(/production TypeScript/, { timeout: 60_000 })
    await bugRow.getByRole('button', { name: 'Fill' }).click()
    await expect(target.locator('#hard_bug')).toHaveValue(/production TypeScript/)
    await bugRow.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await compose(ext, null, await panelShot(panel), 'draft.png', 'panel')

    await panel.evaluate(() => window.scrollTo(0, 0))
    const page = await target.screenshot()
    await compose(ext, page, await panelShot(panel), 'hero.png', 'all')
  } finally {
    await ext.close()
    await host.stop()
    await fixtures.stop()
  }
})

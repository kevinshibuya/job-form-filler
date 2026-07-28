import { chromium, type BrowserContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const EXT_DIST = resolve(here, '../extension/dist')

/**
 * crxjs rewrites HTML entry paths, so specs must never hard-code the panel path.
 * Read the emitted manifest and build the URL from whatever crxjs actually wrote.
 */
export function panelUrl(extensionId: string, query = ''): string {
  const manifest = JSON.parse(readFileSync(resolve(EXT_DIST, 'manifest.json'), 'utf8')) as {
    side_panel?: { default_path?: string }
  }
  const path = manifest.side_panel?.default_path ?? 'src/panel/index.html'
  return `chrome-extension://${extensionId}/${path}${query}`
}

export interface LaunchedExtension {
  context: BrowserContext
  extensionId: string
  consoleErrors: string[]
  close: () => Promise<void>
}

/**
 * Launch Chromium with the built unpacked extension. `channel: 'chromium'` selects
 * the new headless mode, which (unlike old headless) loads extensions.
 */
export async function launchWithExtension(): Promise<LaunchedExtension> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'jff-profile-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIST}`, `--load-extension=${EXT_DIST}`],
  })

  const consoleErrors: string[] = []
  context.on('page', (page) => {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`${page.url()} :: ${e.message}`))
  })

  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  sw.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`sw :: ${m.text()}`) })
  const extensionId = new URL(sw.url()).host

  return { context, extensionId, consoleErrors, close: () => context.close() }
}

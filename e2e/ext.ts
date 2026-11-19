import { chromium, type BrowserContext } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const EXT_DIST = resolve(here, '../extension/dist')

/** Where the Side panel's page lives in the bundle. The manifest declares no
 *  panel (the service worker enables one per tab), so vite.config.ts makes the
 *  page a build input, which keeps this path; extension/src/tabPanel.ts names
 *  the same one. A build that moved it fails here, before any spec drives a
 *  page that is not there. */
export const PANEL_PATH = 'src/panel/index.html'

export function panelUrl(extensionId: string, query = ''): string {
  if (!existsSync(resolve(EXT_DIST, PANEL_PATH))) throw new Error(`the build has no Side panel page at ${PANEL_PATH}`)
  return `chrome-extension://${extensionId}/${PANEL_PATH}${query}`
}

/** The manifest the build emitted. */
export function builtManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(EXT_DIST, 'manifest.json'), 'utf8')) as Record<string, unknown>
}

/** The settings page's address. vite.config.ts makes it a build input, which
 *  keeps its source path in the bundle. */
export function settingsUrl(extensionId: string, hash = ''): string {
  return `chrome-extension://${extensionId}/src/settings/index.html${hash}`
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
    // --mute-audio: a test browser never plays sound through the machine's
    // speakers, whatever its pages autoplay.
    args: [`--disable-extensions-except=${EXT_DIST}`, `--load-extension=${EXT_DIST}`, '--mute-audio'],
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

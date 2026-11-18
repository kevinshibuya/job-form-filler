import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Route } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { seedOnboardedProfile, seedResume } from './seed'
import { startHost } from './hostBridge'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Spec #41, testing decision 6: the whole path from an address to an ATS
 * module, in a real Chrome. Every other browser test serves its pages from
 * 127.0.0.1, where every page is generic, so only this one can prove that a
 * page under Lever's own hostname gets the Lever module: its labels in the
 * page script, and its Job posting page fetched by the page script.
 *
 * Nothing here reaches the network. The browser's requests are intercepted:
 * the apply address gets a Lever form fixture, the posting's address gets the
 * Lever posting fixture, and every request the test did not plan for is
 * aborted. The product gains no test-only switch for this.
 */
const LEVER_ORIGIN = 'https://jobs.lever.co'
const POSTING_PATH = '/acme/0f3c9a52-ada0-4c1e-9b2d-000000000057'
const APPLY_URL = `${LEVER_ORIGIN}${POSTING_PATH}/apply`
/** The Lever module's rule: the apply address without its last segment. */
const POSTING_URL = `${LEVER_ORIGIN}${POSTING_PATH}`

const FORM_HTML = readFileSync(resolve(here, 'fixtures/real/lever-source-group.html'))
const POSTING_HTML = readFileSync(resolve(here, 'fixtures/postings/lever-posting.html'))

/** The questions of lever-source-group's custom card, as Lever's question
 *  blocks write them. With the generic rules the first three have no label
 *  and the last reads "Type your response". */
const CUSTOM_QUESTIONS = [
  'What is your preferred first name and last name?',
  'Export Control and Compliance: For the sole purpose of determining export licensing requirements',
  'Sponsorship: Do you require sponsorship, or will you require sponsorship in the future',
  'If you attended an on-campus or virtual event, which did you attend?',
]

/** Same lookup as the other browser tests: chrome.tabs lives only in an
 *  extension context, and manifest.json gives one without mounting the panel. */
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

/** Same budget rationale as full-loop.spec.ts: the extension launch and the
 *  service worker relay track machine load; per-assertion budgets stay the gate. */
test.describe.configure({ timeout: 240_000 })

test('a Lever form under Lever\'s own hostname gets the Lever labels and the posting page\'s text', async () => {
  const host = await startHost({ mode: 'ok' })
  const ext = await launchWithExtension()

  const postingRequests: string[] = []
  const aborted: string[] = []
  const html = (route: Route, body: Buffer) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body })

  // Every http(s) request the browser makes passes through here. The
  // extension's own pages are chrome-extension:// and never match.
  await ext.context.route(/^https?:\/\//, async (route) => {
    const url = route.request().url()
    if (url === APPLY_URL) return html(route, FORM_HTML)
    if (url === POSTING_URL) {
      postingRequests.push(url)
      return html(route, POSTING_HTML)
    }
    // The browser asks for a favicon on every navigation; an empty answer
    // keeps it out of the console.
    if (url === `${LEVER_ORIGIN}/favicon.ico`) return route.fulfill({ status: 204, body: '' })
    aborted.push(url)
    return route.abort()
  })

  try {
    // The onboarding gate's two halves, as full-loop.spec.ts seeds them.
    seedOnboardedProfile(host.dbPath, { firstName: 'Ada', lastName: 'Lovelace' })
    await seedResume(ext)

    const target = await ext.context.newPage()
    await target.goto(APPLY_URL)
    // The page under test sits on Lever's hostname, and it is the fixture.
    expect(new URL(target.url()).hostname).toBe('jobs.lever.co')
    await expect(target.locator('#application-form')).toBeAttached()
    const tabId = await tabIdForUrl(ext, 'jobs.lever.co')

    // The panel, bridged to the real host process. It Scans on open.
    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-banner="ok"]')).toBeVisible()
    await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })

    // Each custom question's row shows its question, from Lever's question
    // block, and no row is labelled with the placeholder.
    const rows = panel.locator('[data-jff-rows] li')
    for (const question of CUSTOM_QUESTIONS) {
      await expect(rows.filter({ hasText: question }), question).toHaveCount(1)
    }
    await expect(panel.locator('[data-jff-rows]').getByText('Type your response', { exact: true })).toHaveCount(0)

    // The job text came from the posting's page, named with the ATS.
    const line = panel.locator('[data-jff-jobtext-source]')
    await expect(line).toHaveAttribute('data-jff-jobtext-source', 'ats')
    await expect(line).toContainText('the Lever posting page')
    const count = Number(/^(\d+) characters/.exec((await line.textContent()) ?? '')?.[1] ?? 0)
    expect(count).toBeGreaterThanOrEqual(400)

    // The posting's address was asked for once, by the page script, and
    // answered by the test.
    expect(postingRequests).toEqual([POSTING_URL])
    expect(aborted.filter((u) => u.startsWith(LEVER_ORIGIN))).toEqual([])
  } finally {
    await ext.close()
    await host.stop()
  }
})

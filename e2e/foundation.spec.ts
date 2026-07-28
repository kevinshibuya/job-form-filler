import { test, expect, type Page } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { startFixtureServer } from './static-server'

let fixtures: Awaited<ReturnType<typeof startFixtureServer>>
let ext: LaunchedExtension

test.beforeAll(async () => {
  fixtures = await startFixtureServer()
  ext = await launchWithExtension()
})

test.afterAll(async () => {
  // Zero console errors across EVERY test in this file.
  expect(ext.consoleErrors).toEqual([])
  await ext.close()
  await fixtures.stop()
})

interface Harness {
  panel: Page
  target: Page
  tabId: number
  send: (message: unknown, frameId?: number) => Promise<{ ok: boolean; replies: { frameId: number; payload: unknown }[] }>
  close: () => Promise<void>
}

/** Fresh panel page + fixture tab + injected content script, torn down per test. */
async function openFixtureTab(): Promise<Harness> {
  const panel = await ext.context.newPage()
  await panel.goto(panelUrl(ext.extensionId))
  const target = await ext.context.newPage()
  await target.goto(`${fixtures.origin}/fixture-form.html`)
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/fixture-form.html' })
    return tabs[tabs.length - 1]!.id!
  })
  const injected = await panel.evaluate((id) => chrome.runtime.sendMessage({ kind: 'inject', tabId: id }), tabId)
  expect(injected).toMatchObject({ ok: true })
  const send = (message: unknown, frameId?: number) =>
    panel.evaluate(
      (args) => chrome.runtime.sendMessage({ kind: 'toContent', tabId: args.id, frameId: args.frameId, message: args.message }),
      { id: tabId, message, frameId },
    ) as Promise<{ ok: boolean; replies: { frameId: number; payload: unknown }[] }>
  return {
    panel, target, tabId, send,
    close: async () => { await panel.close(); await target.close() },
  }
}

test('the side panel document renders', async () => {
  const panel = await ext.context.newPage()
  await panel.goto(panelUrl(ext.extensionId))
  await expect(panel.locator('[data-jff-ready="1"]')).toBeVisible()
  await expect(panel.locator('[data-jff-title="1"]')).toHaveText('job-form-filler')
  await panel.close()
})

test('the content script injects on demand into every frame and answers the probe', async () => {
  const t = await openFixtureTab()
  try {
    const probe = await t.send({ type: 'JFF_PROBE' })
    expect(probe.ok).toBe(true)
    const top = probe.replies.find((r) => r.frameId === 0)!
    const topPayload = top.payload as { ok: boolean; probe: { controlCount: number; url: string } }
    expect(topPayload.ok).toBe(true)
    // fixture-form.html top frame: first_name, last_name, email, resume, work_auth,
    // attestation, linkedin-input, hard_bug, mystery — at least 8 controls.
    expect(topPayload.probe.controlCount).toBeGreaterThanOrEqual(8)
    // SPIKE assertion (permanent): executeScript({allFrames:true, files}) must reach
    // the EEO srcdoc iframe as a second content-script instance. If exactly one
    // reply comes back, srcdoc injection does not hold on this Chromium build;
    // apply the documented fallback in the note under Step 11 instead of loosening
    // this assertion.
    const frameUrls = probe.replies.map((r) => (r.payload as { probe?: { url: string } }).probe?.url)
    expect(frameUrls).toContain('about:srcdoc')
    expect(probe.replies.length).toBeGreaterThanOrEqual(2)
  } finally {
    await t.close()
  }
})

test('a scan enumerates the fixture form for real', async () => {
  const t = await openFixtureTab()
  try {
    const scan = await t.send({ type: 'JFF_SCAN', epoch: 1 })
    type ScanPayload = { ok: boolean; scan?: { fields: { name: string | null; kind: string }[] } }
    const topScan = (scan.replies.find((r) => r.frameId === 0)!.payload as ScanPayload).scan!
    const names = topScan.fields.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['first_name', 'last_name', 'email', 'resume', 'work_auth', 'hard_bug']))
    // real layout: the hidden #resume input is still reported, the file kind wins
    expect(topScan.fields.find((f) => f.name === 'resume')!.kind).toBe('file')
  } finally {
    await t.close()
  }
})

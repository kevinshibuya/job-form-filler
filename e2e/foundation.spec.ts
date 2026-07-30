import { test, expect, type Page } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { seedResume } from './seed'
import { startFixtureServer } from './static-server'

let fixtures: Awaited<ReturnType<typeof startFixtureServer>>
let ext: LaunchedExtension

test.beforeAll(async () => {
  fixtures = await startFixtureServer()
  ext = await launchWithExtension()
  // O3 era, once for the whole file: the seam build's canned host already
  // answers an ONBOARDED profile (port.ts), but a resume can only ever live in
  // the extension origin, so without this the scan-outcomes test below renders
  // the onboarding wall instead of a status. The relay panels `openFixtureTab`
  // opens are unaffected either way — they use the REAL native port, which is
  // unreachable in a test profile, so their completeness verdict is 'unknown'
  // (scan anyway), never 'incomplete'.
  await seedResume(ext)
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

/** Fresh panel page + fixture tab + injected content script, torn down per test.
 *  `file` names the fixture served out of `fixtures/greenhouse-apply`; it is
 *  threaded through BOTH the navigation and the chrome.tabs URL glob, so every
 *  caller keeps addressing the tab it actually opened. */
async function openFixtureTab(file = 'fixture-form.html'): Promise<Harness> {
  const panel = await ext.context.newPage()
  await panel.goto(panelUrl(ext.extensionId))
  const target = await ext.context.newPage()
  await target.goto(`${fixtures.origin}/${file}`)
  const tabId = await panel.evaluate(async (name) => {
    const tabs = await chrome.tabs.query({ url: `*://*/${name}` })
    return tabs[tabs.length - 1]!.id!
  }, file)
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

test('the EEO srcdoc subframe is flagged demographic and the visible reCAPTCHA stub reads as active', async () => {
  const t = await openFixtureTab()
  try {
    const scan = await t.send({ type: 'JFF_SCAN', epoch: 2 })
    type ScanPayload = { scan?: { fields: { name: string | null; demographic: boolean }[]; activeCaptcha: boolean } }
    // the EEO srcdoc iframe is a separate frame; its Gender select must be flagged
    const eeoFrame = scan.replies.find((r) => r.frameId !== 0 && ((r.payload as ScanPayload).scan?.fields.length ?? 0) > 0)!
    const gender = (eeoFrame.payload as ScanPayload).scan!.fields.find((f) => f.name === 'gender')!
    expect(gender.demographic).toBe(true)
    // the fixture's visible reCAPTCHA stub is an ACTIVE challenge
    expect((scan.replies.find((r) => r.frameId === 0)!.payload as ScanPayload).scan!.activeCaptcha).toBe(true)
  } finally {
    await t.close()
  }
})

test('a fill carrying a stale epoch is rejected', async () => {
  const t = await openFixtureTab()
  try {
    await t.send({ type: 'JFF_SCAN', epoch: 3 })
    const stale = await t.send({
      type: 'JFF_FILL', epoch: 999,
      fills: [{ handle: { frameId: 0, fid: 0, epoch: 999 }, value: 'x' }],
    })
    expect(stale.replies.find((r) => r.frameId === 0)!.payload).toMatchObject({ ok: false, error: 'stale_epoch' })
  } finally {
    await t.close()
  }
})

test('a real submit pushes a per-tab-per-frame snapshot into storage.session', async () => {
  const t = await openFixtureTab()
  try {
    await t.send({ type: 'JFF_SCAN', epoch: 40 }) // stamps fids + installs listeners
    await t.target.fill('#first_name', 'Kevin')
    await t.target.selectOption('#work_auth', { index: 1 })
    await t.target.fill('#hard_bug', 'typed by hand')
    await t.target.click('#submit_app')
    await expect(t.target.locator('#application-confirmation')).toBeVisible()

    const stored = await t.panel.evaluate(() => chrome.storage.session.get(null)) as
      Record<string, { epoch: number; values: Record<string, string> }>
    const key = `jff:snap:${t.tabId}:0`
    expect(Object.keys(stored)).toContain(key)
    expect(stored[key]!.epoch).toBe(40)
    expect(Object.values(stored[key]!.values)).toContain('typed by hand')
  } finally {
    await t.close()
  }
})

test('job text is captured from the fixture job-description block by the heuristic tier', async () => {
  const t = await openFixtureTab()
  try {
    await t.send({ type: 'JFF_SCAN', epoch: 5 }) // JOBTEXT sits below the epoch guard
    const jt = await t.send({ type: 'JFF_JOBTEXT', epoch: 5, selector: null })
    type JtPayload = { ok: boolean; jobText?: { text: string; selector: string | null; source: string } }
    const payload = (jt.replies.find((r) => r.frameId === 0)!.payload as JtPayload).jobText!
    expect(payload.source).toBe('heuristic')
    expect(payload.text).toContain('FIXTURE-JD')
    expect(payload.selector).toBe('#job-description')
  } finally {
    await t.close()
  }
})

test('the panel surfaces scan outcomes: captcha on the fixture form, done on a captcha-free form, empty on a blank page', async () => {
  // Real UI, real relay, fake host (seam build). The fixture form carries an
  // ACTIVE reCAPTCHA stub, so its deterministic outcome is `captcha`.
  // 60s assertion budgets: the repo's measured worst case for a foundation test
  // is 31.4s under load (playwright.config.ts); full-loop already runs at 60s.
  const target = await ext.context.newPage()
  await target.goto(`${fixtures.origin}/fixture-form.html`)
  // chrome.tabs is only available to EXTENSION pages: the finder must be a panel
  // page, not a plain about:blank page.
  const finder = await ext.context.newPage()
  await finder.goto(panelUrl(ext.extensionId))
  const tabId = await finder.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/fixture-form.html' })
    return tabs[tabs.length - 1]!.id!
  })
  const panel = await ext.context.newPage()
  await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
  await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'captcha', { timeout: 60_000 })

  // A form with NO challenge markup must settle to `done`: fields were found and
  // the (fake) host resolved them. This is the leg that proves the happy outcome
  // is reachable end to end, not just the two degraded ones.
  const plain = await ext.context.newPage()
  await plain.goto(`${fixtures.origin}/plain-form.html`)
  const plainTabId = await finder.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/plain-form.html' })
    return tabs[tabs.length - 1]!.id!
  })
  const panelPlain = await ext.context.newPage()
  await panelPlain.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${plainTabId}`))
  await expect(panelPlain.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })

  // A page with zero fields must settle to `empty` (after the one-shot retry)
  // and expose the per-frame diagnostics disclosure.
  const blank = await ext.context.newPage()
  await blank.goto(`${fixtures.origin}/blank.html`)
  const blankTabId = await finder.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/blank.html' })
    return tabs[tabs.length - 1]!.id!
  })
  const panel2 = await ext.context.newPage()
  await panel2.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${blankTabId}`))
  await expect(panel2.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'empty', { timeout: 60_000 })
  await expect(panel2.locator('[data-jff-diagnostics]')).toBeAttached()

  await panel2.close(); await blank.close(); await panelPlain.close(); await plain.close()
  await panel.close(); await finder.close(); await target.close()
})

/**
 * TERMINAL scan outcomes. Everything else means the panel's own pipeline is
 * still going: the five progress kinds obviously, but ALSO `superseded` (a scan
 * is running and a rescan is already queued behind it) and NO status element at
 * all (the tab scope just reset, or the panel has not bound its tab yet) — both
 * of those read as "idle" to a not-in-the-busy-list test, and that mistake is
 * exactly what let a queued rescan land in the middle of the driven fill.
 */
const PANEL_SETTLED: string[] = ['done', 'empty', 'captcha', 'failed', 'action_failed']

/**
 * The relay panel binds to the ACTIVE tab — which is the fixture tab this
 * harness just opened — so it runs its own scan pipeline against the same page.
 * A6's option harvest CLICKS every optionless combobox there and then RESTORES
 * the pre-click value, and the pipeline re-stamps the frame epoch on each
 * enumerate. Overlapping a driven fill with that is a genuine race: the
 * harvest's restore write lands mid-typeahead and re-widens the filtered menu,
 * and the fill then reports `no-matching-option` on a widget that works.
 * Wait for the panel to reach a terminal state first — or to render
 * OnboardingView, which never scans at all.
 */
async function waitForPanelIdle(panel: Page): Promise<void> {
  await expect
    .poll(
      () => panel.evaluate((settled) => {
        if (document.querySelector('[data-jff-onboarding]') !== null) return true
        const kind = document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')
        return kind != null && settled.includes(kind)
      }, PANEL_SETTLED),
      { timeout: 60_000, message: 'the panel never settled; its own scan would race the driven fill' },
    )
    .toBe(true)
}

test('the Greenhouse react-select shape fills through the gesture + value-container recipe (C2/C3)', async () => {
  // C3: the whole C2 recipe in a REAL browser, on a widget shaped like the live
  // Greenhouse Degree field — the menu opens ONLY on the full pointer+mouse
  // gesture, it portals to <body>, 'oth' is ambiguous until the widget's own
  // filter runs, and the commit CLEARS the input and renders the text in a
  // sibling value container. jsdom cannot prove any of it: it has no real
  // PointerEvent trust model and no layout for the visibility gate.
  const t = await openFixtureTab('react-select-form.html')
  try {
    await waitForPanelIdle(t.panel)
    const epoch = 6
    const scan = await t.send({ type: 'JFF_SCAN', epoch })
    type ScanPayload = { ok: boolean; scan?: { fields: { fid: number; idAttr: string | null; kind: string }[] } }
    const fields = (scan.replies.find((r) => r.frameId === 0)!.payload as ScanPayload).scan!.fields
    const degree = fields.find((f) => f.idAttr === 'degree-input')!
    expect(degree.kind).toBe('combobox')

    const fill = await t.send({
      type: 'JFF_FILL', epoch,
      fills: [{ handle: { frameId: 0, fid: degree.fid, epoch }, value: 'oth' }],
    })
    type FillPayload = {
      ok: boolean
      fill?: { filled: { committed: string | null }[]; failed: { reason: string }[] }
    }
    const report = (fill.replies.find((r) => r.frameId === 0)!.payload as FillPayload).fill!
    // 1. the page ACCEPTED the fill, and the report carries the canonical text
    //    the widget committed — not the 'oth' that was asked for.
    expect(report.failed).toEqual([])
    expect(report.filled).toHaveLength(1)
    expect(report.filled[0]!.committed).toBe('Other')

    // 2. the page's own state, read independently of the fill report: the
    //    committed text lives in the value container and the input is EMPTY.
    await expect(t.target.locator('#degree-value')).toHaveText('Other')
    expect(await t.target.inputValue('#degree-input')).toBe('')

    // 3. the permanently-mounted intl-tel-input decoy — whose first option is
    //    also 'Other' — was never opened, filtered or read from.
    const decoy = await t.target.evaluate(() => {
      const ul = document.getElementById('country-decoy')!
      const options = Array.from(ul.querySelectorAll('[role="option"]'))
      return {
        count: options.length,
        display: getComputedStyle(ul).display,
        // Still the trap it was built to be: its FIRST option is 'Other' too.
        first: options[0]?.textContent ?? null,
      }
    })
    expect(decoy).toEqual({ count: 244, display: 'none', first: 'Other' })

    // 4. no console errors: asserted in afterAll across EVERY test in this file.
  } finally {
    await t.close()
  }
})

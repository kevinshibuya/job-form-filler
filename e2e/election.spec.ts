import { test, expect } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { startFixtureServer } from './static-server'

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

interface BridgeReq { requestId: string; method: string; params: unknown }
interface ResolveParams { epoch: number; jobText: string; fields: { frameId: number; fid: number; epoch: number; label: string | null; kind: string; options: string[] }[] }

/**
 * `chrome.tabs` exists ONLY in an extension context, and the lookup must not
 * MOUNT the panel app: a second panel with no `?tabId=` binds to the active tab
 * and auto-scans it, racing the scan under test (full-loop.spec.ts documents the
 * same trap). manifest.json is an extension resource, so it gets the full API
 * surface with no app.
 */
async function tabIdForUrl(ext: LaunchedExtension, needle: string): Promise<number> {
  const lookup = await ext.context.newPage()
  await lookup.goto(`chrome-extension://${ext.extensionId}/manifest.json`)
  const id = await lookup.evaluate(async (n) => {
    const tabs = await chrome.tabs.query({})
    return tabs.filter((t) => (t.url ?? '').includes(n)).pop()?.id ?? null
  }, needle)
  await lookup.close()
  if (id === null) throw new Error(`no tab matching ${needle}`)
  return id
}

/** The scripted host's kind → auto-value mapping; a kind absent here resolves
 *  as needs_input with a null value. */
const AUTO_VALUE: Record<string, string | undefined> = {
  text: 'ELECTED-FILL',
  choice: 'Yes',
  combobox: 'Atlantis',
}

/** Same budget rationale as full-loop.spec.ts: extension launch + SW relay cost
 *  tracks machine load; per-assertion budgets stay the behavioural gate. */
test.describe.configure({ timeout: 240_000 })

test('election scopes resolve, auto-fill and harvest to the cross-origin application frame', async () => {
  const hostSrv = await startFixtureServer('fixtures/ashby-host')
  const embedSrv = await startFixtureServer('fixtures/ashby-embed')
  const ext = await launchWithExtension()
  try {
    const target = await ext.context.newPage()
    await target.goto(`${hostSrv.origin}/newsletter-page.html?frame=${encodeURIComponent(`${embedSrv.origin}/apply-frame.html`)}`)
    const appFrame = target.frameLocator('#app-frame')
    await expect(appFrame.locator('[role="combobox"]')).toBeVisible()

    // chrome.tabs is extension-only: find the tab id from an extension page.
    const tabId = await tabIdForUrl(ext, 'newsletter-page.html')

    // Scripted host: text → 'ELECTED-FILL'; choice → 'Yes', which must LAND
    // through fillChoice's gated button path; combobox → 'Atlantis', the bait —
    // no such option exists, so that fill must FAIL, restore the control and
    // surface on its row. Every other kind stays needs_input.
    const resolveCalls: ResolveParams[] = []
    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: BridgeReq) => {
      const { requestId, method } = req
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = req.params as ResolveParams
        resolveCalls.push(p)
        return {
          requestId, ok: true,
          result: {
            epoch: p.epoch,
            resolutions: p.fields.map((f) => {
              const auto = AUTO_VALUE[f.kind]
              return {
                handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
                tier: auto === undefined ? 'needs_input' : 'auto',
                value: auto ?? null,
                source: auto === undefined ? null : 'profile',
                key: null, answerId: null, reason: 'e2e',
              }
            }),
            llmError: null,
          },
        }
      }
      if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
      if (method === 'profile.get' || method === 'answerBank.get') return { requestId, ok: true, result: {} }
      return { requestId, ok: true, result: {} }
    })
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })

    // A7: the resolve payload is elected-frame-only — the newsletter field
    // (frame 0) never left the panel and never cost resolve payload.
    expect(resolveCalls).toHaveLength(1)
    // Census of KEPT elected fields: first, last, choice, combobox, resume
    // file, essay = 6. The clipped autofill pane is NOT among them — clipping
    // makes it visible:false, and unlabelled + zero A8 score makes it junk.
    expect(resolveCalls[0]!.fields).toHaveLength(6)
    expect(resolveCalls[0]!.fields.filter((f) => f.kind === 'file')).toHaveLength(1)
    expect(resolveCalls[0]!.fields.every((f) => f.frameId !== 0)).toBe(true)
    expect(resolveCalls[0]!.fields.map((f) => f.label)).toContain('First name')
    expect(resolveCalls[0]!.fields.map((f) => f.label)).not.toContain('Newsletter email')

    // A6: the combobox options were harvested from the LIVE page (cross-origin
    // frame, per-frame webNavigation injection) and merged BEFORE resolve…
    const combo = resolveCalls[0]!.fields.find((f) => f.kind === 'combobox')!
    expect(combo.options).toEqual(['Brazil', 'Portugal', 'United States'])
    // …and the page shows no residue: listbox closed, value restored to ''.
    await expect(appFrame.locator('[role="listbox"]')).toHaveCount(0)
    await expect(appFrame.locator('[role="combobox"]')).toHaveValue('')

    // A7 bypass: the recognizer-resolvable newsletter input was NEVER written.
    await expect(target.locator('#nl-email')).toHaveValue('')
    // The elected frame's text fields WERE auto-filled through the relay.
    await expect(appFrame.locator('input[name="first-uuid"]')).toHaveValue('ELECTED-FILL')
    // B1 end-to-end: the controlled choice was filled through the GATED BUTTON
    // path — the page's own state machine reacted (aria-pressed + checkbox),
    // which is the observable delta fillChoice verified before reporting ok.
    const yesBtn = appFrame.locator('._container_1svni_28 button', { hasText: 'Yes' })
    await expect(yesBtn).toHaveAttribute('aria-pressed', 'true')
    expect(await appFrame.locator('input[name="yn-uuid"]').isChecked()).toBe(true)

    // B2/B3 end-to-end: the 'Atlantis' combobox fill found no exact match,
    // RESTORED the control (still '', per the existing assertion above), and
    // surfaced on its row: demoted to needs-input styling with its reason.
    const demoted = panel.locator('li[data-jff-tier="needs_input"]', { hasText: 'Select your country of employment' })
    await expect(demoted).toHaveCount(1)
    await expect(demoted).toContainText('no-matching-option')

    // TODO 18, "neither count lies": filled = page-accepted only (first, last,
    // choice) — the failed combobox is counted as needing input, never as filled.
    await expect(panel.locator('[data-jff-status]')).toContainText('✓ 3 filled, 0 already on page, 0 proposed, 3 need input')

    // A9: elected rows render in DOCUMENT order with kind-aware editors…
    const firstLabel = panel.locator('[data-jff-rows] li label.font-semibold').first()
    await expect(firstLabel).toHaveText('First name')
    await expect(panel.locator('[data-jff-editor="segmented"]').first()).toBeAttached()
    // The junk-filtered autofill pane renders NO row at all…
    await expect(panel.locator('[data-jff-rows] li', { hasText: '(unlabelled field)' })).toHaveCount(0)
    // …and page-side it never received a file (A8 upload-target bypass; this
    // run stores no resume, so the count is 0 either way — the assertion is the
    // permanent guard once one is stored).
    expect(await appFrame.locator('input.visually-hidden[type="file"]')
      .evaluate((n) => (n as HTMLInputElement).files?.length ?? 0)).toBe(0)
    // …and the newsletter field sits demoted under a header NAMING the elected
    // frame by host:port (the two origins share 127.0.0.1; the port disambiguates).
    const foreign = panel.locator('[data-jff-foreign]')
    await expect(foreign).toContainText('Other page fields (1)')
    await expect(foreign).toContainText(new URL(embedSrv.origin).host)
    await expect(foreign).toContainText('Newsletter email')
    await expect(foreign.locator('button', { hasText: 'Generate with AI' })).toHaveCount(0)

    // Pasted-job-text case: election is unmoved and the paste wins.
    await panel.locator('[data-jff-paste="1"] textarea').fill('PASTED-JD')
    await panel.getByRole('button', { name: 'Scan' }).click()
    await expect
      .poll(() => resolveCalls.length, { timeout: 60_000 })
      .toBe(2)
    expect(resolveCalls[1]!.jobText).toBe('PASTED-JD')
    expect(resolveCalls[1]!.fields.every((f) => f.frameId !== 0)).toBe(true)
    // Let the second scan's fill pass settle before the page-side and console
    // checks below. Its COUNTS are deliberately not asserted: the choice widget
    // already answers 'Yes', so the re-fill produces no observable delta and
    // fillChoice honestly reports `no-state-change` — a second-scan fact, not a
    // regression of the first-scan proof above.
    await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })
    await expect(target.locator('#nl-email')).toHaveValue('')

    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await hostSrv.stop()
    await embedSrv.stop()
  }
})

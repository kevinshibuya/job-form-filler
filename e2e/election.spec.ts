import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { ONBOARDED_PROFILE, seedResume } from './seed'
import { startFixtureServer } from './static-server'

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  codex: { ok: true, path: '(fake)', detail: 'found' },
  codexAuth: { ok: true, detail: 'logged in' },
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

/** Byte-identical to `TINY_PDF_B64` in extension/src/panel/cvText.test.ts: a
 *  606-byte valid PDF whose single page draws 'Kevin Shibuya kevin@example.com'. */
const TINY_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MiA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcyMCBUZCAoS2V2aW4gU2hpYnV5YSBrZXZpbkBleGFtcGxlLmNvbSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTMgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjMKJSVFT0YK'

/** Same budget rationale as full-loop.spec.ts: extension launch + SW relay cost
 *  tracks machine load; per-assertion budgets stay the behavioural gate. */
test.describe.configure({ timeout: 240_000 })

test('election scopes resolve, auto-fill and harvest to the cross-origin application frame', async () => {
  const hostSrv = await startFixtureServer('fixtures/ashby-host')
  const embedSrv = await startFixtureServer('fixtures/ashby-embed')
  const ext = await launchWithExtension()
  try {
    // O3 era: the stored resume is the extension-side half of the onboarding
    // gate — without it the panel renders the setup wall and never scans. The
    // host-side half is `profile.get` in the scripted bridge below.
    await seedResume(ext)

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
    const generateCalls: { cvText?: string }[] = []
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
      // O3 era: an EMPTY profile now puts the panel behind the onboarding wall,
      // where it never scans. The scripted `resolve` above maps by kind alone and
      // never reads facts, so answering the onboarded persona here changes
      // nothing this spec measures — it only opens the gate.
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED_PROFILE }
      if (method === 'answerBank.get') return { requestId, ok: true, result: {} }
      if (method === 'generate') {
        generateCalls.push(req.params as { cvText?: string })
        return { requestId, ok: true, result: { draft: 'E2E DRAFT' } }
      }
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

    // A6 under the TYPE-TO-LOAD widget: a bare open-click mounts NOTHING (the
    // real Ashby shape), so the harvest legitimately returns no options and
    // the resolve payload carries an empty list — the panel renders the
    // options-load-on-fill editor instead. The page shows no residue either.
    const combo = resolveCalls[0]!.fields.find((f) => f.kind === 'combobox')!
    expect(combo.options).toEqual([])
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

    // B1a/B1b/B1c end-to-end: the user types a partial query and Fill drives
    // the type-to-load widget — keystrokes mount the filtered options, the
    // UNIQUE substring match 'Brazil' is clicked, and the page-accepted
    // committed text canonicalizes both the page and the panel row.
    const countryInput = demoted.locator('input[data-jff-editor="combobox-empty"]')
    await countryInput.fill('bra')
    await demoted.getByRole('button', { name: 'Fill' }).click()
    await expect(appFrame.locator('[role="combobox"]')).toHaveValue('Brazil', { timeout: 15_000 })
    await expect(countryInput).toHaveValue('Brazil')
    await expect(demoted.getByText('on the page')).toBeVisible()

    // A9: elected rows render in DOCUMENT order with kind-aware editors…
    const firstLabel = panel.locator('[data-jff-rows] li label.font-semibold').first()
    await expect(firstLabel).toHaveText('First name')
    await expect(panel.locator('[data-jff-editor="segmented"]').first()).toBeAttached()
    // The junk-filtered autofill pane renders NO row at all…
    await expect(panel.locator('[data-jff-rows] li', { hasText: '(unlabelled field)' })).toHaveCount(0)
    // …and page-side it never received a file (A8 upload-target bypass). The
    // O3-era `seedResume` above turned this from a vacuous 0 into the real
    // guard: a resume IS stored now, and the engine still must never upload it
    // without the user clicking the row's own button.
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
    await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })
    // B5e (spec D4) SUPERSEDES the session-6 comment that once lived here
    // ("counts deliberately not asserted; re-filling an already-correct choice
    // reports no-state-change"). fillChoice's step 0 now reports
    // verified-already-at-state as ok WITHOUT weakening anything — a click
    // that changes nothing still fails. The double-scan counts are therefore
    // asserted, and they are the OPEN FINDING's regression test: a correct
    // answer must never demote to needs-input on a re-scan.
    //
    // Second-scan counts, derived FIELD BY FIELD (cross-vendor review item 10):
    // the SCRIPTED host maps by kind only and never emits source:'page', so
    // tier-1 'already-on-page' is structurally impossible in this spec — the
    // fake resolve IGNORES currentValue, which is why 'already on page' stays
    // 0 even though first/last/combobox re-enumerate with non-null
    // currentValue after scan 1 and the manual bra→Brazil commit.
    //   first, last  (text → auto 'ELECTED-FILL'): re-fill writes the same
    //                value; text fills always verify        → 2 filled
    //   choice       (→ auto 'Yes'): checkbox already checked from scan 1 →
    //                fillChoice STEP 0 verified-at-state    → 1 filled
    //   combobox     (→ auto 'Atlantis'): typeahead mounts an empty filtered
    //                listbox → no-matching-option → demoted → 1 needs input
    //   resume file, essay (kinds without an AUTO_VALUE)    → 2 needs input
    // = 3 filled, 0 already on page, 0 proposed, 3 need input.
    await expect(panel.locator('[data-jff-status]')).toContainText('✓ 3 filled, 0 already on page, 0 proposed, 3 need input')
    // The OPEN-FINDING regression must not hide behind count arithmetic: the
    // choice ROW itself keeps its auto tier after the double scan.
    await expect(panel.locator('[data-jff-rows] li', { hasText: 'Are you legally authorized' }))
      .toHaveAttribute('data-jff-tier', 'auto')
    await expect(yesBtn).toHaveAttribute('aria-pressed', 'true')
    // The failed 'Atlantis' re-fill failed CLOSED: it restored the user's
    // committed 'Brazil', never clearing the control.
    await expect(appFrame.locator('[role="combobox"]')).toHaveValue('Brazil')
    await expect(target.locator('#nl-email')).toHaveValue('')

    // B2a in a real browser (the ONLY pre-manual-gate exercise of cvText.ts):
    // storing a PDF through the panel's resume input runs the real pdfjs
    // extraction inside the MV3 panel, and the next Generate carries the
    // extracted text as trusted context.
    const pdfPath = join(tmpdir(), `jff-tiny-cv-${Date.now()}.pdf`)
    writeFileSync(pdfPath, Buffer.from(TINY_PDF_B64, 'base64'))
    await panel.locator('[data-jff-resume] input[type="file"]').setInputFiles(pdfPath)
    // App sets cvText state BEFORE the resume name renders (Task 8 orders it
    // so), making the rendered name the deterministic extraction-done signal.
    await expect(panel.locator('[data-jff-resume]')).toContainText('jff-tiny-cv')
    const essayRow = panel.locator('[data-jff-rows] li', { hasText: 'Describe the fastest measurable outcome' })
    await essayRow.getByRole('button', { name: 'Generate with AI' }).click()
    await expect.poll(() => generateCalls.length, { timeout: 30_000 }).toBe(1)
    expect(generateCalls[0]!.cvText).toContain('Kevin Shibuya')
    rmSync(pdfPath, { force: true })

    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await hostSrv.stop()
    await embedSrv.stop()
  }
})

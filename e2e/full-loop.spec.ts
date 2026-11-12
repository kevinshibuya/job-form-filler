import { test, expect } from '@playwright/test'
import DatabaseCtor from 'better-sqlite3'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { seedOnboardedProfile, seedResume } from './seed'
import { startFixtureServer } from './static-server'
import { startHost } from './hostBridge'

/**
 * `chrome.tabs` exists ONLY in an extension context. A page created with
 * `context.newPage()` sits on about:blank, where `chrome.tabs` is undefined, and
 * driving the service worker instead hangs once MV3 has parked it. So the lookup
 * runs on a throwaway extension-origin page: manifest.json is an extension
 * resource, which gets the full API surface without mounting the panel app (and
 * therefore without a second auto-scan racing the one under test).
 */
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

/**
 * The fixture ships an ACTIVE reCAPTCHA v2 stub (a 304x78 visible .g-recaptcha,
 * Task 3 Step 7 leaves it alone). runScan short-circuits on an active challenge
 * and fills NOTHING, so the full loop can never run with it present. Remove it
 * on THIS tab; Task 14 Step 6 owns the active-CAPTCHA assertion, on its own
 * fresh fixture tab in foundation.spec.ts. (A query-gated stub would not work:
 * the static server strips query strings before resolving the file.)
 */
const STUB_SELECTOR = '.g-recaptcha'

/**
 * These two are the heaviest tests in the repo: each launches its own Chromium
 * with the unpacked extension, spawns a real host child process, and drives the
 * whole loop across a service worker relay and two frames. The per-assertion
 * timeouts below are the real behavioural budgets; this widens the WALL-CLOCK
 * envelope, because `chrome.scripting.executeScript` (the SW's frame discovery,
 * one call per broadcast) is the single step whose latency tracks machine load
 * rather than anything this code does. A genuinely broken loop still fails fast
 * on the per-assertion timeouts.
 *
 * The assertion budgets were 30s and MEASURED TOO TIGHT: on a loaded machine the
 * rate-limit banner assertion timed out at 30s while passing in 13.1s on an idle
 * one (and the whole test ran 51.9s isolated against a then-60s envelope). 60s
 * assertions inside a 240s envelope keep the failure mode meaningful without
 * failing correct code because the machine was busy.
 */
test.describe.configure({ timeout: 240_000 })

test('scan, resolve, fill, snapshot and save round-trips through the real host into SQLite', async () => {
  const fixtures = await startFixtureServer()
  const host = await startHost({ mode: 'ok' })
  const ext = await launchWithExtension()

  try {
    // O3 era: this is no longer just fill fodder — the panel REFUSES to scan
    // until the profile is complete (email, phone, a name AND a stored resume),
    // so an unseeded run lands on the onboarding wall and nothing below ever
    // runs. `seedOnboardedProfile` supplies the host-side half straight into
    // SQLite (the panel is what is under test; it must not be asked to store its
    // own precondition) and `seedResume` the extension-side half.
    // firstName/lastName are kept on top of the shared persona because the
    // fixture's name fields are what the deterministic tier is asserted to fill
    // below; ONBOARDED_PROFILE.email is the same 'ada@example.com' this test
    // has always asserted.
    seedOnboardedProfile(host.dbPath, { firstName: 'Ada', lastName: 'Lovelace' })
    await seedResume(ext)

    // The page under test.
    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/fixture-form.html`)
    // Assert the stub is THERE first: a bare post-condition of "count 0" would
    // also pass if the fixture had quietly lost its stub, which would silently
    // gut Task 14's active-CAPTCHA assertion instead of failing here.
    await expect(target.locator(STUB_SELECTOR)).toHaveCount(1)
    await target.evaluate((sel) => { document.querySelector(sel)?.remove() }, STUB_SELECTOR)
    // Proof the removal actually ran: an assertion that only passes because the
    // stub is gone, so a silently failing evaluate cannot masquerade as success.
    await expect(target.locator(STUB_SELECTOR)).toHaveCount(0)
    const tabId = await tabIdForUrl(ext, 'fixture-form.html')

    // The panel, bridged to the REAL host process. exposeFunction BEFORE goto.
    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-banner="ok"]')).toBeVisible()

    // SCAN: the panel auto-scans on open. Do NOT also click Scan — a second
    // runScan would overlap the first, and the loser's fills land under a stale
    // epoch, leaving the form half-filled nondeterministically.
    await expect(panel.locator('li[data-jff-tier="auto"]').first()).toBeVisible({ timeout: 60_000 })

    // The deterministic recognizers filled the page for real.
    await expect(target.locator('#first_name')).toHaveValue('Ada')
    await expect(target.locator('#last_name')).toHaveValue('Lovelace')
    await expect(target.locator('#email')).toHaveValue('ada@example.com')

    // EEO is skipped, never filled.
    const eeoValue = await target.frameLocator('#eeo-frame').locator('#gender').inputValue()
    expect(eeoValue).toBe('')

    // Draft the LABELLED free-text question specifically (not .first(): the
    // needs-input group also holds recognized-but-unstored factual fields).
    await expect(panel.locator('li[data-jff-tier="needs_input"]').first()).toBeVisible()
    const bugRow = panel.locator('li[data-jff-tier="needs_input"]', { hasText: 'Describe a hard bug you fixed' })
    await bugRow.getByRole('button', { name: 'Generate with AI' }).click()
    // Assert the DRAFT ARRIVED, not that a button vanished: `toHaveCount(0)` on
    // 'Drafting…' passes in the window before the state lands, which would make
    // every assertion after it race the generate call.
    await expect(bugRow.locator('textarea')).toHaveValue(/production TypeScript/, { timeout: 60_000 })

    // FILL: the spec's loop is generate -> edit -> fill. Clicking Fill is what puts
    // the draft on the page; without it the draft dies in the panel textarea and
    // the snapshot-beats-panel-edit assertion below would prove nothing.
    await bugRow.getByRole('button', { name: 'Fill' }).click()
    await expect(target.locator('#hard_bug')).toHaveValue(/production TypeScript/)

    // The user overrides that draft by typing on the PAGE (snapshot must beat the
    // panel edit), corrects a factual select, types into the unlabelled mystery
    // field (which must NOT be saved), then submits.
    await target.fill('#hard_bug', 'answered by hand on the page')
    await target.selectOption('#work_auth', { index: 1 })
    await target.fill('#mystery', 'unlabelled, must never be saved')
    await target.click('#submit_app')
    await expect(target.locator('#application-confirmation')).toBeVisible()

    // Company is user-editable and threads into the applications row.
    await panel.locator('[data-jff-company="1"] input').fill('Acme')

    // SAVE.
    await panel.getByRole('button', { name: 'Save answers' }).click()
    await expect(panel.locator('[data-jff-savemsg="1"]')).toContainText('Saved', { timeout: 60_000 })

    // The rows really landed in SQLite.
    const db = new DatabaseCtor(host.dbPath, { readonly: true })
    const answers = db.prepare('SELECT question_raw, answer, reusability FROM qa_memory').all() as
      { question_raw: string; answer: string; reusability: string }[]
    const bank = db.prepare('SELECT key, value FROM answer_bank').all() as { key: string; value: string }[]
    const apps = db.prepare('SELECT url, company, filled_count, generated_count FROM applications').all() as
      { url: string; company: string | null; filled_count: number; generated_count: number }[]
    db.close()

    // The page-typed answer beat the AI draft (snapshot > panel edit) and landed
    // in qa_memory under its labelled question.
    const bug = answers.find((a) => a.question_raw === 'Describe a hard bug you fixed')!
    expect(bug.answer).toBe('answered by hand on the page')
    expect(bug.reusability).toBe('reusable')
    // The unlabelled field is skipped by design.
    expect(answers.map((a) => a.answer)).not.toContain('unlabelled, must never be saved')
    // The factual correction routed to the ANSWER BANK, not qa_memory.
    expect(bank).toContainEqual({ key: 'workAuth', value: 'I am authorized to work for any employer in the US.' })
    expect(answers.map((a) => a.answer)).not.toContain('I am authorized to work for any employer in the US.')
    // One application row, with the edited company and exactly one generated draft.
    expect(apps).toHaveLength(1)
    expect(apps[0]!).toMatchObject({ company: 'Acme', generated_count: 1 })
    expect(apps[0]!.url).toContain('fixture-form.html')

    // Protocol hygiene: the host never wrote anything but frames to stdout, and it
    // logged to stderr. A stray console.log would have corrupted every response.
    expect(host.stderr.join('')).toMatch(/host started/)
    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await host.stop()
    await fixtures.stop()
  }
})

test('a rate-limited codex leaves fields as needs-input and shows the right banner', async () => {
  const fixtures = await startFixtureServer()
  // Mapping runs on codex now, so the rate limit that degrades the resolve tier
  // is the CODEX one; claude stays healthy and is never reached here.
  const host = await startHost({ codexMode: 'rate_limit' })
  const ext = await launchWithExtension()
  try {
    // Seeded so "only the LLM tier degraded" is something this test can actually
    // observe: without a stored profile the deterministic tier would have nothing
    // to fill and its assertion below could not fail. O3 era: the seed is ALSO
    // the onboarding gate's precondition now — see the first test.
    seedOnboardedProfile(host.dbPath, { firstName: 'Ada' })
    await seedResume(ext)

    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/fixture-form.html`)
    // Same reason as the first test: an active CAPTCHA returns before `resolve` is
    // ever called, so the rate-limit banner would never appear.
    // Assert the stub is THERE first: a bare post-condition of "count 0" would
    // also pass if the fixture had quietly lost its stub, which would silently
    // gut Task 14's active-CAPTCHA assertion instead of failing here.
    await expect(target.locator(STUB_SELECTOR)).toHaveCount(1)
    await target.evaluate((sel) => { document.querySelector(sel)?.remove() }, STUB_SELECTOR)
    await expect(target.locator(STUB_SELECTOR)).toHaveCount(0)
    const tabId = await tabIdForUrl(ext, 'fixture-form.html')

    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))

    // The auto-scan on open is the scan; clicking Scan again would race it.
    await expect(panel.locator('[data-jff-banner="error"]')).toContainText('Subscription rate limit', { timeout: 60_000 })
    // Deterministic fills still happened; only the LLM tier degraded.
    await expect(panel.locator('li[data-jff-tier="needs_input"]').first()).toBeVisible()
    await expect(target.locator('#first_name')).toHaveValue('Ada')
  } finally {
    await ext.close()
    await host.stop()
    await fixtures.stop()
  }
})

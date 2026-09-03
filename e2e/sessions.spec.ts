import DatabaseCtor from 'better-sqlite3'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { ONBOARDED_PROFILE, seedResume } from './seed'
import { startFixtureServer } from './static-server'
import { startHost } from './hostBridge'

/**
 * The three cross-cutting flows the O/S slices added, in a real browser:
 *  1. the onboarding gate really blocks scanning, and the real UI really opens it;
 *  2. two tabs keep two independent sessions, and a panel reload rehydrates the
 *     right one out of chrome.storage.session;
 *  3. a same-site wizard step re-scans and the answer follows its LABEL onto a
 *     page that renumbered every ref.
 *
 * Flows 2 and 3 use `?tabId=` OVERRIDE mode, which ignores `activated` entirely
 * (S2 constraint 3). That is deliberate: it makes two panels drivable side by
 * side from one Playwright context, so isolation + rehydrate are provable here.
 * The in-window SWAP on tab activation is not expressible this way and is
 * covered by the App acceptance suite instead.
 */

/** Same budget rationale as full-loop.spec.ts: extension launch + SW relay cost
 *  tracks machine load; per-assertion budgets stay the behavioural gate. */
test.describe.configure({ timeout: 240_000 })

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  codex: { ok: true, path: '(fake)', detail: 'found' },
  codexAuth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

interface BridgeReq { requestId: string; method: string; params: unknown }
interface ResolveField { frameId: number; fid: number; epoch: number; label: string | null; kind: string; options: string[] }
interface ResolveParams { epoch: number; jobText: string; fields: ResolveField[] }

/**
 * `chrome.tabs` exists ONLY in an extension context, and the lookup must not
 * MOUNT the panel app: a second panel with no `?tabId=` binds to the active tab
 * and auto-scans it, racing the scan under test. manifest.json is an extension
 * resource, so it gets the full API surface with no app.
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

/**
 * A scripted host that resolves EVERY field as needs_input. No auto-fill means
 * no page writes at all, so what lands in a row can only have come from the
 * panel's own session state — which is precisely what flows 2 and 3 assert.
 * It also answers `profile.get` with the onboarded persona, the host-side half
 * of the O3 gate (`seedResume` supplies the extension-side half).
 */
async function installScriptedHost(panel: Page): Promise<void> {
  await panel.exposeFunction('__jffHostBridge', (req: BridgeReq) => {
    const { requestId, method } = req
    if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
    if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED_PROFILE }
    if (method === 'answerBank.get') return { requestId, ok: true, result: {} }
    if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
    if (method === 'applied.check') return { requestId, ok: true, result: { applied: null } }
    if (method === 'resolve') {
      const p = req.params as ResolveParams
      return {
        requestId, ok: true,
        result: {
          epoch: p.epoch,
          resolutions: p.fields.map((f) => ({
            handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
            tier: 'needs_input', value: null, source: null,
            key: null, answerId: null, reason: 'e2e',
          })),
          llmError: null,
        },
      }
    }
    return { requestId, ok: true, result: {} }
  })
}

/** The one free-text row both wizard fixtures carry, addressed by its LABEL —
 *  the only thing about it that survives a re-enumeration. */
const WHY = 'Why do you want to work here?'
const rowByLabel = (panel: Page, label: string) =>
  panel.locator('[data-jff-rows] li', { hasText: label })

test('the onboarding gate blocks scanning until the real setup flow completes (O2/O3)', async () => {
  const fixtures = await startFixtureServer()
  const host = await startHost({ mode: 'ok' })
  const ext = await launchWithExtension()
  // NO seeding, on purpose: a fresh host home with an empty profile table and an
  // extension origin with no stored resume is exactly a first-run user.
  const cvPath = join(tmpdir(), `jff-onboarding-cv-${Date.now()}.txt`)
  writeFileSync(cvPath, 'Kevin Shibuya — platform engineer\n')
  try {
    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/plain-form.html`)
    const tabId = await tabIdForUrl(ext, 'plain-form.html')

    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: BridgeReq) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))

    // THE GATE. Not just "the wall rendered" — the scan UI must be absent, and
    // no scan may have run: `[data-jff-status]` is the panel's only scan-outcome
    // surface and `[data-jff-rows]` the only row surface, and both live inside
    // the branch OnboardingView replaces.
    await expect(panel.locator('[data-jff-onboarding]')).toBeVisible({ timeout: 60_000 })
    await expect(panel.locator('[data-jff-onboarding]')).toContainText('Welcome — set up your profile')
    await expect(panel.locator('[data-jff-status]')).toHaveCount(0)
    await expect(panel.locator('[data-jff-rows]')).toHaveCount(0)
    // Finish is disabled until every requirement is satisfied.
    await expect(panel.locator('[data-jff-ob-finish]')).toBeDisabled()

    // …and the real UI is what opens it. A .txt stores the blob and skips the
    // PDF auto-extract (spec O2), so the facts below are genuinely user-typed.
    await panel.locator('[data-jff-ob-resume] input[type="file"]').setInputFiles(cvPath)
    await expect(panel.locator('[data-jff-ob-resume]')).toContainText('jff-onboarding-cv')
    await panel.locator('#ob-email').fill(ONBOARDED_PROFILE.email!)
    await panel.locator('#ob-phone').fill(ONBOARDED_PROFILE.phone!)
    await panel.locator('#ob-fullName').fill(ONBOARDED_PROFILE.fullName!)
    await expect(panel.locator('[data-jff-ob-finish]')).toBeEnabled()
    await panel.locator('[data-jff-ob-finish]').click()

    // The gate's one sanctioned exit: the wall goes, the auto-scan fires without
    // a second click, and it SETTLES (plain-form.html has fields and no captcha).
    await expect(panel.locator('[data-jff-onboarding]')).toHaveCount(0, { timeout: 60_000 })
    await expect(panel.locator('[data-jff-status]'))
      .toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })

    // The typed facts really reached SQLite through the real host — a panel that
    // unlocked itself without persisting would pass every assertion above.
    const db = new DatabaseCtor(host.dbPath, { readonly: true })
    const rows = db.prepare('SELECT key, value FROM profile').all() as { key: string; value: string }[]
    db.close()
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    expect(stored).toMatchObject({
      email: ONBOARDED_PROFILE.email,
      phone: ONBOARDED_PROFILE.phone,
      fullName: ONBOARDED_PROFILE.fullName,
    })

    expect(ext.consoleErrors).toEqual([])
  } finally {
    rmSync(cvPath, { force: true })
    await ext.close()
    await host.stop()
    await fixtures.stop()
  }
})

test('two tabs keep two sessions, and a panel reload rehydrates its own (S2/S6)', async () => {
  const fixtures = await startFixtureServer()
  const ext = await launchWithExtension()
  const DRAFT_A = 'tab A: because the platform work is the interesting part'
  const DRAFT_B = 'tab B: an entirely different application, same browser'
  try {
    await seedResume(ext)

    // Same fixture, two DISTINCT urls: the static server strips the query string
    // before resolving the file, so `?tab=a|b` gives two tabs one chrome.tabs
    // lookup can still tell apart.
    const tabA = await ext.context.newPage()
    await tabA.goto(`${fixtures.origin}/wizard-step1.html?tab=a`)
    const idA = await tabIdForUrl(ext, 'wizard-step1.html?tab=a')
    const tabB = await ext.context.newPage()
    await tabB.goto(`${fixtures.origin}/wizard-step1.html?tab=b`)
    const idB = await tabIdForUrl(ext, 'wizard-step1.html?tab=b')
    expect(idA).not.toBe(idB)

    const panelA = await ext.context.newPage()
    await installScriptedHost(panelA)
    await panelA.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${idA}`))
    await expect(panelA.locator('[data-jff-status]'))
      .toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })
    await expect(panelA.locator('main[data-jff-ready]')).toHaveAttribute('data-jff-session', String(idA))
    await rowByLabel(panelA, WHY).locator('textarea').fill(DRAFT_A)

    const panelB = await ext.context.newPage()
    await installScriptedHost(panelB)
    await panelB.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${idB}`))
    await expect(panelB.locator('[data-jff-status]'))
      .toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })
    await expect(panelB.locator('main[data-jff-ready]')).toHaveAttribute('data-jff-session', String(idB))
    // B's row starts EMPTY — A's draft is not global state.
    await expect(rowByLabel(panelB, WHY).locator('textarea')).toHaveValue('')
    await rowByLabel(panelB, WHY).locator('textarea').fill(DRAFT_B)

    // Live isolation: B's work did not reach A's screen.
    await expect(rowByLabel(panelA, WHY).locator('textarea')).toHaveValue(DRAFT_A)

    // Wait for A's row to actually be IN chrome.storage.session before reloading
    // — the save is debounced, and asserting a rehydrate against a row that was
    // never written would be testing the pagehide flush by accident. Read it
    // from panel B, which is an extension page with the same storage area.
    await expect
      .poll(
        () => panelB.evaluate(async (key) => {
          const got = await chrome.storage.session.get(key) as Record<string, unknown>
          return JSON.stringify(got[key] ?? null)
        }, `jff:session:${idA}`),
        { timeout: 30_000, message: "tab A's session never reached storage.session" },
      )
      .toContain(DRAFT_A)

    // S6: the reload throws away every bit of in-memory state. What comes back
    // must be A's session — its tab id AND its draft — not B's, and not nothing.
    await panelA.reload()
    await expect(panelA.locator('main[data-jff-ready]'))
      .toHaveAttribute('data-jff-session', String(idA), { timeout: 60_000 })
    await expect(rowByLabel(panelA, WHY).locator('textarea')).toHaveValue(DRAFT_A, { timeout: 60_000 })

    // …and A's reload (which prunes the session store on boot) left B untouched.
    await expect(panelB.locator('main[data-jff-ready]')).toHaveAttribute('data-jff-session', String(idB))
    await expect(rowByLabel(panelB, WHY).locator('textarea')).toHaveValue(DRAFT_B)

    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await fixtures.stop()
  }
})

test('a same-site wizard step re-scans and the answer follows its LABEL, not its ref (S4/S5)', async () => {
  const fixtures = await startFixtureServer()
  const ext = await launchWithExtension()
  const DRAFT = 'because the platform work is the interesting part'
  try {
    await seedResume(ext)

    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/wizard-step1.html`)
    const tabId = await tabIdForUrl(ext, 'wizard-step1.html')

    const panel = await ext.context.newPage()
    await installScriptedHost(panel)
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-status]'))
      .toHaveAttribute('data-jff-status', 'done', { timeout: 60_000 })

    // Step 1: two questions, one of which the user answers.
    await expect(panel.locator('[data-jff-rows] li')).toHaveCount(2)
    await expect(rowByLabel(panel, 'Salary expectation')).toHaveCount(1)
    await rowByLabel(panel, WHY).locator('textarea').fill(DRAFT)
    await expect(rowByLabel(panel, WHY).locator('textarea')).toHaveValue(DRAFT)

    // A same-site step. The panel learns about it from webNavigation, keeps the
    // session (no park) and re-scans on its own — no Scan click here.
    await target.locator('#continue').click()
    await expect(target).toHaveURL(/wizard-step2\.html$/)

    // 'Anything else?' exists ONLY on step 2, so waiting for it is what orders
    // the assertions below AFTER the re-scan settled. Without it, the step-1 row
    // still on screen would satisfy the carry assertion and prove nothing.
    await expect(rowByLabel(panel, 'Anything else?')).toHaveCount(1, { timeout: 60_000 })
    await expect(panel.locator('main[data-jff-ready]')).toHaveAttribute('data-jff-session', String(tabId))

    // S4, the whole point: step 2 renumbered every ref (the answered question
    // moved to second place) and dropped one field, yet the answer re-attached
    // to the question by LABEL…
    await expect(rowByLabel(panel, WHY).locator('textarea')).toHaveValue(DRAFT)
    // …the question the user has never seen arrives EMPTY…
    await expect(rowByLabel(panel, 'Anything else?').locator('textarea')).toHaveValue('')
    // …and the field that only existed on step 1 is gone from the panel too.
    await expect(rowByLabel(panel, 'Salary expectation')).toHaveCount(0)
    await expect(panel.locator('[data-jff-rows] li')).toHaveCount(2)

    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await fixtures.stop()
  }
})

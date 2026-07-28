# Scan Observability + Async Busy States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every silent failure and every in-flight async action in the panel visible: a scan status line with phase/outcome states and a diagnostics disclosure, loud relay errors, a one-shot 0-field retry, and busy states on all async buttons.

**Architecture:** `runScan` gains a required `onProgress` callback and returns per-frame `frameReports`; the panel's relay wrappers throw instead of swallowing; the background broadcast records per-frame failures and frame URLs (broadcast logic extracted to a unit-testable `relay.ts`). A new `ScanStatus` component renders one status line + `<details>` diagnostics. App holds busy state for Scan/Save/Pick/Accept/Fill.

**Tech Stack:** TypeScript, React, Tailwind, vitest (+ @testing-library/react), Playwright (existing e2e harness).

**Spec:** `docs/superpowers/specs/2026-07-28-scan-observability-design.md` (approved).

## Global Constraints

- Never `any`. ESLint pinned at 8.57.1 must stay clean; `host/src` stdout-purity rules unaffected (no host changes in this plan).
- No network clients anywhere (`fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` grep must stay empty).
- Copy strings must match the spec's status table VERBATIM (they are asserted in tests):
  - connecting: `Waiting for the local host…`
  - injecting: `Reaching into the page…`
  - enumerating: `Scanning page (N frames)…`
  - retrying: `No fields yet — looking again…`
  - resolving: `Matching N fields… (a Claude call can take a minute)`
  - done: `✓ N filled, M proposed, K need input`
  - empty: `⚠ Scanned N frames, found no form fields. Open the application form, then Scan again.`
  - captcha: `⚠ CAPTCHA active — nothing was filled.`
  - failed: `✕ Scan failed: <reason>`
  - action_failed: `✕ <reason>` (Accept/Fill/Pick failures — loud, but not labeled "Scan failed")
- Retry delay is exactly `1_500` ms, exported as `RETRY_DELAY_MS` from `scan.ts`.
- No `console.log`/`console.error` added anywhere (foundation smoke enforces zero console errors).
- e2e runs against the seam build: `npm run smoke` (`JFF_TEST_SEAM=1`). Keep new e2e work inside the measured budgets in `playwright.config.ts`; the new smoke is light (no host, no claude).

## Pre-execution gates (orchestrator, before Task 1)

1. Fresh-context Opus review of THIS PLAN (reviewer-opus-high) + one codex-review cross-vendor pass. Findings fix the plan first.
2. Baseline verify: `npm run verify` (FULL suite including every e2e spec) must be green before Task 1.

## Task → Model routing

| Task | What | Model rung |
| ---- | ---- | ---------- |
| 1 | relay.ts extraction + background rewire | implementer-sonnet-medium |
| 2 | scan.ts progress/retry/reports + harness update | implementer-sonnet-medium |
| 3 | ScanStatus component | implementer-sonnet-medium |
| 4 | ui helper + FieldRow acting prop | editor-sonnet-low |
| 5 | App wiring | integrator-opus-high |
| 6 | e2e smoke + blank fixture | implementer-sonnet-medium |

Escalation: a task whose ATDD loop fails once re-dispatches to integrator-opus-high. Final review: reviewer-opus-high, fresh context, whole diff, **effort xhigh** — the diff spans ~12 files, well over 500 lines, across a relay/async-state surface (the standing escalation rule's threshold).

---

### Task 1: Extract the broadcast relay into `relay.ts` (URLs + failure recording)

**Files:**
- Create: `extension/src/relay.ts`
- Create: `extension/src/relay.test.ts`
- Modify: `extension/src/background.ts` (broadcast + single-frame branches of the `toContent` handler, and the discovery no-op)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 2 and 5 rely on these over-the-wire shapes):
  - `broadcast(deps: RelayDeps, tabId: number, message: unknown): Promise<{ replies: RelayReply[]; failures: RelayFailure[] }>`
  - `RelayReply = { frameId: number; url: string | null; payload: unknown }`
  - `RelayFailure = { frameId: number; url: string | null; error: string }`
  - Background `toContent` broadcast response becomes `{ ok: true, replies, failures }`; single-frame response `{ ok: true, replies: [{ frameId, url: null, payload }], failures: [] }`; hard failure `{ ok: false, error: string }`.
  - Background `inject` response unchanged: `{ ok: true, frames: number[] }` / `{ ok: false, error: string }`.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/relay.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { broadcast, type RelayDeps } from './relay'

function makeDeps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    discoverFrames: vi.fn(async () => [
      { frameId: 0, url: 'https://top.example/apply' },
      { frameId: 7, url: 'https://ats.example/embed' },
    ]),
    sendToFrame: vi.fn(async (_tabId, frameId) => ({ ok: true, from: frameId })),
    ...over,
  }
}

describe('broadcast', () => {
  it('stamps every reply with the frame id and url from discovery', async () => {
    const out = await broadcast(makeDeps(), 1, { type: 'JFF_PROBE' })
    expect(out.replies).toEqual([
      { frameId: 0, url: 'https://top.example/apply', payload: { ok: true, from: 0 } },
      { frameId: 7, url: 'https://ats.example/embed', payload: { ok: true, from: 7 } },
    ])
    expect(out.failures).toEqual([])
  })

  it('records a failing frame in failures and still returns the other replies', async () => {
    // This is the silent-skip fix: before this module, a frame whose sendMessage
    // threw simply vanished from the reply set.
    const deps = makeDeps({
      sendToFrame: vi.fn(async (_tabId, frameId) => {
        if (frameId === 7) throw new Error('Could not establish connection')
        return { ok: true, from: frameId }
      }),
    })
    const out = await broadcast(deps, 1, { type: 'JFF_SCAN', epoch: 1 })
    expect(out.replies.map((r) => r.frameId)).toEqual([0])
    expect(out.failures).toEqual([
      { frameId: 7, url: 'https://ats.example/embed', error: 'Error: Could not establish connection' },
    ])
  })

  it('propagates a discovery failure instead of inventing an empty result', async () => {
    const deps = makeDeps({ discoverFrames: vi.fn(async () => { throw new Error('no tab') }) })
    await expect(broadcast(deps, 1, { type: 'JFF_PROBE' })).rejects.toThrow('no tab')
  })

  it('passes the tab id and message through to every frame send', async () => {
    const deps = makeDeps()
    await broadcast(deps, 42, { type: 'JFF_SNAPSHOT', epoch: 9 })
    expect(deps.sendToFrame).toHaveBeenCalledWith(42, 0, { type: 'JFF_SNAPSHOT', epoch: 9 })
    expect(deps.sendToFrame).toHaveBeenCalledWith(42, 7, { type: 'JFF_SNAPSHOT', epoch: 9 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/relay.test.ts`
Expected: FAIL — `Cannot find module './relay'`.

- [ ] **Step 3: Implement `extension/src/relay.ts`**

```ts
// The broadcast half of the service worker's relay, extracted so the
// failure-recording contract is unit-testable: a frame that cannot be reached
// must land in `failures`, never silently vanish from the reply set.

export interface RelayReply { frameId: number; url: string | null; payload: unknown }
export interface RelayFailure { frameId: number; url: string | null; error: string }

export interface RelayDeps {
  /** All frames of the tab, from a no-op executeScript (no webNavigation permission). */
  discoverFrames: (tabId: number) => Promise<{ frameId: number; url: string | null }[]>
  sendToFrame: (tabId: number, frameId: number, message: unknown) => Promise<unknown>
}

export async function broadcast(
  deps: RelayDeps, tabId: number, message: unknown,
): Promise<{ replies: RelayReply[]; failures: RelayFailure[] }> {
  const frames = await deps.discoverFrames(tabId)
  const replies: RelayReply[] = []
  const failures: RelayFailure[] = []
  for (const f of frames) {
    try {
      replies.push({ frameId: f.frameId, url: f.url, payload: await deps.sendToFrame(tabId, f.frameId, message) })
    } catch (e) {
      // Frame gone mid-broadcast, or the content script is not in it. The panel's
      // diagnostics need to SEE that, not infer it from an absent reply.
      failures.push({ frameId: f.frameId, url: f.url, error: String(e) })
    }
  }
  return { replies, failures }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/relay.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Rewire `background.ts`**

In `extension/src/background.ts`, add the import at the top:

```ts
import { broadcast, type RelayDeps } from './relay'
```

Add the real deps just above the `chrome.runtime.onMessage.addListener` call:

```ts
const relayDeps: RelayDeps = {
  discoverFrames: async (tabId) =>
    (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href }))
      .map((r) => ({ frameId: r.frameId, url: typeof r.result === 'string' ? r.result : null })),
  sendToFrame: (tabId, frameId, message) => chrome.tabs.sendMessage(tabId, message, { frameId }),
}
```

Replace the whole `if (req?.kind === 'toContent') { ... }` block with:

```ts
  if (req?.kind === 'toContent') {
    if (req.frameId != null) {
      chrome.tabs
        .sendMessage(req.tabId, req.message, { frameId: req.frameId })
        .then((r) => sendResponse({ ok: true, replies: [{ frameId: req.frameId, url: null, payload: r }], failures: [] }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    broadcast(relayDeps, req.tabId, req.message)
      .then((out) => sendResponse({ ok: true, ...out }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
```

(The old inline discovery loop and its `// frame gone` catch are deleted; `relay.ts` owns that now.)

- [ ] **Step 6: Verify types, lint, and the existing e2e contract shape**

Run: `npm run typecheck && npm run lint && npx vitest run extension/src`
Expected: all green. (foundation.spec's `t.send(...)` consumers only read `ok` and `replies`, both still present.)

- [ ] **Step 7: Mutation probe the failure recording**

Temporarily change `failures.push(...)` in `relay.ts` to a bare `continue`-equivalent (delete the push, keep the catch). Run `npx vitest run extension/src/relay.test.ts` — the "records a failing frame" test MUST fail. Restore the push, re-run, green.

- [ ] **Step 8: Commit**

```bash
git add extension/src/relay.ts extension/src/relay.test.ts extension/src/background.ts
git commit -m "feat(relay): record per-frame broadcast failures and frame urls"
```

---

### Task 2: `runScan` progress, frame reports, and the 0-field retry

**Files:**
- Modify: `extension/src/panel/scan.ts` (full replacement below)
- Modify: `extension/src/panel/scan.test.ts` (harness update + new tests)

**Interfaces:**
- Consumes: the Task 1 wire shape (via the NEW `sendToTab` contract below — the panel wrapper itself is Task 5).
- Produces (Tasks 3 and 5 rely on these):
  - `type ScanProgress = { phase: 'injecting' } | { phase: 'enumerating'; frames: number } | { phase: 'retrying' } | { phase: 'resolving'; fields: number }`
  - `interface FrameReport { frameId: number; url: string | null; fields: number | null; error: string | null }`
  - `interface FrameReply { frameId: number; url?: string | null; payload: unknown }` (url added)
  - `interface RelayFailure { frameId: number; url: string | null; error: string }` (re-declared here for the panel side)
  - `interface SendResult { replies: FrameReply[]; failures: RelayFailure[] }`
  - `ScanDeps` changes: `sendToTab: (frameId: number | undefined, message: ContentMessage) => Promise<SendResult>` (THROWS on relay failure); `inject: () => Promise<number[]>` (THROWS on relay failure); new required `onProgress: (p: ScanProgress) => void`; new required `sleep: (ms: number) => Promise<void>`.
  - `ScanOutcome` gains `frameReports: FrameReport[]`.
  - `export const RETRY_DELAY_MS = 1_500`.
  - `runScan` may now REJECT (relay failures propagate; the caller renders them).

- [ ] **Step 1: Update the test harness and every inline `sendToTab` stub**

In `extension/src/panel/scan.test.ts`, every stubbed `sendToTab` must return the new `SendResult` shape, and `makeDeps` must provide `onProgress`/`sleep` recorders. Update `makeDeps` to:

```ts
function makeDeps(over: Partial<ScanDeps> = {}) {
  const sent: ContentMessage[] = []
  const phases: string[] = []
  let epoch = 0
  const scanReply = (frameId: number, fields: EnumField[]) => ({
    frameId, url: 'https://ats.example/apply',
    payload: { ok: true, scan: { epoch, fields, unreachableWidgets: 0, activeCaptcha: false } },
  })
  const deps: ScanDeps = {
    tabId: 1,
    nextEpoch: () => ++epoch,
    inject: vi.fn(async () => [0]),
    sendToTab: vi.fn(async (_frameId, message) => {
      if (message.type === 'JFF_SCAN') return { replies: [scanReply(0, [field(0, 0), field(0, 1, { kind: 'file' })])], failures: [] }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: 'JD TEXT', selector: '#jd', source: 'heuristic' } } }], failures: [] }
      if (message.type === 'JFF_FILL_RESUME') return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      if (message.type === 'JFF_FILL') return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch, filled: [], failed: [] } } }], failures: [] }
      return { replies: [{ frameId: 0, payload: { ok: false } }], failures: [] }
    }),
    onProgress: vi.fn((p) => phases.push(p.phase)),
    sleep: vi.fn(async () => undefined),
    // `request` is generic on HostPort, so the stub needs an explicit cast at the
    // end of this object literal (`as unknown as HostPort`). Same everywhere below.
    port: {
      request: vi.fn(async (method: string) => {
        if (method === 'selector.get') return { ok: true, result: { selector: null } }
        if (method === 'resolve') {
          const resolutions: Resolution[] = [
            { handle: { frameId: 0, fid: 0, epoch }, tier: 'auto', value: 'V0', source: 'profile', key: 'email', answerId: null, reason: 'recognizer:email' },
          ]
          return { ok: true, result: { epoch, resolutions, llmError: null } }
        }
        return { ok: true, result: {} }
      }),
      onDisconnect: () => undefined,
      disconnect: () => undefined,
    } as unknown as HostPort,
    getResume: async () => ({ name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' }),
    pastedJobText: '',
    ...over,
  }
  // Record AFTER merging `over`, not inside the default stub. Several tests below
  // replace sendToTab wholesale; if only the default stub logged, their
  // `expect(sent).not.toContain('JFF_FILL')` would pass against an empty array —
  // a vacuously green assertion on the "never fill under a live CAPTCHA" rule.
  const inner = deps.sendToTab
  deps.sendToTab = vi.fn(async (frameId, message) => { sent.push(message); return inner(frameId, message) })
  return { deps, sent, phases }
}
```

Then mechanically convert EVERY test-local `sendToTab` stub in the file from `return [ ...replies ]` to `return { replies: [ ...replies ], failures: [] }`, and every `replies[0]`-style consumption of `runScan` internals stays untouched (tests only consume `sent` and outcomes). The existing CAPTCHA tests, fill-report tests, and jobtext tests keep their assertions; only stub return shapes change.

- [ ] **Step 2: Add the new behavior tests** (append inside `describe('runScan')`):

```ts
  it('emits injecting -> enumerating -> resolving on the happy path', async () => {
    const { deps, phases } = makeDeps({ getResume: async () => null })
    await runScan(deps)
    expect(phases).toEqual(['injecting', 'enumerating', 'resolving'])
    expect(deps.onProgress).toHaveBeenCalledWith({ phase: 'enumerating', frames: 1 })
    expect(deps.onProgress).toHaveBeenCalledWith({ phase: 'resolving', fields: 2 })
  })

  it('re-emits injecting/enumerating around the resume re-enumeration', async () => {
    const { deps, phases } = makeDeps()
    await runScan(deps)
    // resume path: inject, enumerate, (resume fill), enumerate again, resolve
    expect(phases).toEqual(['injecting', 'enumerating', 'enumerating', 'resolving'])
  })

  it('retries the enumeration ONCE after a delay when it finds zero fields', async () => {
    let calls = 0
    const { deps, phases } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          calls++
          const fields = calls === 1 ? [] : [field(0, 0)]
          return { replies: [{ frameId: 0, url: 'https://ats.example/apply', payload: { ok: true, scan: { epoch: 1, fields, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(deps.sleep).toHaveBeenCalledWith(1_500)
    expect(deps.inject).toHaveBeenCalledTimes(2)
    expect(phases).toEqual(['injecting', 'enumerating', 'retrying', 'injecting', 'enumerating', 'resolving'])
    expect(out.fields).toHaveLength(1)
  })

  it('returns the empty outcome WITHOUT any host call when both enumerations are empty', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
    expect(out.frameReports).toEqual([{ frameId: 0, url: 'https://top.example/', fields: 0, error: null }])
    // No selector.get, no resolve: an empty page must cost zero host round-trips.
    expect(deps.port.request).not.toHaveBeenCalled()
  })

  it('propagates a relay failure instead of swallowing it into an empty scan', async () => {
    const { deps, phases } = makeDeps({
      sendToTab: vi.fn(async () => { throw new Error('background relay dead') }),
    })
    await expect(runScan(deps)).rejects.toThrow('background relay dead')
    // The failure happened DURING enumeration; no phase may be emitted after it.
    expect(phases).toEqual(['injecting', 'enumerating'])
  })

  it('keeps first-attempt frame errors as evidence across the retry', async () => {
    let calls = 0
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          calls++
          if (calls === 1) {
            return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: false, error: 'bad_scan' } }], failures: [] }
          }
          return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.frameReports).toEqual([
      { frameId: 0, url: 'https://top.example/', fields: null, error: 'bad_scan' },
      { frameId: 0, url: 'https://top.example/', fields: 0, error: null },
    ])
  })

  it('reports a failed auto-fill send in frameReports instead of discarding the scan', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: null, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        if (message.type === 'JFF_FILL') throw new Error('frame gone')
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.resolutions).toHaveLength(1) // the scan and its paid resolve survived
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('fill failed'))).toBe(true)
  })

  it('reports per-frame errors and broadcast failures in frameReports', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          return {
            replies: [
              { frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } },
              { frameId: 3, url: 'https://weird.example/', payload: { ok: false, error: 'bad_scan' } },
            ],
            failures: [{ frameId: 7, url: 'https://ats.example/embed', error: 'no receiver' }],
          }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.frameReports).toEqual([
      { frameId: 7, url: 'https://ats.example/embed', fields: null, error: 'no receiver' },
      { frameId: 0, url: 'https://top.example/', fields: 1, error: null },
      { frameId: 3, url: 'https://weird.example/', fields: null, error: 'bad_scan' },
    ])
  })

  it('carries activeCaptcha through the empty outcome (captcha wins over empty in the UI)', async () => {
    const { deps, phases } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: null, payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: true } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.activeCaptcha).toBe(true)
    expect(out.fields).toEqual([])
    // Zero fields still retries once, and NEVER reaches resolving under a captcha.
    expect(phases).toEqual(['injecting', 'enumerating', 'retrying', 'injecting', 'enumerating'])
  })
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `npx vitest run extension/src/panel/scan.test.ts`
Expected: FAIL at RUNTIME (test files are excluded from `tsc` and vitest transpiles without typechecking): the old `enumerateAllFrames` iterates the harness's new `{ replies, failures }` object — `TypeError: replies is not iterable` (or equivalent) — plus the new tests failing on missing `onProgress` emissions.

- [ ] **Step 4: Replace `extension/src/panel/scan.ts`** with:

```ts
import type { ContentMessage, EnumField, HostErrorKind, Resolution, ResolveResult } from '@jff/shared'
import type { HostPort } from './port'
import type { StoredResume } from './resume'

export interface FrameReply {
  frameId: number
  url?: string | null
  payload: unknown
}

export interface RelayFailure { frameId: number; url: string | null; error: string }

export interface SendResult { replies: FrameReply[]; failures: RelayFailure[] }

/** One row of scan diagnostics: what each frame contributed, or why it could not. */
export interface FrameReport { frameId: number; url: string | null; fields: number | null; error: string | null }

export type ScanProgress =
  | { phase: 'injecting' }
  | { phase: 'enumerating'; frames: number }
  | { phase: 'retrying' }
  | { phase: 'resolving'; fields: number }

/** A page can report zero fields transiently (an iframe mid-navigation is skipped
 *  by executeScript). One delayed re-look absorbs that; more would turn the panel
 *  into a poller. */
export const RETRY_DELAY_MS = 1_500

export interface ScanDeps {
  tabId: number
  /** Monotonic epoch source. The PANEL owns it; content scripts only store it. */
  nextEpoch: () => number
  /** THROWS on relay failure — a page we cannot reach is an error, not an empty scan. */
  inject: () => Promise<number[]>
  /** THROWS on relay failure, same contract as inject. */
  sendToTab: (frameId: number | undefined, message: ContentMessage) => Promise<SendResult>
  onProgress: (p: ScanProgress) => void
  sleep: (ms: number) => Promise<void>
  port: HostPort
  getResume: () => Promise<StoredResume | null>
  pastedJobText: string
  hostname?: string
  url?: string
  company?: string | null
}

export interface ScanOutcome {
  epoch: number
  fields: EnumField[]
  resolutions: Resolution[]
  unreachableWidgets: number
  activeCaptcha: boolean
  jobText: string
  llmError: { kind: HostErrorKind; message: string } | null
  frameReports: FrameReport[]
}

interface ScanPayload {
  ok: boolean
  error?: string
  scan?: { epoch: number; fields: EnumField[]; unreachableWidgets: number; activeCaptcha: boolean }
}

interface Enumeration {
  fields: EnumField[]
  unreachableWidgets: number
  activeCaptcha: boolean
  reports: FrameReport[]
}

/** Broadcast a SCAN and stamp each field with the frame its reply came from. */
async function enumerateAllFrames(deps: ScanDeps, epoch: number): Promise<Enumeration> {
  const { replies, failures } = await deps.sendToTab(undefined, { type: 'JFF_SCAN', epoch })
  const reports: FrameReport[] = failures.map((f) => ({ frameId: f.frameId, url: f.url, fields: null, error: f.error }))
  const fields: EnumField[] = []
  let unreachableWidgets = 0
  let activeCaptcha = false
  for (const r of replies) {
    const p = r.payload as ScanPayload
    if (p?.ok !== true || p.scan === undefined) {
      // A malformed or refused reply is diagnostic evidence, not noise.
      reports.push({ frameId: r.frameId, url: r.url ?? null, fields: null, error: p?.error ?? 'unrecognized reply' })
      continue
    }
    unreachableWidgets += p.scan.unreachableWidgets
    activeCaptcha = activeCaptcha || p.scan.activeCaptcha
    // The content script cannot know its own frame id, so the panel stamps it here.
    for (const f of p.scan.fields) fields.push({ ...f, frameId: r.frameId, epoch })
    reports.push({ frameId: r.frameId, url: r.url ?? null, fields: p.scan.fields.length, error: null })
  }
  return { fields, unreachableWidgets, activeCaptcha, reports }
}

async function injectAndEnumerate(deps: ScanDeps): Promise<{ epoch: number; frameCount: number; enumd: Enumeration }> {
  deps.onProgress({ phase: 'injecting' })
  const frames = await deps.inject()
  const epoch = deps.nextEpoch()
  deps.onProgress({ phase: 'enumerating', frames: frames.length })
  return { epoch, frameCount: frames.length, enumd: await enumerateAllFrames(deps, epoch) }
}

export async function runScan(deps: ScanDeps): Promise<ScanOutcome> {
  // PHASE 0 — first enumeration, with ONE delayed retry on an all-empty result.
  let { epoch, frameCount, enumd } = await injectAndEnumerate(deps)
  if (enumd.fields.length === 0) {
    // First-attempt ERRORS are evidence (they may be WHY the page looked empty);
    // they survive the retry. First-attempt field counts are superseded.
    const firstErrors = enumd.reports.filter((r) => r.error !== null)
    deps.onProgress({ phase: 'retrying' })
    await deps.sleep(RETRY_DELAY_MS)
    ;({ epoch, frameCount, enumd } = await injectAndEnumerate(deps))
    enumd.reports = [...firstErrors, ...enumd.reports]
    if (enumd.fields.length === 0) {
      // An empty page must cost zero host round-trips: no selector.get, no resolve.
      return {
        epoch, fields: [], resolutions: [],
        unreachableWidgets: enumd.unreachableWidgets, activeCaptcha: enumd.activeCaptcha,
        jobText: deps.pastedJobText.trim(), llmError: null, frameReports: enumd.reports,
      }
    }
  }
  let { fields, unreachableWidgets, activeCaptcha, reports } = enumd

  // Job text: the user's paste always wins; otherwise learned selector, then heuristics.
  let jobText = deps.pastedJobText.trim()
  if (jobText === '') {
    const hostname = deps.hostname ?? ''
    const learned = await deps.port.request<{ selector: string | null }>('selector.get', { hostname, purpose: 'job_description' })
    const selector = learned.ok ? learned.result.selector : null
    const { replies } = await deps.sendToTab(0, { type: 'JFF_JOBTEXT', epoch, selector })
    const payload = replies[0]?.payload as { ok: boolean; jobText?: { text: string; selector: string | null; source: string } } | undefined
    if (payload?.ok === true && payload.jobText !== undefined && payload.jobText.source !== 'none') {
      jobText = payload.jobText.text
      if (payload.jobText.source === 'heuristic' && payload.jobText.selector !== null) {
        await deps.port.request('selector.save', { hostname, purpose: 'job_description', selector: payload.jobText.selector })
      }
    }
  }

  if (activeCaptcha) {
    // An active challenge means the extension does nothing at all on this page.
    return { epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
  }

  // PHASE 1 — resume first, then RE-ENUMERATE so the ATS auto-parse cannot clobber us.
  const resume = await deps.getResume()
  const fileField = fields.find((f) => f.kind === 'file')
  if (resume !== null && fileField !== undefined) {
    let resumeError: FrameReport | null = null
    try {
      await deps.sendToTab(fileField.frameId, {
        type: 'JFF_FILL_RESUME', epoch,
        handle: { frameId: fileField.frameId, fid: fileField.fid, epoch },
        fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
      })
    } catch (e) {
      // A dead resume-upload relay must not discard the whole scan: the field
      // list and the paid resolve are still worth having. Report and continue.
      resumeError = { frameId: fileField.frameId, url: null, fields: null, error: `resume upload failed: ${String(e)}` }
    }
    epoch = deps.nextEpoch()
    deps.onProgress({ phase: 'enumerating', frames: frameCount })
    const again = await enumerateAllFrames(deps, epoch)
    fields = again.fields
    unreachableWidgets = again.unreachableWidgets
    activeCaptcha = again.activeCaptcha
    reports = resumeError === null ? again.reports : [...again.reports, resumeError]

    if (activeCaptcha) {
      // Uploading a resume is a common trigger for an ATS challenge. Re-reading
      // activeCaptcha and then filling anyway would be worse than never re-reading
      // it: same blast radius, plus a paid resolve call.
      return { epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }
  }

  // PHASE 2 — the host resolves everything that is still open.
  deps.onProgress({ phase: 'resolving', fields: fields.length })
  const resolved = await deps.port.request<ResolveResult>('resolve', {
    epoch,
    url: deps.url ?? '',
    hostname: deps.hostname ?? '',
    company: deps.company ?? null,
    jobText,
    fields,
  })
  if (!resolved.ok) {
    return {
      epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText,
      llmError: resolved.error, frameReports: reports,
    }
  }

  // Auto-fill tier-1/tier-2 results only. `page` sourced values are already there.
  const byFrame = new Map<number, { handle: Resolution['handle']; value: string }[]>()
  for (const r of resolved.result.resolutions) {
    if (r.tier !== 'auto' || r.source === 'page' || r.value === null || r.value === '') continue
    const list = byFrame.get(r.handle.frameId) ?? []
    list.push({ handle: r.handle, value: r.value })
    byFrame.set(r.handle.frameId, list)
  }
  for (const [frameId, fills] of byFrame) {
    try {
      await deps.sendToTab(frameId, { type: 'JFF_FILL', epoch, fills })
    } catch (e) {
      // A frame that vanished mid-fill (wizard advanced, iframe swapped) is
      // evidence, not a reason to throw away the resolved scan.
      reports = [...reports, { frameId, url: null, fields: null, error: `fill failed: ${String(e)}` }]
    }
  }

  return {
    epoch, fields,
    resolutions: resolved.result.resolutions,
    unreachableWidgets, activeCaptcha, jobText,
    llmError: resolved.result.llmError,
    frameReports: reports,
  }
}
```

Notes on deliberate choices in this code:
- The resume re-enumeration re-emits `enumerating` with the frame count from the LAST inject (`frameCount`) — the frame set cannot be re-discovered without a re-inject, and a resume upload does not change it. It deliberately does NOT re-run the 0-field retry: a page that had fields and lost them mid-scan is the captcha/teardown path, not the transient-iframe path.
- The throw-on-relay-failure contract applies to `inject` and the ENUMERATING broadcasts (a page we cannot read is a failed scan). The resume send and the auto-fill sends instead catch and report into `frameReports`: at that point the scan holds a complete enumeration and (for fills) a paid resolve — aborting would discard good data over a partial-delivery problem.

- [ ] **Step 5: Run the scan tests**

Run: `npx vitest run extension/src/panel/scan.test.ts`
Expected: all green (existing + new). NOTE: `App.tsx` now has type errors against the new `ScanDeps` — that is expected and fixed in Task 5; do NOT run `npm run typecheck` as this task's gate.

- [ ] **Step 6: Mutation probes**

1. Delete the `await deps.sleep(RETRY_DELAY_MS)` line → the retry test's `toHaveBeenCalledWith(1_500)` must fail. Restore.
2. Replace the empty-outcome early return with a fall-through (let it call selector.get) → the "zero host round-trips" test must fail. Restore.
3. In `enumerateAllFrames`, drop the `failures.map(...)` seeding of `reports` → the frameReports test must fail. Restore.

Run after each: `npx vitest run extension/src/panel/scan.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add extension/src/panel/scan.ts extension/src/panel/scan.test.ts
git commit -m "feat(scan): progress phases, per-frame reports, loud relay failures, one-shot empty retry"
```

---

### Task 3: `ScanStatus` component

**Files:**
- Create: `extension/src/panel/ScanStatus.tsx`
- Create: `extension/src/panel/ScanStatus.test.tsx`

**Interfaces:**
- Consumes: `FrameReport` from `./scan` (Task 2).
- Produces (Task 5 relies on these):
  - `type ScanUiState = { kind: 'connecting' } | { kind: 'injecting' } | { kind: 'enumerating'; frames: number } | { kind: 'retrying' } | { kind: 'resolving'; fields: number } | { kind: 'done'; filled: number; proposed: number; needsInput: number } | { kind: 'empty'; frames: number } | { kind: 'captcha' } | { kind: 'failed'; reason: string } | { kind: 'action_failed'; reason: string }`
  - `ScanStatus({ status, reports }: { status: ScanUiState | null; reports: FrameReport[] })` — renders `null` when `status === null`; root carries `data-jff-status="<kind>"`; diagnostics `<details data-jff-diagnostics>` render when (`kind` is `empty` or `failed` or (`done` and some report has an error)) AND `reports.length > 0`.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/panel/ScanStatus.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScanStatus, type ScanUiState } from './ScanStatus'
import type { FrameReport } from './scan'

const okReport: FrameReport = { frameId: 0, url: 'https://top.example/apply', fields: 3, error: null }
const badReport: FrameReport = { frameId: 7, url: 'https://ats.example/embed', fields: null, error: 'no receiver' }

const statusEl = () => document.querySelector('[data-jff-status]')

describe('ScanStatus', () => {
  it('renders nothing before any scan has started', () => {
    render(<ScanStatus status={null} reports={[]} />)
    expect(statusEl()).toBeNull()
  })

  it.each<[ScanUiState, string]>([
    [{ kind: 'connecting' }, 'Waiting for the local host…'],
    [{ kind: 'injecting' }, 'Reaching into the page…'],
    [{ kind: 'enumerating', frames: 7 }, 'Scanning page (7 frames)…'],
    [{ kind: 'retrying' }, 'No fields yet — looking again…'],
    [{ kind: 'resolving', fields: 12 }, 'Matching 12 fields… (a Claude call can take a minute)'],
    [{ kind: 'done', filled: 8, proposed: 2, needsInput: 3 }, '✓ 8 filled, 2 proposed, 3 need input'],
    [{ kind: 'empty', frames: 7 }, '⚠ Scanned 7 frames, found no form fields. Open the application form, then Scan again.'],
    [{ kind: 'captcha' }, '⚠ CAPTCHA active — nothing was filled.'],
    [{ kind: 'failed', reason: 'boom' }, '✕ Scan failed: boom'],
    [{ kind: 'action_failed', reason: 'Fill failed: frame gone' }, '✕ Fill failed: frame gone'],
  ])('renders the spec copy for %j', (status, copy) => {
    render(<ScanStatus status={status} reports={[]} />)
    expect(screen.getByText(copy)).toBeTruthy()
    expect(statusEl()!.getAttribute('data-jff-status')).toBe(status.kind)
  })

  it('shows per-frame diagnostics on an empty outcome', () => {
    render(<ScanStatus status={{ kind: 'empty', frames: 2 }} reports={[okReport, badReport]} />)
    const details = document.querySelector('[data-jff-diagnostics]')
    expect(details).not.toBeNull()
    expect(details!.textContent).toContain('https://top.example/apply')
    expect(details!.textContent).toContain('3 fields')
    expect(details!.textContent).toContain('no receiver')
  })

  it('shows diagnostics on done ONLY when a frame reported an error', () => {
    const { rerender } = render(<ScanStatus status={{ kind: 'done', filled: 1, proposed: 0, needsInput: 0 }} reports={[okReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).toBeNull()
    rerender(<ScanStatus status={{ kind: 'done', filled: 1, proposed: 0, needsInput: 0 }} reports={[okReport, badReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).not.toBeNull()
  })

  it('hides diagnostics while a scan is running', () => {
    render(<ScanStatus status={{ kind: 'resolving', fields: 3 }} reports={[badReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).toBeNull()
  })

  it('shows the relay error in diagnostics when the scan failed before any frame replied', () => {
    // frameId -1 is the App's synthetic "the relay itself failed" report; it must
    // render as evidence, not as a bogus frame number.
    const relayReport: FrameReport = { frameId: -1, url: null, fields: null, error: 'Could not reach the page.' }
    render(<ScanStatus status={{ kind: 'failed', reason: 'Could not reach the page.' }} reports={[relayReport]} />)
    const details = document.querySelector('[data-jff-diagnostics]')
    expect(details).not.toBeNull()
    expect(details!.textContent).toContain('relay')
    expect(details!.textContent).toContain('Could not reach the page.')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/ScanStatus.test.tsx`
Expected: FAIL — `Cannot find module './ScanStatus'`.

- [ ] **Step 3: Implement `extension/src/panel/ScanStatus.tsx`**

```tsx
import type { FrameReport } from './scan'
import { MUTED } from './ui'

export type ScanUiState =
  | { kind: 'connecting' }
  | { kind: 'injecting' }
  | { kind: 'enumerating'; frames: number }
  | { kind: 'retrying' }
  | { kind: 'resolving'; fields: number }
  | { kind: 'done'; filled: number; proposed: number; needsInput: number }
  | { kind: 'empty'; frames: number }
  | { kind: 'captcha' }
  | { kind: 'failed'; reason: string }
  | { kind: 'action_failed'; reason: string }

function copyFor(s: ScanUiState): string {
  switch (s.kind) {
    case 'connecting': return 'Waiting for the local host…'
    case 'injecting': return 'Reaching into the page…'
    case 'enumerating': return `Scanning page (${s.frames} frames)…`
    case 'retrying': return 'No fields yet — looking again…'
    case 'resolving': return `Matching ${s.fields} fields… (a Claude call can take a minute)`
    case 'done': return `✓ ${s.filled} filled, ${s.proposed} proposed, ${s.needsInput} need input`
    case 'empty': return `⚠ Scanned ${s.frames} frames, found no form fields. Open the application form, then Scan again.`
    case 'captcha': return '⚠ CAPTCHA active — nothing was filled.'
    case 'failed': return `✕ Scan failed: ${s.reason}`
    case 'action_failed': return `✕ ${s.reason}`
  }
}

const TONE: Record<ScanUiState['kind'], string> = {
  connecting: MUTED, injecting: MUTED, enumerating: MUTED, retrying: MUTED, resolving: MUTED,
  done: 'text-green-700 dark:text-green-400',
  empty: 'text-amber-600 dark:text-amber-400',
  captcha: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  action_failed: 'text-red-600 dark:text-red-400',
}

/** One-line scan status + collapsible per-frame evidence. Diagnostics render only
 *  for settled outcomes: mid-scan the report list is last scan's, not this one's. */
export function ScanStatus({ status, reports }: { status: ScanUiState | null; reports: FrameReport[] }) {
  if (status === null) return null
  const settledWithEvidence =
    status.kind === 'empty' || status.kind === 'failed' ||
    (status.kind === 'done' && reports.some((r) => r.error !== null))
  return (
    <div className="my-2 text-[12px]" data-jff-status={status.kind} role="status">
      <p className={`m-0 ${TONE[status.kind]}`}>{copyFor(status)}</p>
      {settledWithEvidence && reports.length > 0 && (
        <details className="mt-1" data-jff-diagnostics="1">
          <summary className={`cursor-pointer ${MUTED}`}>details</summary>
          <ul className={`m-0 mt-1 list-none p-0 font-mono text-[11px] ${MUTED}`}>
            {/* index key: after a retry the same frameId can legitimately appear twice */}
            {reports.map((r, i) => (
              <li className="my-0.5 truncate" key={i} title={r.url ?? undefined}>
                {r.frameId === -1 ? 'relay' : `frame ${r.frameId}`} · {r.url ?? '(no url)'} · {r.error !== null ? r.error : `${r.fields ?? 0} fields`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/ScanStatus.test.tsx`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/ScanStatus.tsx extension/src/panel/ScanStatus.test.tsx
git commit -m "feat(panel): ScanStatus line with per-frame diagnostics disclosure"
```

---

### Task 4: Busy-label helper + FieldRow `acting` prop

**Files:**
- Modify: `extension/src/panel/ui.ts` (append helper)
- Modify: `extension/src/panel/FieldRow.tsx`
- Modify: `extension/src/panel/FieldRow.test.tsx` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 5 relies on these):
  - `ui.ts`: `export const busyLabel = (isBusy: boolean, idle: string, active: string): string => (isBusy ? active : idle)`
  - `FieldRowProps` gains `acting: 'accept' | 'fill' | null` — while non-null, Accept/Fill/Generate are disabled; the acting button's label becomes `Accepting…` / `Filling…`.

- [ ] **Step 1: Append the failing tests to `extension/src/panel/FieldRow.test.tsx`**

Append this self-contained block (it builds its own row fixtures; do not depend on the file's existing helpers, but DO reuse the file's existing imports of `render`/`screen` and add any missing ones):

```tsx
const actingField = (fid: number): EnumField => ({
  frameId: 0, fid, epoch: 1, label: `Q${fid}`, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false,
})
const actingResolution = (fid: number, tier: 'proposed' | 'needs_input'): Resolution => ({
  handle: { frameId: 0, fid, epoch: 1 }, tier, value: 'stored answer', source: tier === 'proposed' ? 'llm_key' : null,
  key: null, answerId: null, reason: 'test',
})
const proposedRow: Row = { ref: '0:1', field: actingField(1), resolution: actingResolution(1, 'proposed') }
const needsInputRow: Row = { ref: '0:2', field: actingField(2), resolution: actingResolution(2, 'needs_input') }
// NOTE: reuse the module-scope `noop` the file already declares at line 16 —
// redeclaring it is a SyntaxError that kills the whole test module.

describe('FieldRow acting states', () => {
  it('shows Accepting… and disables the button while an accept is in flight', () => {
    // row fixture: tier 'proposed' with a value, as the file's existing proposed-row fixture builds it
    render(<FieldRow row={proposedRow} edited={null} onEdit={noop} onAccept={noop} onGenerate={noop} onFill={noop} generating={false} filled={false} acting="accept" />)
    const btn = screen.getByRole('button', { name: 'Accepting…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows Filling… and disables Fill and Generate while a fill is in flight', () => {
    render(<FieldRow row={needsInputRow} edited={'my answer'} onEdit={noop} onAccept={noop} onGenerate={noop} onFill={noop} generating={false} filled={false} acting="fill" />)
    expect((screen.getByRole('button', { name: 'Filling…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Generate with AI' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders idle labels when nothing is acting', () => {
    render(<FieldRow row={proposedRow} edited={null} onEdit={noop} onAccept={noop} onGenerate={noop} onFill={noop} generating={false} filled={false} acting={null} />)
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
```

(Also add `import type { EnumField, Resolution } from '@jff/shared'` and `import type { Row } from './group'` if the file does not already import them. For the EXISTING tests: the file funnels every render through a shared `props` object at `FieldRow.test.tsx:19` — add `acting: null` to THAT object, one line. Do not rely on typecheck to catch a miss: test files are excluded from `tsc`, and a missing prop degrades to `acting === undefined`, which renders every button disabled and fails existing click tests confusingly.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/FieldRow.test.tsx`
Expected: FAIL — `acting` not a known prop / label not found.

- [ ] **Step 3: Implement**

Append to `extension/src/panel/ui.ts`:

```ts
/** One uniform busy pattern for every async button: swap the label, disable. */
export const busyLabel = (isBusy: boolean, idle: string, active: string): string => (isBusy ? active : idle)
```

In `extension/src/panel/FieldRow.tsx`: add to `FieldRowProps`:

```ts
  /** Which of this row's page-writing actions is in flight, if any. */
  acting: 'accept' | 'fill' | null
```

Destructure `acting` in the component. Import `busyLabel` from `./ui`. Change the Accept button to:

```tsx
          <button type="button" className={BTN_PRIMARY} disabled={acting !== null} onClick={() => onAccept(ref)}>
            {busyLabel(acting === 'accept', 'Accept', 'Accepting…')}
          </button>
```

Change the Generate button's `disabled` to `disabled={generating || acting !== null}` (label logic unchanged), and the Fill button to:

```tsx
            <button type="button" className={BTN_PRIMARY} disabled={value.trim() === '' || acting !== null} onClick={() => onFill(ref)}>
              {busyLabel(acting === 'fill', 'Fill', 'Filling…')}
            </button>
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/FieldRow.test.tsx`
Expected: all green. (`App.tsx` will show a missing-prop type error until Task 5 — expected; do not gate on typecheck here.)

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/ui.ts extension/src/panel/FieldRow.tsx extension/src/panel/FieldRow.test.tsx
git commit -m "feat(panel): per-row acting states for Accept and Fill"
```

---

### Task 5: App wiring — status, throwing relays, busy states everywhere

**Files:**
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `ScanStatus`/`ScanUiState` (Task 3), `busyLabel` (Task 4), `FieldRowProps.acting` (Task 4), `runScan`/`ScanDeps`/`SendResult`/`FrameReport`/`ScanProgress` (Task 2), background wire shapes (Task 1).
- Produces: the user-visible behavior; `data-jff-status` / `data-jff-diagnostics` for e2e (Task 6).

- [ ] **Step 1: Update the chrome mock and add failing tests in `App.test.tsx`**

Replace the `runtime.sendMessage` line of the `beforeEach` chrome stub with a kind- and message-aware default. CRITICAL: the default JFF_SCAN reply must contain at least one field — an all-empty default would push EVERY App test through the 0-field retry's real 1.5 s timer (pending timers firing after cleanup, flaky Scan-button label). Only the dedicated empty-state test overrides this with empty replies.

```ts
      sendMessage: vi.fn(async (msg: { kind?: string; message?: { type?: string } }) => {
        if (msg?.kind === 'inject') return { ok: true, frames: [0] }
        if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
          return {
            ok: true,
            replies: [{
              frameId: 0, url: 'https://jobs.acme.com/apply',
              payload: { ok: true, scan: { epoch: 1, fields: [{ frameId: -1, fid: 0, epoch: 1, label: 'Email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false }], unreachableWidgets: 0, activeCaptcha: false } },
            }],
            failures: [],
          }
        }
        if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
          return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        }
        if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
        return { ok: true }
      }),
```

Additionally, fix the EXISTING assertion at `App.test.tsx:50` — `screen.getByRole('button', { name: 'Scan' })` is a synchronous exact-name query that now races the auto-scan's `Scanning…` label. Change that one line to:

```ts
    expect(await screen.findByRole('button', { name: /^Scan(ning…)?$/ })).toBeTruthy()
```

Append new tests:

```tsx
describe('App scan status', () => {
  const scanReply = {
    ok: true,
    replies: [{
      frameId: 0, url: 'https://jobs.acme.com/apply',
      payload: { ok: true, scan: { epoch: 1, fields: [{ frameId: -1, fid: 0, epoch: 1, label: 'Email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false }], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  }

  it('reaches done after the auto-scan when the page has fields', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
    // fake host resolve returns zero resolutions; the copy reflects that honestly
    expect(screen.getByText('✓ 0 filled, 0 proposed, 0 need input')).toBeTruthy()
  })

  it('reaches empty (after the one-shot retry) when no frame has fields', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
      return { ok: true }
    })
    render(<App />)
    // The retry's 1.5s sleep is a REAL timer here (App injects the real sleep);
    // vitest.config.ts documents ~10x jsdom inflation under contention, so the
    // budget is wide.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('empty')
    }, { timeout: 8_000 })
  }, 15_000)

  it('surfaces an inject failure as a failed status instead of a silent no-op', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: false, error: 'Cannot access contents of the page' }
      return { ok: true, replies: [], failures: [] }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('failed')
    })
    expect(screen.getByText(/Cannot access contents of the page/)).toBeTruthy()
    // The synthetic relay report makes the diagnostics disclosure render even
    // though no frame ever replied.
    expect(document.querySelector('[data-jff-diagnostics]')).not.toBeNull()
  })

  it('surfaces a broadcast relay failure (inject fine, toContent dead) as failed', async () => {
    // Guards the sendToTab ok-check specifically: inject succeeds, so only the
    // broadcast guard can produce the failed status here.
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent') return { ok: false, error: 'relay exploded' }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('failed')
    })
    expect(screen.getByText(/relay exploded/)).toBeTruthy()
  })

  it('disables the Scan button and relabels it while a scan runs', async () => {
    // ONE-SHOT latch: only the FIRST inject hangs. A latch that returned a fresh
    // pending promise every time would deadlock the 0-field retry's second inject
    // and the scan would never settle.
    let release: (() => void) | null = null
    let injected = false
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject' && !injected) {
        injected = true
        return new Promise((r) => { release = () => r({ ok: true, frames: [0] }) })
      }
      return base(msg) // default: inject ok + one-field scan reply, so no retry runs
    })
    render(<App />)
    const btn = await screen.findByRole('button', { name: 'Scanning…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    release!()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy(), { timeout: 4_000 })
  }, 10_000)

  it('shows Saving… while the save round-trip is in flight', async () => {
    let release: (() => void) | null = null
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SNAPSHOT') {
        return new Promise((r) => { release = () => r({ ok: true, replies: [], failures: [] }) })
      }
      return { ok: true, replies: [], failures: [] }
    })
    render(<App />)
    await screen.findByText(/Host ready/)
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))
    expect(((await screen.findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true)
    release!()
    await screen.findByRole('button', { name: 'Save answers' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/App.test.tsx`
Expected: FAIL at RUNTIME (test files are excluded from `tsc`): no `[data-jff-status]` element, no `Scanning…` label — plus the pre-wiring App crashes against the Task 2 `runScan` contract (missing `onProgress`/`sleep`, `SendResult` shape).

- [ ] **Step 3: Rewire `App.tsx`**

All changes to `extension/src/panel/App.tsx`:

a. Imports — add:

```ts
import { runScan, type FrameReply, type FrameReport, type RelayFailure, type ScanProgress, type SendResult } from './scan'
import { ScanStatus, type ScanUiState } from './ScanStatus'
import { busyLabel } from './ui'   // merge into the existing ./ui import
```

(Remove the now-unused old `FrameReply`-only import form.)

b. New state next to the existing scan state:

```ts
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState<ScanUiState | null>(null)
  const [frameReports, setFrameReports] = useState<FrameReport[]>([])
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [acting, setActing] = useState<{ ref: string; action: 'accept' | 'fill' } | null>(null)
```

c. `resetScanState` additionally clears the new state:

```ts
    setScanStatus(null); setFrameReports([])
```

d. Replace `sendToTab` with the throwing, typed version:

```ts
  const sendToTab = async (frameId: number | undefined, message: ContentMessage): Promise<SendResult> => {
    const res = await chrome.runtime.sendMessage({ kind: 'toContent', tabId, frameId, message }) as
      { ok?: boolean; error?: string; replies?: FrameReply[]; failures?: RelayFailure[] } | undefined
    // A relay that answers ok:false — or does not answer at all — is a failure the
    // user must SEE. The old `?? []` here is how three real failure modes rendered
    // as "nothing happened".
    if (res?.ok !== true) throw new Error(res?.error ?? 'The extension background did not answer.')
    return { replies: res.replies ?? [], failures: res.failures ?? [] }
  }
```

e. In `onScan`: reset + status wiring + throwing inject. Replace the body of the `try` block's `runScan` call and outcome handling with:

```ts
      const hostname = hostnameOf(tab.url)
      // Company: the user's edit always wins; guess only while the field is empty.
      const co = companyOrNull ?? guessCompany(tab.title ?? '', hostname)
      if (co !== null && companyOrNull === null) setCompany(co)
      setScanning(true)
      setFrameReports([])
      const out = await runScan({
        tabId,
        nextEpoch: () => ++epochRef.current,
        inject: async () => {
          const r = await chrome.runtime.sendMessage({ kind: 'inject', tabId }) as
            { ok?: boolean; error?: string; frames?: number[] } | undefined
          if (r?.ok !== true) throw new Error(r?.error ?? 'Could not reach the page.')
          return r.frames ?? []
        },
        sendToTab,
        onProgress: (p: ScanProgress) => setScanStatus(
          p.phase === 'enumerating' ? { kind: 'enumerating', frames: p.frames }
          : p.phase === 'resolving' ? { kind: 'resolving', fields: p.fields }
          : { kind: p.phase },
        ),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        port,
        getResume: loadResume,
        pastedJobText: jobText,
        hostname,
        url: tab.url ?? '',
        company: co,
      })
      setFields(out.fields)
      setResolutions(out.resolutions)
      setUnreachable(out.unreachableWidgets)
      setActiveCaptcha(out.activeCaptcha)
      setFrameReports(out.frameReports)
      setEdits({})
      setGeneratedRefs([])
      setFilledRefs([])
      setSnapshot({})
      if (out.jobText !== '') setJobText(out.jobText)
      if (out.llmError !== null) setHostError(ERROR_COPY[out.llmError.kind])
      // DELIBERATE: these counts mirror the Filled/Proposed/Needs-input group
      // headers exactly (all `auto` resolutions count as "filled", including
      // page-sourced ones). Verifying fills against JFF_FILL reply payloads is a
      // future slice — spec's out-of-scope list.
      const filled = out.resolutions.filter((r) => r.tier === 'auto').length
      const proposed = out.resolutions.filter((r) => r.tier === 'proposed').length
      const needsInput = out.resolutions.filter((r) => r.tier === 'needs_input').length
      // Precedence: captcha > empty > llm failure > done. A captcha'd page may
      // also be field-less; the captcha is the actionable fact.
      setScanStatus(
        out.activeCaptcha ? { kind: 'captcha' }
        : out.fields.length === 0 ? { kind: 'empty', frames: out.frameReports.length }
        : out.llmError !== null ? { kind: 'failed', reason: ERROR_COPY[out.llmError.kind] }
        : { kind: 'done', filled, proposed, needsInput },
      )
```

and wrap with the catch/finally:

```ts
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      setScanStatus({ kind: 'failed', reason })
      // Synthetic relay report (frameId -1): without it the diagnostics
      // disclosure could NEVER render for inject/broadcast failures, because
      // frameReports was cleared at scan start. ScanStatus renders -1 as "relay".
      setFrameReports([{ frameId: -1, url: null, fields: null, error: reason }])
    } finally {
      setScanning(false)
      scanningRef.current = false
    }
```

(`scanningRef` remains the synchronous re-entry guard exactly as before; the sleep uses real timers in the app.)

e2. The auto-scan effect gains the host gate that gives `connecting` its spec meaning ("covers the mount-to-selfCheck gap when the auto-scan is queued behind the host answer"). Replace the existing effect (`App.tsx:210`):

```ts
  // Auto-scan on open and after the bound tab NAVIGATES (a wizard step is new DOM).
  // Deliberately NOT keyed on resetCount: a tab switch or close clears state
  // without spending another batched `claude -p` resolve.
  // `hostAnswered` latches false->true ONCE (selfCheck answers or fails); keying
  // on `hostError` directly would re-fire the auto-scan every time a later host
  // error (e.g. an llmError) sets it — an accidental scan loop.
  const hostAnswered = check !== null || hostError !== null
  useEffect(() => {
    if (tabId === null) return
    if (!hostAnswered) { setScanStatus({ kind: 'connecting' }); return }
    void onScan()
  }, [tabId, scanNonce, hostAnswered])
```

`connecting` is set ONLY here — it exclusively means "waiting for the host before the queued auto-scan"; a manual Scan click starts directly at `injecting` (item e's code deliberately contains no `connecting`).

f. `onSaveAnswers` — busy + new sendToTab shape + catch:

```ts
  const onSaveAnswers = async (): Promise<void> => {
    const port = portRef.current
    if (port === null || tabId === null || saving) return
    setSaving(true)
    try {
      const stored = await chrome.storage.session.get(null) as Record<string, StoredSnapshot>
      const live: Record<string, string> = {
        ...snapshot,
        ...mergeStoredSnapshots(stored, tabId, epochRef.current),
      }
      for (const r of (await sendToTab(undefined, { type: 'JFF_SNAPSHOT', epoch: epochRef.current })).replies) {
        const p = r.payload as { ok: boolean; snapshot?: { values: Record<string, string> } }
        if (p?.ok !== true || p.snapshot === undefined) continue
        for (const [fid, v] of Object.entries(p.snapshot.values)) live[`${r.frameId}:${fid}`] = v
      }
      const items = buildSaveItems({ fields, resolutions, panelEdits: edits, snapshot: live, company: companyOrNull })
        .map((it) => ({ ...it, reusability: reuseOverrides[refOf(it.handle)] ?? it.reusability }))
      const tab = await getTab()
      const r = await port.request<{ saved: number }>('save', {
        url: tab?.url ?? '',
        company: companyOrNull,
        items,
        generatedCount: generatedRefs.length,
      })
      setSaveMsg(r.ok ? `Saved ${r.result.saved} answer(s).` : ERROR_COPY[r.error.kind])
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }
```

(The explanatory comments about merge sources stay where they are.)

g. `onPickJobText` — busy + new shape + catch:

```ts
  const onPickJobText = async (): Promise<void> => {
    if (tabId === null || fields.length === 0 || picking) return
    setPicking(true)
    try {
      // Always settles: click, Escape (pick_cancelled) or timeout (Task 17 Step 5).
      const { replies } = await sendToTab(0, { type: 'JFF_PICK', epoch: epochRef.current })
      const p = replies[0]?.payload as { ok: boolean; pick?: { selector: string; text: string } } | undefined
      if (p?.ok !== true || p.pick === undefined) return // cancelled; leave the paste box alone
      setJobText(p.pick.text)
      const tab = await getTab()
      const hostname = hostnameOf(tab?.url)
      if (hostname !== '') {
        await portRef.current?.request('selector.save', { hostname, purpose: 'job_description', selector: p.pick.selector })
      }
    } catch (e) {
      // A relay failure mid-pick is NOT a cancel: say so.
      setScanStatus({ kind: 'action_failed', reason: `Pick failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setPicking(false)
    }
  }
```

h. `fillOne` stops swallowing failures, and `onAccept`/`onFill` gain per-row acting + loud errors. Replace `fillOne` (it currently calls `chrome.runtime.sendMessage` directly and never checks `ok` — the exact silent-failure class this slice removes, on the two most user-visible buttons):

```ts
  /** Put one value on the page. Shared by Accept and Fill; what they additionally
   *  CONFIRM is the only difference between them. THROWS if the relay or the
   *  frame refused the fill — callers must not confirm anything on a throw. */
  const fillOne = async (row: Row, value: string): Promise<void> => {
    if (tabId === null || value === '') return
    const { replies } = await sendToTab(row.field.frameId, {
      type: 'JFF_FILL', epoch: row.field.epoch, fills: [{ handle: row.resolution.handle, value }],
    })
    const p = replies[0]?.payload as { ok?: boolean; error?: string } | undefined
    if (p?.ok !== true) throw new Error(p?.error ?? 'the page rejected the fill')
  }
```

Then the handlers (note: tier promotion / "on the page" marking happen ONLY on success — inside the try, after `fillOne`):

```ts
  const onAccept = async (ref: string): Promise<void> => {
    const row = groups.proposed.find((r) => r.ref === ref)
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value === '') return
    setActing({ ref, action: 'accept' })
    try {
      await fillOne(row, value)
      if (row.resolution.source === 'llm_key' && row.resolution.key !== null && row.field.label !== null) {
        void portRef.current?.request('mapping.confirm', { label: row.field.label, fieldKey: row.resolution.key })
      }
      setResolutions((rs) => rs.map((r) => (refOf(r.handle) === ref ? { ...r, tier: 'auto' as const } : r)))
    } catch (e) {
      setScanStatus({ kind: 'action_failed', reason: `Accept failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }

  const onFill = async (ref: string): Promise<void> => {
    const row = groups.needs_input.find((r) => r.ref === ref)
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value.trim() === '') return
    setActing({ ref, action: 'fill' })
    try {
      await fillOne(row, value)
      setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
    } catch (e) {
      setScanStatus({ kind: 'action_failed', reason: `Fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }
```

(The existing comments explaining Accept-vs-Fill semantics stay on these functions.)

i. Markup — the action row and status line:

```tsx
      <div className="my-2.5 flex items-center gap-2" data-jff-actions="1">
        <button type="button" className={BTN_PRIMARY} disabled={tabId === null || scanning} onClick={onScan}>
          {busyLabel(scanning, 'Scan', 'Scanning…')}
        </button>
        <button type="button" className={BTN} onClick={() => setShowEditor((s) => !s)}>
          {showEditor ? 'Back to fields' : 'Edit your facts'}
        </button>
      </div>

      <ScanStatus status={scanStatus} reports={frameReports} />
```

The Pick button:

```tsx
        <button type="button" className={`${BTN} mt-1`} disabled={fields.length === 0 || picking} onClick={onPickJobText}>
          {busyLabel(picking, 'Pick job description', 'Picking… (click the description on the page)')}
        </button>
```

The Save button:

```tsx
        <button type="button" className={BTN_PRIMARY} disabled={saving} onClick={onSaveAnswers}>
          {busyLabel(saving, 'Save answers', 'Saving…')}
        </button>
```

The FieldRow render gains the acting prop:

```tsx
                    <FieldRow
                      key={row.ref} row={row} edited={edits[row.ref] ?? null}
                      onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                      generating={generatingRef === row.ref}
                      filled={filledRefs.includes(row.ref)}
                      acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                    />
```

- [ ] **Step 4: Run the panel unit tests**

Run: `npx vitest run extension/src/panel`
Expected: all green (App, ScanStatus, FieldRow, scan, save, group, company, port, resume, tabScope).

- [ ] **Step 5: Full typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: green — this is the first task after which the whole workspace compiles again.

- [ ] **Step 6: Mutation probe the loud-failure guard**

In `sendToTab`, temporarily restore the old swallow (`return { replies: (res as { replies?: FrameReply[] })?.replies ?? [], failures: [] }` without the ok check). Run `npx vitest run extension/src/panel/App.test.tsx` — the **broadcast-failure** test (`'surfaces a broadcast relay failure (inject fine, toContent dead) as failed'`) must fail; the inject-failure test alone does NOT exercise this guard (it fails in the `inject` wrapper before `sendToTab` runs). Restore, re-run, green.

- [ ] **Step 7: Commit**

```bash
git add extension/src/panel/App.tsx extension/src/panel/App.test.tsx
git commit -m "feat(panel): scan status line, loud relay failures, busy states on all async actions"
```

---

### Task 6: Browser smoke — status states in a real Chromium

**Files:**
- Create: `e2e/fixtures/greenhouse-apply/blank.html`
- Modify: `e2e/foundation.spec.ts` (append one test)

**Interfaces:**
- Consumes: `data-jff-status` / `data-jff-diagnostics` (Tasks 3+5), the seam build's fake host (`?jffFakeHost=1`), `panelUrl(extensionId, query)` from `e2e/ext.ts`.
- Produces: nothing downstream.

- [ ] **Step 1: Create the field-less fixture**

`e2e/fixtures/greenhouse-apply/blank.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Blank fixture</title></head>
  <body>
    <h1>A careers page with no application form</h1>
    <p>Nothing to enumerate here.</p>
  </body>
</html>
```

- [ ] **Step 2: Append the failing smoke to `e2e/foundation.spec.ts`**

```ts
test('the panel surfaces scan outcomes: captcha on the fixture form, empty on a blank page', async () => {
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

  await panel2.close(); await blank.close(); await panel.close(); await finder.close(); await target.close()
})
```

Note: `finder` is an extension page (`panelUrl` pages can query tabs); a plain `ext.context.newPage()` cannot call `chrome.tabs`. If the existing harness pattern (`openFixtureTab`) computes tab ids from a panel page, reuse that pattern — the assertions above are the contract.

- [ ] **Step 3: Run the smoke to verify it fails against the pre-plan build, then passes**

Run: `npm run smoke -- foundation.spec.ts`
Expected on first run BEFORE tasks 1–5 are merged: fails (no `[data-jff-status]`). After tasks 1–5: green. (This task executes after Task 5, so a single green run suffices — the RED evidence is the locator having nothing to attach to if any wiring regressed.)

Watch the `afterAll` zero-console-errors gate: the two extra panel pages bind to fixture tabs (never to their own chrome-extension:// tab), so no injection into extension pages occurs in this test. The PRE-EXISTING tests that open `panelUrl` without `tabId` now auto-scan their own panel tab; injection into a `chrome-extension://` page fails, which the panel now catches and renders as a `failed` status — no console error is produced. If the smoke surfaces console errors from those tests, the fix belongs in the panel's catch path (it must stay silent on the console), NOT in the smoke.

- [ ] **Step 4: Full verify**

Run: `npm run verify`
Expected: typecheck, lint, unit, and all Playwright specs green, within the measured budgets in `playwright.config.ts`. If `panel-port.spec.ts` asserts on panel markup adjacent to the action row, update ONLY selectors/text that the new status line legitimately changed (the status line may show `✕ Scan failed:` on a panel bound to its own tab — assertions must not require its absence; they must not be loosened in any other way).

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/greenhouse-apply/blank.html e2e/foundation.spec.ts
git commit -m "test(e2e): panel scan-status smoke (captcha and empty outcomes in real Chromium)"
```

---

## Post-plan

- Re-run the Task 23 manual handshake from `docs/superpowers/plans/2026-07-27-job-form-filler-v1.md` line 10479 on the real TRM/Ashby page. The status line + diagnostics now report exactly which layer fails on the user's machine; record the outcome under `## Manual handshake log`.
- The environment-specific 0-field cause is DIAGNOSED by this plan, not fixed. File whatever the diagnostics reveal as the next slice.

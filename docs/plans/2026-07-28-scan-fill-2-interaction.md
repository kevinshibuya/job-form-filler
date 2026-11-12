# Scan/Fill Correctness — Plan 2 of 3: A-interaction (A6–A9) Implementation Plan

**Status:** completed 2026-07-29
Progress was tracked in the SDD ledger, which no longer exists. Checkboxes below reflect authoring, not execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scan INTERACT with the page correctly and scope everything to the real application frame: elect exactly one frame and send only its fields to resolve/auto-fill/resume/harvest (A7), harvest mounted combobox options from the elected frame without mutating page state (A6), target the resume upload by scoring instead of `fields.find` (A8), and rebuild the panel around document-order kind-aware rows with foreign fields demoted to a collapsed group and an honest filled/already-on-page status split (A9).

**Architecture:** Election and resume scoring are pure PANEL modules (`extension/src/panel/election.ts`, `resumeTarget.ts`) wired into `scan.ts`'s pinned phase order: enumerate → junk-filter → **elect** → jobText → **resume (scored, elected frame)** → **harvest (elected frame)** → resolve → auto-fill. Harvest is a new content message `JFF_HARVEST { epoch, fids }` (closed `ContentMessageSchema` gains the member) answered by a new content module `extension/src/content/harvest.ts` that opens, reads, closes and restores each combobox. Foreignness is DERIVED panel-side (`field.frameId !== electedFrameId`) — never an `EnumField` property — and `group.ts` mints the synthetic `other-frame` resolution so foreign rows render without touching the host. The panel replaces tier bucketing with document-order rows (`buildRows`) plus a tier badge; the status line's `done` state splits `filled` from `alreadyOnPage` (state shape lands NOW; B3 swaps the interim filled count for page-accepted reports in plan 3).

**Tech Stack:** TypeScript strict, zod (closed schemas in `shared/src`), vitest (extension=jsdom project), React panel, Playwright e2e with a SECOND static-server origin for the cross-origin iframe fixture. No new dependencies.

**Spec:** `docs/specs/2026-07-28-scan-fill-correctness-design.md` (approved; sections A6–A9). This plan covers Slice-A TODOs 12–17 and the rendered half of TODO 18. Predecessor: `docs/plans/2026-07-28-scan-fill-1-core.md` (A1–A5) — **this plan runs on the tree where plan 1 is fully executed and green**, and consumes its interfaces exactly (`LabelBinding`, `'choice'` kind, `EnumField.description`, `CHOICE_*` + `detectChoice`, `Measure.clipped`, `keepField`/`dropJunk` in `extension/src/panel/junk.ts`, the interim choice auto-fill guard in `scan.ts`). It re-creates none of them.

**Scope guard:** Do NOT implement fillChoice (B1), fillCombobox hardening (B2), or fill-report consumption (B3). Do not remove plan 1's interim choice auto-fill guard. Do not add an election override UI (spec-deferred; the named header is the mitigation). This plan only *produces the interfaces* plan 3 consumes (see "Interfaces produced for plan 3").

## Global Constraints

Copied from the spec (standing decisions) — every task's requirements implicitly include them:

> Constraints (standing decisions): generic engine, no per-ATS adapters — every heuristic below is justified as HTML/convention repair, not Ashby-specific; never auto-submit; panel-driven UX; thin extension / smart host; do not regress radio grouping by name, shadow-DOM walking, demographic skipping, per-frame injection, epoch/generation discipline.

Plus house rules:

- TypeScript everywhere, **never `any`**; prefer `unknown` + a narrowing cast at the reply boundary (the existing `payload as {...}` pattern). Root tsconfig has `exactOptionalPropertyTypes: false`.
- `shared/` and `host/` are Node ESM (`.js` import extensions); `extension/` is Vite/bundler-resolution (extensionless).
- Schemas in `shared/src` are CLOSED. This plan's ONLY additions: the `JFF_HARVEST` member of `ContentMessageSchema` and `EnumFieldSchema.accept` (see Plan decision 1). Add nothing else.
- Epoch/generation discipline is untouchable: `JFF_HARVEST` sits BELOW the content script's epoch gate; every post-await write in `App.tsx` stays generation-guarded; `scan.ts` keeps its evidence contract (ScanError with frameReports) at every new await.
- Harvest mutation containment: open/close only, no typing, value verified restored; failures degrade to `options: []` and never fail the scan.
- The content script's snapshot behavior and fid numbering are UNCHANGED. Election, junk filtering and foreignness are panel-side only.
- `npm run verify` (typecheck + lint + unit + e2e) green at the end of the slice; `npm run build` restores the plain dist afterward.
- Commit after every task. Never merge or push to `main` without explicit permission.

## Pre-execution gates (orchestrator, before Task 1)

1. Fresh-context Opus review of THIS PLAN (reviewer-opus-high) + one codex-review cross-vendor pass. Findings fix the plan first.
2. Baseline verify: `npm run verify` (FULL suite including every e2e spec: foundation, full-loop, panel-port) must be green on the plan-1-final tree before Task 1.

## Task → Model routing (initial assignment — the orchestrator re-judges at dispatch)

| Task | Model + effort | Why | Per-task verify |
| --- | --- | --- | --- |
| 1. Shared schema: `JFF_HARVEST` + `EnumField.accept` | editor-sonnet-low | Exact zod diffs + exact tests given. | `npx vitest run shared/src/messages.test.ts && npm run typecheck` |
| 2. Enumerate captures `accept` on file inputs | editor-sonnet-low | One property + two tests, code given. | `npx vitest run extension/src/content/enumerate.test.ts` |
| 3. Content harvest module + `index.ts` wiring | implementer-sonnet-medium | New DOM-interaction module: polling, attribution, restore semantics; full behavioral contract given. | `npx vitest run extension/src/content/harvest.test.ts && npm run typecheck` |
| 4. `election.ts` (A7 scoring) | editor-sonnet-low | Pure function, complete code + tests given. | `npx vitest run extension/src/panel/election.test.ts` |
| 5. `resumeTarget.ts` + `junk.ts` A8 seam | editor-sonnet-low | Complete code + tests given; the seam edit is one clause. | `npx vitest run extension/src/panel/resumeTarget.test.ts extension/src/panel/junk.test.ts` |
| 6. `scan.ts` orchestration: elect → jobText → resume → harvest → resolve | integrator-opus-high | The phase-order rewrite touches every return site's evidence contract and the epoch discipline. | `npx vitest run extension/src/panel/scan.test.ts && npm run typecheck` |
| 7. Host mapping prompt: combobox closed-set note | editor-sonnet-low | One string in one builder, exact diff given. | `npx vitest run host/src/llm/mapping.test.ts` |
| 8. `group.ts`: `buildRows` + synthetic foreign resolution | editor-sonnet-low | Complete code + tests given; `groupRows` stays until Task 11. | `npx vitest run extension/src/panel/group.test.ts && npm run typecheck` |
| 9. Status line: `filled` vs `already on page` state shape | editor-sonnet-low | Exact type/copy/count edits given across 4 files. | `npx vitest run extension/src/panel/ScanStatus.test.tsx extension/src/panel/App.test.tsx` |
| 10. `FieldRow` kind-aware editors + badges + hints | integrator-opus-high | User-facing UI composition (taste), 5 editor variants, new props consumed by Task 11. | `npx vitest run extension/src/panel/FieldRow.test.tsx && npm run typecheck` |
| 11. `App.tsx`: document-order rows, foreign group, resume row wiring | integrator-opus-high | Rewrites the render core + action lookups under the generation guard; largest test migration. | `npx vitest run extension/src/panel && npm run typecheck` |
| 12. e2e: second origin, election fixture + spec, selector migration | integrator-opus-high | New cross-origin harness + scripted host bridge; judgment about what the browser can prove. | `npm run smoke` |
| 13. Slice verification + dist restore + spec TODO ticks | verifier-sonnet-low | Mechanical command-set run + evidence. | `npm run verify && npm run build` |

**Escalation rule:** if a `-sonnet-` task fails its own test cycle twice, re-dispatch to `integrator-opus-high` rather than iterating.

## Interfaces produced for plan 3 (do not change their shapes without re-planning)

- **`ElectionOutcome`** (`extension/src/panel/scan.ts`): `{ frameId: number; score: number; url: string | null }`, carried as `ScanOutcome.election: ElectionOutcome | null`. B3's report plumbing stays scoped to the elected frame through it.
- **The scan-time auto-fill loop's per-frame `try/catch`** in `scan.ts` (the `for (const [frameId, fills] of byFrame)` block) is B3's collection site: the `JFF_FILL` replies it currently discards are what B3 turns into per-fid outcomes. Nothing else about the loop moves.
- **The interim choice auto-fill guard** (`choiceRefs` skip in `scan.ts`, from plan 1 Task 10) is STILL PRESENT after this plan. B1/B3 (plan 3) delete it when `fillChoice` + report consumption land.
- **`ScanUiState` `done` shape** (`extension/src/panel/ScanStatus.tsx`): `{ kind: 'done'; filled: number; alreadyOnPage: number; proposed: number; needsInput: number }`. `alreadyOnPage` is exact already. `filled` is an INTERIM attempted-count (marked with a `B3` comment in `App.tsx`); B3 replaces only the *count source* with the page-accepted number from collected FillReports — the type and copy do not change again.
- **`REASON_HINT`** (`extension/src/panel/FieldRow.tsx`): `Record<string, string>` mapping first-class refusal reasons to row hints. The `'choice-needs-user-click'` entry ("Select this answer on the page yourself.") ships NOW, so B1 only has to *return* the reason for the hint to render.
- **`attributableListbox(root, el, before)`** and **`mountedListboxes(root, el)`** exported from `extension/src/content/harvest.ts`: the listbox-attribution rule (aria-owns/controls, else appeared-after-interaction; NO document-wide "any listbox" fallback), searched over `scopeOf(el)` then the document so open-shadow-root widgets and portaled listboxes both work. B2's `fillCombobox` hardening reuses BOTH — the rule and the matching `before` snapshot — instead of re-deriving them.
- **`EnumField.accept?: string`** (`shared/src/field.ts`) and **`scoreResumeField` / `pickResumeTarget`** (`extension/src/panel/resumeTarget.ts`) — shared by `scan.ts` (upload target) and `App.tsx` (which file row gets "Put on page"); both recompute from the same pure function so they can never disagree.
- **`buildRows(fields, resolutions, electedFrameId)` + `FOREIGN_REASON = 'other-frame'`** (`extension/src/panel/group.ts`).
- **Two-origin e2e harness**: `startFixtureServer(root?)` + `e2e/fixtures/ashby-host/` + `e2e/fixtures/ashby-embed/` — plan 3's choice-fill e2e drives the same fixture pair.

## Fixture provenance

The e2e fixture pair (Task 12) distills the same live Ashby dump as plan 1's unit fixtures (`ashby-dump3.json`, session scratchpad, captured 2026-07-28), but as REAL pages with real CSS: the browser computes `display:none` on the hidden choice inputs and `clip: rect(0 0 0 0)` on the autofill-pane trap, which is what finally exercises `defaultMeasure`/`isClipped` outside jsdom (plan 1 injected measures). Checked in as project-owned files; the scratchpad is not a dependency.

---

## Task 1: Shared schema — `JFF_HARVEST` message + `EnumField.accept`

**Files:**
- Modify: `shared/src/messages.ts` (`ContentMessageSchema`, after the `JFF_FILL_RESUME` member)
- Modify: `shared/src/field.ts` (`EnumFieldSchema`, after `description`)
- Modify: `shared/src/messages.test.ts`

**Interfaces:**
- Consumes: plan 1's `EnumFieldSchema` (with `description`).
- Produces: `ContentMessageSchema` accepts `{ type: 'JFF_HARVEST', epoch, fids }` (the closed discriminated union would otherwise make the content script answer `bad_message`); `EnumFieldSchema.accept: z.string().optional()` (A8 scores the `accept` attribute panel-side and zod strips unknown keys — see Plan decision 1). A stale content script that omits `accept` still parses.

- [ ] **Step 1: Add failing tests to `shared/src/messages.test.ts`**

Append (extend the existing import from `./messages.js` with `ContentMessageSchema` if it is not already imported):

```ts
describe('ContentMessageSchema — JFF_HARVEST (A6)', () => {
  it('accepts a harvest request', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_HARVEST', epoch: 3, fids: [0, 4, 9] }).success).toBe(true)
  })

  it('rejects a harvest request without fids or with a negative epoch', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_HARVEST', epoch: 3 }).success).toBe(false)
    expect(ContentMessageSchema.safeParse({ type: 'JFF_HARVEST', epoch: -1, fids: [] }).success).toBe(false)
  })
})

describe('EnumFieldSchema — accept attribute (A8)', () => {
  it('accepts a file field carrying accept, and one without (stale content script)', () => {
    const base = {
      frameId: 0, fid: 1, epoch: 2, label: 'Resume', name: 'resume', idAttr: null,
      kind: 'file', options: [], required: true, visible: true,
      currentValue: null, demographic: false,
    }
    expect(EnumFieldSchema.safeParse({ ...base, accept: '.pdf,.doc,.docx' }).success).toBe(true)
    expect(EnumFieldSchema.safeParse(base).success).toBe(true)
  })

  it('round-trips accept instead of stripping it', () => {
    const parsed = EnumFieldSchema.parse({
      frameId: 0, fid: 1, epoch: 2, label: null, name: null, idAttr: null,
      kind: 'file', options: [], required: false, visible: false,
      currentValue: null, demographic: false, accept: 'application/pdf',
    })
    expect(parsed.accept).toBe('application/pdf')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run shared/src/messages.test.ts`
Expected: FAIL — `JFF_HARVEST` rejected by the closed union; `accept` stripped by the closed object.

- [ ] **Step 3: Implement**

`shared/src/messages.ts` — in `ContentMessageSchema`, after the `JFF_FILL_RESUME` member add:

```ts
  z.object({
    // A6: open the listed comboboxes, read their mounted options, close and
    // restore. ELECTED-frame-only is the PANEL's decision (it addresses the
    // frame directly); the content script enforces only the epoch gate.
    type: z.literal('JFF_HARVEST'),
    epoch: z.number().int().nonnegative(),
    fids: z.array(z.number().int().nonnegative()),
  }),
```

`shared/src/field.ts` — in `EnumFieldSchema`, after the `description` property add:

```ts
  /** A8: the file input's raw `accept` attribute, captured so the panel's
   *  resume scorer can read it (+1 for pdf/doc). File kinds only; optional so
   *  a stale content script simply omits it. */
  accept: z.string().optional(),
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run shared/src/messages.test.ts && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(shared): JFF_HARVEST content message and EnumField.accept for resume scoring"`

---

## Task 2: Enumerate captures `accept` on file inputs

**Files:**
- Modify: `extension/src/content/enumerate.ts` (the general-branch `fields.push` literal from plan 1 Task 7)
- Modify: `extension/src/content/enumerate.test.ts`

**Interfaces:**
- Consumes: `EnumField.accept` (Task 1).
- Produces: enumerated file fields carry `accept`; every other kind leaves it `undefined`. Fid numbering, stamping and snapshot behavior untouched.

- [ ] **Step 1: Add failing tests to `enumerate.test.ts`**

Append (reuse the file's existing `allVisible` measure helper):

```ts
describe('enumerateFields — file accept capture (A8)', () => {
  it('captures the accept attribute on file inputs', () => {
    document.body.innerHTML = '<label for="cv">Resume</label><input type="file" id="cv" accept=".pdf,.doc,.docx">'
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.accept).toBe('.pdf,.doc,.docx')
  })

  it('leaves accept undefined for non-file kinds and accept-less file inputs', () => {
    document.body.innerHTML = `
      <label for="x">Name</label><input id="x" type="text" accept=".pdf">
      <label for="y">Portfolio</label><input type="file" id="y">`
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields[0]!.accept).toBeUndefined()
    expect(fields[1]!.accept).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/content/enumerate.test.ts`
Expected: the new describe FAILS (`accept` undefined on the file field).

- [ ] **Step 3: Implement**

In `enumerate.ts`, in the general (non-radiogroup, non-choice) `fields.push({ ... })` literal — the one plan 1 Task 7 wrote — add after the `description:` line:

```ts
      accept: kind === 'file' ? el.getAttribute('accept') ?? undefined : undefined,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/content/enumerate.test.ts && npm run typecheck`
Expected: green, clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(content): enumerate captures the file accept attribute"`

---

## Task 3: Content harvest module + `index.ts` wiring

**Files:**
- Create: `extension/src/content/harvest.ts`, `extension/src/content/harvest.test.ts`
- Modify: `extension/src/content/index.ts` (one new branch, BELOW the epoch gate)

**Interfaces:**
- Consumes: `setNativeValue` (`./fill`), `elementByFid` (`./enumerate`), `JFF_HARVEST` (Task 1).
- Produces: `export const HARVEST_LISTBOX_TIMEOUT_MS = 500`; `export function attributableListbox(root: Document, el: Element, before: ReadonlySet<Element>): Element | null` (**B2 reuses this exact function** — plan 3); `export function mountedListboxes(root: Document, el: Element): Set<Element>` (the matching pre-interaction snapshot — B2 builds its `before` set with it); `export async function harvestOptions(root: Document, fids: number[]): Promise<Record<string, string[]>>` (string keys: the reply travels as JSON). The `JFF_HARVEST` branch in `index.ts` answers `{ ok: true, options }`.

Behavioral contract (spec A6, exact):
- Per fid: resolve via `elementByFid`; anything that is not combobox-shaped (`role=combobox` or `aria-haspopup=listbox`) answers `[]`.
- Snapshot the control's value BEFORE anything. Snapshot the set of mounted `[role=listbox]` elements — over `scopeOf(el)` AND the document, so a shadow-root widget is snapshotted in the same scopes attribution will search (shadow-DOM walking is a standing no-regression constraint; portaled listboxes are why the document is searched too). Real `.click()` to open. Poll (50ms) up to 500ms for an ATTRIBUTABLE listbox: aria-owns/aria-controls first (even if pre-mounted, resolved in the control's scope before the document), else a `[role=listbox]` NOT in the pre-click set. Read `[role=option]` texts (whitespace-normalized, empties dropped). Close via Escape `keydown` then `blur()`. If the value changed, restore the SNAPSHOT via `setNativeValue` — the restore target is always the snapshot itself, never a clear-to-`''` reset (Plan decision 4). No typing, ever.
- Any per-combobox throw degrades to `[]` — one broken widget never kills the batch, and the batch never fails the scan.

- [ ] **Step 1: Write `extension/src/content/harvest.test.ts` (failing)**

```ts
import { describe, it, expect } from 'vitest'
import { attributableListbox, harvestOptions } from './harvest'

function mountCombobox(html: string): HTMLInputElement {
  document.body.innerHTML = html
  const el = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  el.setAttribute('data-jff-fid', '0')
  return el
}

/** Ashby-style lazy listbox: mounted into the wrapper on click. */
function clickMountsListbox(el: HTMLElement, texts: string[]): void {
  el.addEventListener('click', () => {
    if (el.parentElement!.querySelector('[role="listbox"]') !== null) return
    const lb = document.createElement('ul')
    lb.setAttribute('role', 'listbox')
    for (const t of texts) {
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = t
      lb.appendChild(o)
    }
    el.parentElement!.appendChild(lb)
  })
}

describe('harvestOptions', () => {
  it('reads options from a listbox that appears in response to the click', async () => {
    const el = mountCombobox('<div><input role="combobox"></div>')
    clickMountsListbox(el, ['Brazil', 'Portugal'])
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Brazil', 'Portugal'] })
  })

  it('uses the aria-controls listbox even when it was mounted before the click', async () => {
    document.body.innerHTML = `
      <input role="combobox" aria-controls="lb1" data-jff-fid="0">
      <ul role="listbox" id="lb1"><li role="option">Alpha</li><li role="option">Beta</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Alpha', 'Beta'] })
  })

  it("never reads another control's pre-existing, unattributed listbox", async () => {
    document.body.innerHTML = `
      <div><input role="combobox" data-jff-fid="0"></div>
      <ul role="listbox"><li role="option">Not yours</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: [] })
  }, 10_000) // runs the real 500ms attribution timeout

  it('restores a pre-set value that the open/close mutated — never clears it', async () => {
    const el = mountCombobox('<div><input role="combobox" value="São Paulo"></div>')
    clickMountsListbox(el, ['A', 'B'])
    el.addEventListener('click', () => { el.value = 'clobbered-by-open' })
    await harvestOptions(document, [0])
    expect(el.value).toBe('São Paulo')
  })

  it('leaves an untouched value identical, with zero synthetic input events', async () => {
    const el = mountCombobox('<div><input role="combobox" value="Kept"></div>')
    clickMountsListbox(el, ['A'])
    let inputEvents = 0
    el.addEventListener('input', () => { inputEvents++ })
    await harvestOptions(document, [0])
    expect(el.value).toBe('Kept')
    expect(inputEvents).toBe(0)
  })

  it('closes via Escape so the page can retract its listbox', async () => {
    const el = mountCombobox('<div><input role="combobox"></div>')
    clickMountsListbox(el, ['A'])
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') el.parentElement!.querySelector('[role="listbox"]')?.remove()
    })
    await harvestOptions(document, [0])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('answers [] for a missing fid and for a non-combobox control', async () => {
    document.body.innerHTML = '<input type="text" data-jff-fid="3">'
    await expect(harvestOptions(document, [3, 99])).resolves.toEqual({ 3: [], 99: [] })
  })

  it('harvests a combobox inside an OPEN SHADOW ROOT (ids resolve in its own scope)', async () => {
    // `elementByFid` already pierces open shadow roots (walkElements); the
    // attribution lookup must too, or a shadow widget silently harvests nothing.
    document.body.innerHTML = '<my-combo></my-combo>'
    const shadow = document.querySelector('my-combo')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <input role="combobox" data-jff-fid="0" aria-controls="lb-s">
      <ul role="listbox" id="lb-s"><li role="option">Alpha</li><li role="option">Beta</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Alpha', 'Beta'] })
  })
})

describe('attributableListbox', () => {
  it('prefers aria-owns over an appeared listbox', () => {
    document.body.innerHTML = `
      <input role="combobox" aria-owns="mine">
      <ul role="listbox" id="mine"></ul>
      <ul role="listbox" id="other"></ul>`
    const el = document.querySelector('[role="combobox"]')!
    expect(attributableListbox(document, el, new Set())).toBe(document.getElementById('mine'))
  })

  it('falls back ONLY to a listbox absent from the before-set (no document-wide fallback)', () => {
    document.body.innerHTML = '<input role="combobox"><ul role="listbox" id="old"></ul>'
    const el = document.querySelector('[role="combobox"]')!
    const old = document.getElementById('old')!
    expect(attributableListbox(document, el, new Set([old]))).toBeNull()
    const fresh = document.createElement('ul')
    fresh.setAttribute('role', 'listbox')
    document.body.appendChild(fresh)
    expect(attributableListbox(document, el, new Set([old]))).toBe(fresh)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/content/harvest.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `extension/src/content/harvest.ts`**

```ts
import { setNativeValue } from './fill'
import { elementByFid } from './enumerate'
import { scopeOf } from './dom'

/** How long one combobox may take to mount an attributable listbox after our
 *  click. Past it the harvest degrades to `[]` — it never fails the scan. */
export const HARVEST_LISTBOX_TIMEOUT_MS = 500
const POLL_MS = 50

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const escAttr = (s: string): string => s.replace(/"/g, '\\"')

function isComboboxShaped(el: Element): boolean {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox'
}

/** The control's OWN scope first (an open shadow root), then the document —
 *  shadow-DOM walking is a standing no-regression constraint, and ids inside a
 *  shadow root are invisible to `document.querySelector`. The document is still
 *  consulted because real widgets portal their listbox to `<body>`. */
function listboxScopes(root: Document, el: Element): (Document | ShadowRoot)[] {
  const scope = scopeOf(el)
  return scope === root ? [root] : [scope as ShadowRoot, root]
}

/**
 * The listbox ATTRIBUTION rule (A6, reused by B2's fillCombobox hardening): a
 * listbox belongs to the control iff the control points at it
 * (aria-owns/aria-controls) or it appeared AFTER our interaction (`before` =
 * the listboxes mounted pre-click). The document-wide "any listbox" fallback is
 * exactly the cross-combobox bug the spec kills — never add it back. Both
 * lookups run over the control's scope AND the document, in that order.
 */
export function attributableListbox(root: Document, el: Element, before: ReadonlySet<Element>): Element | null {
  const scopes = listboxScopes(root, el)
  const owns = el.getAttribute('aria-owns') ?? el.getAttribute('aria-controls')
  if (owns !== null) {
    const first = owns.split(/\s+/)[0]
    if (first !== undefined && first !== '') {
      for (const s of scopes) {
        const found = s.querySelector(`[id="${escAttr(first)}"]`)
        if (found !== null) return found
      }
    }
  }
  for (const s of scopes) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) {
      if (!before.has(lb)) return lb
    }
  }
  return null
}

/** The pre-interaction listbox set, over the SAME scopes attribution searches —
 *  a shadow listbox missing from `before` would be misread as "appeared after
 *  our click". Exported because B2's fillCombobox must build it identically. */
export function mountedListboxes(root: Document, el: Element): Set<Element> {
  const out = new Set<Element>()
  for (const s of listboxScopes(root, el)) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) out.add(lb)
  }
  return out
}

function optionTexts(listbox: Element): string[] {
  return Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '')
}

async function harvestOne(root: Document, el: Element): Promise<string[]> {
  // Snapshot BEFORE touching anything: a page-sourced value (e.g. the ATS
  // resume auto-parse) must survive the harvest identically.
  const snapshot = el instanceof HTMLInputElement ? el.value : null
  const before = mountedListboxes(root, el)

  ;(el as HTMLElement).click()

  let options: string[] = []
  const deadline = Date.now() + HARVEST_LISTBOX_TIMEOUT_MS
  for (;;) {
    const listbox = attributableListbox(root, el, before)
    if (listbox !== null) {
      options = optionTexts(listbox)
      if (options.length > 0) break
    }
    if (Date.now() >= deadline) break
    await wait(POLL_MS)
  }

  // Close the way a user backs out: Escape, then blur. No typing, ever.
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  if (el instanceof HTMLElement) el.blur()

  // Restore the SNAPSHOT if open/close mutated the value. The restore target is
  // always the snapshot itself — never a clear-to-'' "reset" (spec A6).
  if (el instanceof HTMLInputElement && snapshot !== null && el.value !== snapshot) {
    setNativeValue(el, snapshot)
  }
  return options
}

/** JFF_HARVEST body: per-fid mounted option texts; `[]` on any failure. String
 *  keys because the reply crosses the JSON message boundary. */
export async function harvestOptions(root: Document, fids: number[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const fid of fids) {
    const el = elementByFid(root, fid)
    if (el === null || !isComboboxShaped(el)) {
      out[String(fid)] = []
      continue
    }
    try {
      out[String(fid)] = await harvestOne(root, el)
    } catch {
      // One broken combobox must not kill the batch — degrade to "no options".
      out[String(fid)] = []
    }
  }
  return out
}
```

- [ ] **Step 4: Wire the branch into `extension/src/content/index.ts`**

Add `import { harvestOptions } from './harvest'` to the imports. Then, AFTER the `JFF_FILL` branch (any position works as long as it sits BELOW the `if (msg.epoch !== getEpoch()) return { ok: false, error: STALE_EPOCH }` line — the epoch gate is what makes a stale harvest impossible), add:

```ts
  if (msg.type === 'JFF_HARVEST') {
    // A6: elected-frame-only is enforced by the PANEL (it addresses this frame
    // directly). This frame enforces the epoch gate above and degrades every
    // per-combobox failure to options: [].
    return { ok: true, options: await harvestOptions(document, msg.fids) }
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run extension/src/content && npm run typecheck && npm run lint`
Expected: harvest.test green, every pre-existing content suite still green, typecheck + lint clean.

- [ ] **Step 6: Commit**

`git commit -am "feat(content): JFF_HARVEST — open, read, close and restore comboboxes with strict listbox attribution"`

---

## Task 4: `election.ts` — A7 frame scoring

**Files:**
- Create: `extension/src/panel/election.ts`, `extension/src/panel/election.test.ts`

**Interfaces:**
- Consumes: `EnumField` from `@jff/shared`.
- Produces: `export interface FrameScore { frameId: number; fields: number; required: number; hasFile: boolean; score: number }`; `export interface Election { frameId: number; score: number; scores: FrameScore[] }`; `export function electFrame(fields: EnumField[]): Election | null`. Consumed by Task 6 (`scan.ts`).

- [ ] **Step 1: Write `extension/src/panel/election.test.ts` (failing)**

```ts
import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { electFrame } from './election'

const field = (frameId: number, fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId, fid, epoch: 1, label: `L${fid}`, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

describe('electFrame', () => {
  it('scores fields + 3×required + 5×file and picks the highest', () => {
    const e = electFrame([
      field(0, 0), // top frame: 1 plain field -> 1
      field(1, 0), field(1, 1, { required: true }), field(1, 2, { kind: 'file' }), // 3 + 3 + 5 = 11
    ])!
    expect(e.frameId).toBe(1)
    expect(e.score).toBe(11)
    expect(e.scores.find((s) => s.frameId === 0)!.score).toBe(1)
  })

  it('counts hasFile once, not per file input', () => {
    const e = electFrame([field(2, 0, { kind: 'file' }), field(2, 1, { kind: 'file' })])!
    expect(e.score).toBe(2 + 5)
  })

  it('breaks a score tie by most fields', () => {
    // A: 4 plain fields = 4; B: 1 required field = 1 + 3 = 4
    const e = electFrame([
      field(5, 0), field(5, 1), field(5, 2), field(5, 3),
      field(9, 0, { required: true }),
    ])!
    expect(e.frameId).toBe(5)
  })

  it('breaks a full tie by lowest frameId', () => {
    expect(electFrame([field(4, 0), field(4, 1), field(2, 0), field(2, 1)])!.frameId).toBe(2)
  })

  it('the top frame can win on signal (Greenhouse/Lever render in the top document)', () => {
    const e = electFrame([
      field(0, 0), field(0, 1, { required: true }), field(0, 2, { kind: 'file' }),
      field(3, 0),
    ])!
    expect(e.frameId).toBe(0)
  })

  it('elects a single frame as a no-op and returns null for zero fields', () => {
    expect(electFrame([field(0, 0)])!.frameId).toBe(0)
    expect(electFrame([])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/election.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `extension/src/panel/election.ts`**

```ts
import type { EnumField } from '@jff/shared'

export interface FrameScore {
  frameId: number
  fields: number
  required: number
  hasFile: boolean
  score: number
}

export interface Election {
  frameId: number
  score: number
  /** Every frame's breakdown — the "Other page fields" header and diagnostics
   *  can explain a mis-election instead of hiding it. */
  scores: FrameScore[]
}

/**
 * A7: which frame is THE application? By signal, never by frame position
 * (Greenhouse/Lever render in the top document, Ashby in an iframe).
 * Score = fields + 3×required + 5×(has file input). Deliberately NO jobText
 * term: jobText is requested from frame 0 only and skipped entirely when the
 * user pasted text, so it cannot be a fair signal (spec'd out).
 * Tie → most fields → lowest frameId.
 */
export function electFrame(fields: EnumField[]): Election | null {
  const byFrame = new Map<number, FrameScore>()
  for (const f of fields) {
    const s = byFrame.get(f.frameId) ?? { frameId: f.frameId, fields: 0, required: 0, hasFile: false, score: 0 }
    s.fields++
    if (f.required) s.required++
    if (f.kind === 'file') s.hasFile = true
    byFrame.set(f.frameId, s)
  }
  const scores = Array.from(byFrame.values())
  if (scores.length === 0) return null
  for (const s of scores) s.score = s.fields + 3 * s.required + (s.hasFile ? 5 : 0)
  scores.sort((a, b) => b.score - a.score || b.fields - a.fields || a.frameId - b.frameId)
  const winner = scores[0]!
  return { frameId: winner.frameId, score: winner.score, scores }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/election.test.ts && npm run typecheck`
Expected: green, clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): A7 frame election scoring — fields + 3×required + 5×file, signal not position"`

---

## Task 5: `resumeTarget.ts` + the A8 seam in `junk.ts`

**Files:**
- Create: `extension/src/panel/resumeTarget.ts`, `extension/src/panel/resumeTarget.test.ts`
- Modify: `extension/src/panel/junk.ts` (the file clause of `keepField` — the seam plan 1 documented)
- Modify: `extension/src/panel/junk.test.ts`

**Interfaces:**
- Consumes: `EnumField` (with `accept`, Task 1).
- Produces: `export const RESUME_LABEL_RE = /resume|cv|currícul/i`; `export function scoreResumeField(f: EnumField): number`; `export function pickResumeTarget(fields: EnumField[]): EnumField | null`. `keepField`'s file clause becomes label-OR-positive-score (no blanket keep, ever). Consumed by Task 6 (upload target) and Task 11 (which row gets "Put on page").

- [ ] **Step 1: Write `extension/src/panel/resumeTarget.test.ts` (failing)**

```ts
import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { pickResumeTarget, scoreResumeField } from './resumeTarget'

const file = (fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 1, fid, epoch: 1, label: null, name: null, idAttr: null, kind: 'file',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

describe('scoreResumeField', () => {
  it('scores +3 for a resume/cv/currículo label', () => {
    expect(scoreResumeField(file(0, { label: 'Resume' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'Currículo (PDF)' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'CV' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'Portfolio' }))).toBe(0)
  })

  it('scores +2 for a matching name or id', () => {
    expect(scoreResumeField(file(0, { name: 'resume-upload' }))).toBe(2)
    expect(scoreResumeField(file(0, { idAttr: 'cv_file' }))).toBe(2)
  })

  it('scores +1 for an accept mentioning pdf/doc and +2 for required, summing all terms', () => {
    expect(scoreResumeField(file(0, { accept: '.pdf,.doc,.docx' }))).toBe(1)
    expect(scoreResumeField(file(0, { required: true }))).toBe(2)
    expect(scoreResumeField(file(0, { label: 'Resume', name: 'resume', accept: 'application/pdf', required: true }))).toBe(8)
  })

  it('scores 0 for non-file kinds even with resume-ish labels', () => {
    expect(scoreResumeField({ ...file(0, { label: 'Resume' }), kind: 'text' })).toBe(0)
  })

  it('scores the Ashby autofill pane (unlabelled, optional, no signal) at 0', () => {
    expect(scoreResumeField(file(0))).toBe(0)
  })
})

describe('pickResumeTarget', () => {
  it('picks the highest positive scorer, never the first-in-document autofill pane', () => {
    const pane = file(1) // first in document order — the old fields.find() trap
    const real = file(2, { label: 'Resume', required: true, accept: '.pdf' })
    expect(pickResumeTarget([pane, real])).toBe(real)
  })

  it('returns null when nothing scores positive (no upload happens)', () => {
    expect(pickResumeTarget([file(1), file(2)])).toBeNull()
    expect(pickResumeTarget([])).toBeNull()
  })

  it('breaks score ties by document order', () => {
    const a = file(1, { label: 'Resume' })
    const b = file(2, { label: 'CV' })
    expect(pickResumeTarget([a, b])).toBe(a)
  })
})
```

- [ ] **Step 2: Add the seam tests to `extension/src/panel/junk.test.ts`**

Append inside `describe('keepField', ...)` (the file's `field()` helper already exists):

```ts
  it('keeps a hidden unlabelled file input that scores on the resume scorer (A8 seam)', () => {
    expect(keepField(field({ kind: 'file', visible: false, label: null, name: 'resume-upload' }))).toBe(true)
    expect(keepField(field({ kind: 'file', visible: false, label: null, required: true }))).toBe(true)
    // no label AND no scoring signal: still junk (the autofill-pane trap)
    expect(keepField(field({ kind: 'file', visible: false, label: null }))).toBe(false)
  })
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run extension/src/panel/resumeTarget.test.ts extension/src/panel/junk.test.ts`
Expected: resumeTarget FAILS (module missing); the new junk case FAILS (label-only clause).

- [ ] **Step 4: Implement**

`extension/src/panel/resumeTarget.ts`:

```ts
import type { EnumField } from '@jff/shared'

/** A8's label/name signal. `currícul` covers currículo and curricular forms. */
export const RESUME_LABEL_RE = /resume|cv|currícul/i
const ACCEPT_RE = /pdf|doc/i

/**
 * A8: how resume-like is this file field? +3 label match, +2 name/id match,
 * +1 accept mentions pdf/doc, +2 required. The Ashby autofill-pane input
 * (unlabelled, optional, no signal) scores 0 and can never be targeted.
 */
export function scoreResumeField(f: EnumField): number {
  if (f.kind !== 'file') return 0
  let score = 0
  if (f.label !== null && RESUME_LABEL_RE.test(f.label)) score += 3
  if ((f.name !== null && RESUME_LABEL_RE.test(f.name)) || (f.idAttr !== null && RESUME_LABEL_RE.test(f.idAttr))) score += 2
  if (f.accept !== undefined && ACCEPT_RE.test(f.accept)) score += 1
  if (f.required) score += 2
  return score
}

/** Highest POSITIVE score wins; ties go to document order. Zero positive
 *  candidates -> null: no upload, and the panel notes it (A9). */
export function pickResumeTarget(fields: EnumField[]): EnumField | null {
  let best: EnumField | null = null
  let bestScore = 0
  for (const f of fields) {
    const s = scoreResumeField(f)
    if (s > bestScore) { best = f; bestScore = s }
  }
  return best
}
```

`extension/src/panel/junk.ts` — add `import { scoreResumeField } from './resumeTarget'` and replace the file clause

```ts
  if (f.kind === 'file' && f.label !== null) return true
```

with:

```ts
  // A8 seam (this is the extension plan 1 documented): a hidden file input
  // earns its keep by a resolvable label OR by scoring positively on the
  // resume scorer (name/id/accept/required signals). Still no blanket keep —
  // an unlabelled, signal-less hidden file input (the autofill pane) is junk.
  if (f.kind === 'file' && (f.label !== null || scoreResumeField(f) > 0)) return true
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run extension/src/panel/resumeTarget.test.ts extension/src/panel/junk.test.ts && npm run typecheck`
Expected: green, clean.

- [ ] **Step 6: Commit**

`git commit -am "feat(panel): A8 resume-target scoring and the junk-filter file-clause seam"`

---

## Task 6: `scan.ts` orchestration — pinned phase order, election scoping, scored resume, harvest merge

**Files:**
- Modify: `extension/src/panel/scan.ts` (phases + every return site)
- Modify: `extension/src/panel/scan.test.ts` (one helper edit + two new describes)

**Interfaces:**
- Consumes: `electFrame` (Task 4), `pickResumeTarget` (Task 5), `JFF_HARVEST` (Tasks 1/3), plan 1's `dropJunk` + interim choice guard.
- Produces: `export interface ElectionOutcome { frameId: number; score: number; url: string | null }`; `ScanOutcome.election: ElectionOutcome | null`. Pinned phase order: enumerate → junk-filter → **elect** → jobText → **resume (scored, elected)** → re-enumerate+re-elect → **harvest (elected, merged before resolve)** → resolve (elected fields only) → auto-fill. `ScanOutcome.fields` still returns ALL kept fields (foreign included) — the panel derives foreignness from `election.frameId`. The auto-fill loop body and the interim choice guard are UNTOUCHED (B3/B1 own them).

Design constraints for the integrator (each is load-bearing):

1. **Election input = KEPT fields** (`dropJunk` output), not raw enumeration — hidden junk must not tilt the election (Plan decision 2). Compute right after `let kept = dropJunk(fields)`:

```ts
  // A7: election happens immediately after enumeration/junk-filtering, BEFORE
  // jobText, resume, harvest and resolve — everything page-touching or paid is
  // scoped to the elected frame. Scored over KEPT fields: junk (the hidden
  // reCAPTCHA textarea) must not be able to tilt the election.
  let election = electFrame(kept)
  const electedOf = (fs: EnumField[]): EnumField[] =>
    election === null ? fs : fs.filter((f) => f.frameId === election!.frameId)
  const electionOut = (): ElectionOutcome | null =>
    election === null ? null : {
      frameId: election.frameId,
      score: election.score,
      url: reports.find((r) => r.frameId === election!.frameId && r.url !== null)?.url ?? null,
    }
```

2. **jobText does not move.** It stays exactly where it is (frame 0 only, skipped on paste) — election merely runs before it. Do not add a jobText term to the election.
3. **Resume phase (A8):** replace `const fileField = kept.find((f) => f.kind === 'file')` with:

```ts
    // A8: never `find(kind === 'file')` — score the ELECTED frame's candidates;
    // zero positive scorers means NO upload (the autofill-pane trap).
    const fileField = pickResumeTarget(electedOf(kept))
    if (resume !== null && fileField !== null) {
```

After the re-enumeration assigns `fields = again.fields` (and plan 1's `kept = dropJunk(fields)`), add:

```ts
      // Fids were re-stamped under a new epoch; re-elect deterministically over
      // the fresh kept set. The application frame only gains signal from its
      // own resume-parse, so a flip means the form itself changed.
      election = electFrame(kept)
```

(The existing post-resume captcha/empty returns then report the recomputed election via `electionOut()` — for the empty case that is `null` by construction.)
4. **Harvest phase (A6)** goes AFTER the resume block and BEFORE PHASE 2's `onProgress('resolving')`:

```ts
    // A6: harvest mounted combobox options — ELECTED frame only, never
    // demographic, and only where enumeration found nothing (mutation
    // containment: open/close, no typing, snapshot-restored value).
    if (election !== null) {
      const harvestFids = electedOf(kept)
        .filter((f) => f.kind === 'combobox' && !f.demographic && f.options.length === 0)
        .map((f) => f.fid)
      if (harvestFids.length > 0) {
        try {
          const { replies } = await deps.sendToTab(election.frameId, { type: 'JFF_HARVEST', epoch, fids: harvestFids })
          const p = replies[0]?.payload as { ok?: boolean; options?: Record<string, string[]> } | undefined
          if (p?.ok === true && p.options !== undefined) {
            const opts = p.options
            const merge = (f: EnumField): EnumField => {
              const found = f.frameId === election!.frameId ? opts[String(f.fid)] : undefined
              return found !== undefined && found.length > 0 ? { ...f, options: found } : f
            }
            // Merged BEFORE resolve: the mapping prompt sees the harvested lists.
            fields = fields.map(merge)
            kept = kept.map(merge)
          }
        } catch (e) {
          // Harvest is best-effort by spec: degrade to options [], never fail
          // the scan. The failure is still evidence.
          reports = [...reports, { frameId: election.frameId, url: null, fields: null, error: `harvest failed: ${String(e)}` }]
        }
      }
    }
```

5. **PHASE 2 scoping:** compute `const resolveFields = electedOf(kept)` AFTER the harvest merge; `deps.onProgress({ phase: 'resolving', fields: resolveFields.length })`; the resolve request sends `fields: resolveFields`. The auto-fill loop is untouched (its resolutions can only reference elected fields now) and plan 1's `choiceRefs` interim guard stays byte-for-byte.
6. **Every return site** gains `election`: the two PHASE-0 empty/captcha returns and plan 1's kept-empty return use `election: null` (nothing was elected yet or nothing remained); the post-jobText activeCaptcha return, the post-resume captcha/empty returns, the llmError return and the final return use `election: electionOut()`.
7. **`ScanOutcome`** gains `election: ElectionOutcome | null` (insert after `resolutions`); export `ElectionOutcome` next to `ScanOutcome`. Imports: `import { electFrame } from './election'` and `import { pickResumeTarget } from './resumeTarget'`.

- [ ] **Step 1: Adjust the default fixture in `scan.test.ts`, then add failing tests**

FIRST, one surgical edit to `makeDeps`: the default scan reply's file field must actually SCORE under A8 or three pre-existing resume-flow tests would silently lose their subject. Change (line 24):

```ts
      if (message.type === 'JFF_SCAN') return { replies: [scanReply(0, [field(0, 0), field(0, 1, { kind: 'file', label: 'Resume' })])], failures: [] }
```

(Those tests assert the resume ORDER/epoch mechanics, not targeting; giving the field a scoring label preserves their subject unchanged.)

Then append the two describes:

```ts
describe('runScan — A7 frame election', () => {
  const topFields = [field(0, 0, { label: 'Newsletter email', name: 'email' })]
  const appFields = (extra: EnumField[] = []) => [
    field(1, 0, { label: 'First name' }),
    field(1, 1, { label: 'Why us?', required: true }),
    field(1, 2, { label: 'Resume', kind: 'file' }),
    ...extra,
  ]

  function twoFrameDeps(over: {
    app?: EnumField[]
    resume?: boolean
    pasted?: string
    harvestReply?: unknown
  } = {}) {
    const made = makeDeps()
    let epoch = 0
    made.deps.nextEpoch = () => ++epoch
    made.deps.pastedJobText = over.pasted ?? ''
    made.deps.getResume = async () =>
      over.resume === true ? { name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' } : null
    made.deps.inject = vi.fn(async () => [0, 1])
    const app = over.app ?? appFields()
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      made.sent.push(message)
      if (message.type === 'JFF_SCAN') {
        return {
          replies: [
            { frameId: 0, url: 'https://careers.example/', payload: { ok: true, scan: { epoch, fields: topFields, unreachableWidgets: 0, activeCaptcha: false } } },
            { frameId: 1, url: 'https://ats.example/embed', payload: { ok: true, scan: { epoch, fields: app, unreachableWidgets: 0, activeCaptcha: false } } },
          ],
          failures: [],
        }
      }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (message.type === 'JFF_HARVEST') {
        return { replies: [{ frameId: 1, payload: over.harvestReply ?? { ok: true, options: {} } }], failures: [] }
      }
      return { replies: [{ frameId: frameId ?? 0, payload: { ok: true, fill: { epoch, filled: [], failed: [] } } }], failures: [] }
    })
    const resolveCalls: { fields: EnumField[] }[] = []
    made.deps.port = {
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === 'selector.get') return { ok: true, result: { selector: null } }
        if (method === 'resolve') {
          const p = params as { fields: EnumField[] }
          resolveCalls.push(p)
          return {
            ok: true,
            result: {
              epoch,
              resolutions: p.fields.map((f) => ({
                handle: { frameId: f.frameId, fid: f.fid, epoch }, tier: 'auto',
                value: 'V', source: 'profile', key: null, answerId: null, reason: 'test',
              })),
              llmError: null,
            },
          }
        }
        return { ok: true, result: {} }
      }),
      onDisconnect: () => undefined,
      disconnect: () => undefined,
    } as unknown as HostPort
    return { ...made, resolveCalls }
  }

  it('elects the frame with the most signal and scopes resolve to it', async () => {
    const { deps, resolveCalls } = twoFrameDeps()
    const out = await runScan(deps)
    expect(out.election).toEqual({ frameId: 1, score: 11, url: 'https://ats.example/embed' }) // 3 + 3×1 + 5
    expect(resolveCalls[0]!.fields.every((f) => f.frameId === 1)).toBe(true)
    // Foreign fields are KEPT in the outcome; the panel demotes them.
    expect(out.fields.map((f) => `${f.frameId}:${f.fid}`)).toEqual(['0:0', '1:0', '1:1', '1:2'])
  })

  it('never auto-fills the recognizer-resolvable newsletter field in the non-elected frame', async () => {
    const { deps, sent } = twoFrameDeps()
    await runScan(deps)
    const fills = sent.filter((m) => m.type === 'JFF_FILL') as { fills: { handle: { frameId: number } }[] }[]
    expect(fills.length).toBeGreaterThan(0)
    for (const m of fills) expect(m.fills.every((x) => x.handle.frameId === 1)).toBe(true)
  })

  it('election still picks the form frame when the user pasted job text', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({ pasted: 'PASTED JD' })
    const out = await runScan(deps)
    expect(out.election!.frameId).toBe(1)
    expect(out.jobText).toBe('PASTED JD')
    expect(sent.map((m) => m.type)).not.toContain('JFF_JOBTEXT')
    expect(resolveCalls[0]!.fields.every((f) => f.frameId === 1)).toBe(true)
  })

  it('uploads the resume to the A8 scorer pick in the elected frame, by its own fid', async () => {
    const { deps, sent } = twoFrameDeps({ resume: true })
    await runScan(deps)
    const up = sent.find((m) => m.type === 'JFF_FILL_RESUME') as { handle: { frameId: number; fid: number } }
    expect(up.handle).toMatchObject({ frameId: 1, fid: 2 })
  })

  it('does NOT upload when no elected file field scores positive', async () => {
    const app = [field(1, 0, { label: 'First name' }), field(1, 1, { kind: 'file', label: null })]
    const { deps, sent } = twoFrameDeps({ app, resume: true })
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
  })

  it('does NOT upload to a resume-looking file field in a NON-elected frame', async () => {
    // The scoring file input lives in frame 0; frame 1 still wins the election.
    const topWithFile = [field(0, 0, { label: 'Resume', kind: 'file' })]
    const app = [field(1, 0, { required: true }), field(1, 1, { required: true }), field(1, 2)]
    const made = twoFrameDeps({ resume: true, app })
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      made.sent.push(message)
      if (message.type === 'JFF_SCAN') {
        return { replies: [
          { frameId: 0, url: 'https://careers.example/', payload: { ok: true, scan: { epoch: 1, fields: topWithFile, unreachableWidgets: 0, activeCaptcha: false } } },
          { frameId: 1, url: 'https://ats.example/embed', payload: { ok: true, scan: { epoch: 1, fields: app, unreachableWidgets: 0, activeCaptcha: false } } },
        ], failures: [] }
      }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { replies: [{ frameId: frameId ?? 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
    })
    const out = await runScan(made.deps)
    expect(out.election!.frameId).toBe(1) // 1+3 + 1+3 + 1 = 9 beats 1 + 5 = 6
    expect(made.sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
  })
})

describe('runScan — A6 combobox harvest', () => {
  const comboApp = [
    field(1, 0, { label: 'First name' }),
    field(1, 1, { label: 'Country', kind: 'combobox', options: [] }),
    field(1, 2, { label: 'Gender', kind: 'combobox', options: [], demographic: true }),
    field(1, 3, { label: 'Level', kind: 'combobox', options: ['Junior', 'Senior'] }),
    field(1, 4, { label: 'Resume', kind: 'file', required: true }),
  ]

  it('harvests only elected, non-demographic, empty-options comboboxes and merges BEFORE resolve', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({
      app: comboApp,
      harvestReply: { ok: true, options: { 1: ['Brazil', 'Portugal'] } },
    })
    const out = await runScan(deps)
    const harvests = sent.filter((m) => m.type === 'JFF_HARVEST') as { fids: number[] }[]
    expect(harvests).toHaveLength(1)
    expect(harvests[0]!.fids).toEqual([1]) // never the demographic one, never the pre-optioned one
    // merged into the resolve payload (the prompt sees the closed set)…
    const resolvedCombo = resolveCalls[0]!.fields.find((f) => f.fid === 1)!
    expect(resolvedCombo.options).toEqual(['Brazil', 'Portugal'])
    // …and into the returned fields for rendering.
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual(['Brazil', 'Portugal'])
  })

  it('sends the harvest to the ELECTED frame only', async () => {
    const { deps } = twoFrameDeps({ app: comboApp, harvestReply: { ok: true, options: {} } })
    await runScan(deps)
    const call = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => (c[1] as ContentMessage).type === 'JFF_HARVEST')!
    expect(call[0]).toBe(1)
  })

  it('skips the harvest message entirely when nothing qualifies', async () => {
    const { deps, sent } = twoFrameDeps() // default appFields: no comboboxes
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_HARVEST')
  })

  it('a dead harvest relay degrades to empty options and the scan survives with evidence', async () => {
    const made = twoFrameDeps({ app: comboApp })
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_HARVEST') throw new Error('frame vanished mid-harvest')
      return inner(frameId, message)
    })
    const out = await runScan(made.deps)
    expect(out.resolutions.length).toBeGreaterThan(0) // the paid resolve still happened
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual([])
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('harvest failed'))).toBe(true)
  })

  it('a refused harvest reply (stale epoch) merges nothing and fails nothing', async () => {
    const { deps, resolveCalls } = twoFrameDeps({ app: comboApp, harvestReply: { ok: false, error: 'stale_epoch' } })
    const out = await runScan(deps)
    expect(resolveCalls).toHaveLength(1)
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual([])
  })

  it('runs harvest AFTER the resume re-enumeration and before resolve', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({
      app: comboApp, resume: true,
      harvestReply: { ok: true, options: { 1: ['Brazil'] } },
    })
    await runScan(deps)
    const types = sent.map((m) => m.type)
    expect(types.indexOf('JFF_HARVEST')).toBeGreaterThan(types.lastIndexOf('JFF_SCAN'))
    expect(types.indexOf('JFF_HARVEST')).toBeGreaterThan(types.indexOf('JFF_FILL_RESUME'))
    expect(resolveCalls[0]!.fields.find((f) => f.fid === 1)!.options).toEqual(['Brazil'])
  })
})
```

NOTE for the implementer: as written above, `topFields`, `appFields` AND `twoFrameDeps` all live inside the first describe, and the harvest describe uses `twoFrameDeps` — which closes over BOTH `topFields` and `appFields`. Hoist all THREE together to file scope (below `makeDeps`), defined ONCE; hoisting `twoFrameDeps` alone leaves it referencing names the outer scope does not have.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/scan.test.ts`
Expected: the two new describes FAIL (no `election` on the outcome, resolve receives both frames' fields, the newsletter field gets filled, `JFF_FILL_RESUME` targets `fields.find`'s first file, no `JFF_HARVEST` ever sent). Pre-existing tests must still pass (the `makeDeps` label edit keeps their subjects alive).

- [ ] **Step 3: Implement** per the seven design constraints above.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/scan.test.ts && npm run typecheck && npm run lint`
Expected: BOTH new describes green AND every pre-existing scan test green — especially the epoch/evidence tests (`keeps the first-pass evidence when the RETRY itself dies`, `throws a ScanError carrying the enumeration evidence`) and the captcha short-circuits. If a pre-existing test fails, the phase rewrite broke a contract — fix the code, not the test.

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): scan phases — elect, scored resume target, elected-frame harvest merged before resolve"`

---

## Task 7: Host mapping prompt — combobox closed-set note

**Files:**
- Modify: `host/src/llm/mapping.ts` (the `fieldLines` builder plan 1 Task 8 wrote)
- Modify: `host/src/llm/mapping.test.ts`

**Interfaces:**
- Consumes: the plan-1 `fieldLines` shape.
- Produces: combobox field lines carry `(closed set; options may be partial)` so the LLM neither invents options nor treats the harvested list as exhaustive.

- [ ] **Step 1: Add the failing test to `mapping.test.ts`**

Append inside `describe('buildMappingPrompt', ...)`:

```ts
  it('marks combobox fields as a closed set whose option list may be partial', () => {
    const p = buildMappingPrompt({
      fields: [{
        frameId: 0, fid: 4, epoch: 1, label: 'Country', name: null, idAttr: null,
        kind: 'combobox', options: ['Brazil', 'Portugal'], required: true, visible: true,
        currentValue: null, demographic: false,
      }],
      jobText: '', company: null, candidates: [],
    })
    expect(p).toContain('kind=combobox (closed set; options may be partial)')
    // Assert the FULL annotation, not the bare phrase: mapping.ts:70 already
    // contains 'Closed set of known factual keys', so `not.toContain('closed
    // set')` would only pass on the luck of its capital C.
    expect(prompt).not.toContain('kind=combobox (closed set') // the original input has no combobox
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run host/src/llm/mapping.test.ts`
Expected: the new test FAILS.

- [ ] **Step 3: Implement**

In `mapping.ts`'s `fieldLines` builder, add before the `return`:

```ts
    // A6: a combobox is a CLOSED widget whose harvest may have caught only the
    // mounted subset — the model must pick from options when they fit but must
    // not treat an absent option as proof the answer is free-text.
    const kindNote = f.kind === 'combobox' ? ' (closed set; options may be partial)' : ''
```

and change the template's `kind=${f.kind}` to `kind=${f.kind}${kindNote}`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run host/src && npm run typecheck`
Expected: green, clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(host): mark combobox fields closed-set/partial in the mapping prompt"`

---

## Task 8: `group.ts` — `buildRows` with the synthetic foreign resolution

**Files:**
- Modify: `extension/src/panel/group.ts` (add `buildRows` + `FOREIGN_REASON`; `groupRows` STAYS until Task 11 deletes it — every task leaves the build green)
- Modify: `extension/src/panel/group.test.ts`

**Interfaces:**
- Consumes: `EnumField`, `Resolution`, `refOf`.
- Produces: `export const FOREIGN_REASON = 'other-frame'`; `export interface PanelRows { main: Row[]; foreign: Row[] }`; `export function buildRows(fields: EnumField[], resolutions: Resolution[], electedFrameId: number | null): PanelRows`. Foreign rows carry a panel-side SYNTHETIC resolution `{ tier: 'needs_input', source: null, value: null, key: null, answerId: null, reason: 'other-frame' }` — except a foreign DEMOGRAPHIC field, which gets `{ tier: 'skipped', reason: 'eeo' }` so it keeps the read-only skipped affordance. Both are minted HERE, never sent to the host, never stored in App state (so `buildSaveItems`, which reads the REAL resolutions array, keeps skipping foreign fields with zero changes).

- [ ] **Step 1: Add failing tests to `group.test.ts`**

Extend the import with `buildRows, FOREIGN_REASON` and the `field` helper with a frameId parameter — replace the existing helper with:

```ts
const field = (fid: number, label: string, frameId = 0): EnumField => ({
  frameId, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false,
})
```

(The existing `groupRows` describe compiles unchanged — the new parameter defaults to 0.) Append:

```ts
describe('buildRows', () => {
  const fields = [
    field(0, 'Newsletter email', 0),
    field(0, 'First name', 1),
    field(1, 'Why us?', 1),
    field(2, 'Gender', 1),
  ]
  const resolutions = [
    resolution(0, { handle: { frameId: 1, fid: 0, epoch: 1 }, tier: 'auto', value: 'Ada', source: 'profile' }),
    resolution(1, { handle: { frameId: 1, fid: 1, epoch: 1 }, tier: 'needs_input' }),
    resolution(2, { handle: { frameId: 1, fid: 2, epoch: 1 }, tier: 'skipped', reason: 'eeo' }),
  ]

  it('splits elected rows from foreign rows and keeps document order (NO tier bucketing)', () => {
    const { main, foreign } = buildRows(fields, resolutions, 1)
    expect(main.map((r) => r.field.label)).toEqual(['First name', 'Why us?', 'Gender'])
    expect(main.map((r) => r.resolution.tier)).toEqual(['auto', 'needs_input', 'skipped'])
    expect(foreign.map((r) => r.field.label)).toEqual(['Newsletter email'])
  })

  it('mints the exact synthetic other-frame resolution for foreign fields', () => {
    const { foreign } = buildRows(fields, resolutions, 1)
    expect(foreign[0]!.resolution).toEqual({
      handle: { frameId: 0, fid: 0, epoch: 1 },
      tier: 'needs_input', value: null, source: null, key: null, answerId: null,
      reason: FOREIGN_REASON,
    })
  })

  it('keeps the skipped affordance for a FOREIGN demographic field', () => {
    const demo = { ...field(7, 'Gender', 0), demographic: true }
    const { foreign } = buildRows([demo], resolutions, 1)
    expect(foreign[0]!.resolution).toMatchObject({ tier: 'skipped', reason: 'eeo' })
  })

  it('treats every field as main when no election happened', () => {
    const { main, foreign } = buildRows(fields, resolutions, null)
    expect(foreign).toEqual([])
    // the newsletter field has no resolution -> still dropped, never guessed
    expect(main.map((r) => r.field.label)).toEqual(['First name', 'Why us?', 'Gender'])
  })

  it('still drops an elected-frame field with no resolution rather than guessing', () => {
    const { main } = buildRows([...fields, field(9, 'Orphan', 1)], resolutions, 1)
    expect(main.map((r) => r.field.label)).not.toContain('Orphan')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/group.test.ts`
Expected: FAIL — `buildRows` missing.

- [ ] **Step 3: Implement in `group.ts`** (append; `groupRows` untouched)

```ts
/** The synthetic reason foreign rows carry. FieldRow maps it to a hint; save.ts
 *  never sees it (the synthetic resolution lives only inside PanelRows). */
export const FOREIGN_REASON = 'other-frame'

export interface PanelRows {
  /** Elected-frame rows in document order (fid order IS document order within a
   *  frame) — tier becomes a badge, not a bucket (A9). */
  main: Row[]
  /** Non-elected-frame rows: synthetic needs_input resolution, manual Fill only. */
  foreign: Row[]
}

/**
 * A9: foreignness is DERIVED here from `field.frameId !== electedFrameId` — it
 * is never an EnumField property (zod would strip it) and never a host concern.
 * Foreign fields were excluded from resolve, so they have no real resolution;
 * the synthetic one is minted so they render. Elected-frame fields with no
 * resolution are still dropped, never guessed.
 */
export function buildRows(fields: EnumField[], resolutions: Resolution[], electedFrameId: number | null): PanelRows {
  const byRef = new Map(resolutions.map((r) => [refOf(r.handle), r]))
  const main: Row[] = []
  const foreign: Row[] = []
  for (const field of fields) {
    const ref = refOf(field)
    if (electedFrameId !== null && field.frameId !== electedFrameId) {
      foreign.push({
        ref, field,
        resolution: {
          handle: { frameId: field.frameId, fid: field.fid, epoch: field.epoch },
          // A demographic field keeps the SKIPPED affordance even outside the
          // elected frame: FieldRow's skipped early-return renders it read-only,
          // which is the visible half of demographic skipping. Foreign fields
          // never reach the host, so nothing else would mark them.
          tier: field.demographic ? 'skipped' as const : 'needs_input' as const,
          value: null, source: null, key: null, answerId: null,
          reason: field.demographic ? 'eeo' : FOREIGN_REASON,
        },
      })
      continue
    }
    const resolution = byRef.get(ref)
    if (resolution === undefined) continue
    main.push({ ref, field, resolution })
  }
  return { main, foreign }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/group.test.ts && npm run typecheck`
Expected: green (old `groupRows` describe included), clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): buildRows — document-order rows plus synthetic other-frame resolutions"`

---

## Task 9: Status line — `filled` vs `already on page` state shape

**Files:**
- Modify: `extension/src/panel/ScanStatus.tsx` (`ScanUiState` done variant + copy)
- Modify: `extension/src/panel/ScanStatus.test.tsx` (done rows)
- Modify: `extension/src/panel/App.tsx` (the count computation ~lines 300–317)
- Modify: `extension/src/panel/App.test.tsx` (one copy assertion)

**Interfaces:**
- Consumes: existing resolutions state.
- Produces: `{ kind: 'done'; filled: number; alreadyOnPage: number; proposed: number; needsInput: number }` — the state shape B3 keeps. `alreadyOnPage` (= `tier auto && source === 'page'`) is exact NOW; `filled` is the interim attempted count, marked for B3.

- [ ] **Step 1: Update the tests (failing)**

`ScanStatus.test.tsx` — in the `it.each` table replace the `done` row with:

```ts
    [{ kind: 'done', filled: 8, alreadyOnPage: 2, proposed: 2, needsInput: 3 }, '✓ 8 filled, 2 already on page, 2 proposed, 3 need input'],
```

and in the two `shows diagnostics on done…` tests replace each `{ kind: 'done', filled: 1, proposed: 0, needsInput: 0 }` with `{ kind: 'done', filled: 1, alreadyOnPage: 0, proposed: 0, needsInput: 0 }`.

`App.test.tsx` (~line 128) — replace:

```ts
    expect(screen.getByText('✓ 0 filled, 0 already on page, 0 proposed, 0 need input')).toBeTruthy()
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/ScanStatus.test.tsx extension/src/panel/App.test.tsx`
Expected: FAIL — type error on `alreadyOnPage` / copy mismatch.

- [ ] **Step 3: Implement**

`ScanStatus.tsx` — the done variant becomes:

```ts
  | { kind: 'done'; filled: number; alreadyOnPage: number; proposed: number; needsInput: number }
```

and its copy line:

```ts
    case 'done': return `✓ ${s.filled} filled, ${s.alreadyOnPage} already on page, ${s.proposed} proposed, ${s.needsInput} need input`
```

`App.tsx` — replace the count block (currently the `DELIBERATE:` comment + three consts) with:

```ts
      // A9 status semantics: `filled` and `already on page` are SEPARATE facts.
      // `alreadyOnPage` (page-sourced values the engine never wrote) is exact.
      // INTERIM — B3 (plan 3) replaces the `filled` COUNT SOURCE: it still
      // counts attempted scan-time auto-fills here because the batched JFF_FILL
      // reports are only collected and consumed in slice 3; B3 swaps in the
      // page-accepted number from those reports without touching this shape.
      const filled = out.resolutions.filter((r) => r.tier === 'auto' && r.source !== 'page').length
      const alreadyOnPage = out.resolutions.filter((r) => r.tier === 'auto' && r.source === 'page').length
      const proposed = out.resolutions.filter((r) => r.tier === 'proposed').length
      const needsInput = out.resolutions.filter((r) => r.tier === 'needs_input').length
```

and the `setOutcome` done branch becomes `{ kind: 'done', filled, alreadyOnPage, proposed, needsInput }`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/ScanStatus.test.tsx extension/src/panel/App.test.tsx && npm run typecheck`
Expected: green, clean.

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): status line separates filled from already-on-page (B3 swaps the filled source)"`

---

## Task 10: `FieldRow` — kind-aware editors, tier badge, description, hints, file/foreign rows

**Files:**
- Modify: `extension/src/panel/FieldRow.tsx` (full rewrite below)
- Modify: `extension/src/panel/FieldRow.test.tsx` (new describes; existing tests adapted only where noted)

**Interfaces:**
- Consumes: `Row`, `scoreResumeField` (Task 5), `EnumField.description`/`'choice'` (plan 1).
- Produces: new OPTIONAL props (`foreign`, `resumeTarget`, `resumeName`, `onFillResume`) so `App.tsx` compiles unchanged until Task 11; `export const REASON_HINT: Record<string, string>` with the `'choice-needs-user-click'` and `'other-frame'` entries (B1 seam); `export const TIER_BADGE`; every `<li>` carries `data-jff-tier={tier}` (the selector Tasks 11/12 migrate tests onto).

Editor selection (spec A9, exact):
- `choice`/`radiogroup` with 1–5 options → segmented buttons (`aria-pressed`, click = `onEdit(ref, option)`).
- Any field with more than 5 options, and `select`/`combobox` with ANY options (harvested included) → input + `<datalist>` picker (native typeahead; Plan decision 6).
- `combobox` with zero options → single-line text input annotated "dropdown — options load on fill".
- `file` + `resumeTarget` → stored resume name + a "Put on page" button calling `onFillResume(ref)`; no textarea, no Generate/Fill.
- `file` otherwise → manual-only note carrying its resume score; no editor, no actions.
- everything else → the existing textarea.
- Foreign rows: frame badge, NO Generate, Fill stays; skipped rows unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `FieldRow.test.tsx` (reuse the file's `field`/`resolution`/`row`/`props`/`needsInput` helpers):

```tsx
describe('FieldRow — kind-aware editors (A9)', () => {
  it('renders ≤5-option choice as segmented buttons and emits the pick as an edit', () => {
    const onEdit = vi.fn()
    const r = row(field({ kind: 'choice', options: ['Sim', 'Não'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} onEdit={onEdit} /></ul>)
    const seg = document.querySelector('[data-jff-editor="segmented"]')!
    const buttons = Array.from(seg.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Sim', 'Não'])
    fireEvent.click(seg.querySelectorAll('button')[1]!)
    expect(onEdit).toHaveBeenCalledWith('0:1', 'Não')
  })

  it('marks the picked segment pressed', () => {
    const r = row(field({ kind: 'radiogroup', options: ['Yes', 'No'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} edited="No" /></ul>)
    const pressed = Array.from(document.querySelectorAll('[data-jff-editor="segmented"] button'))
      .map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['false', 'true'])
  })

  it('renders a >5-option set as a typeahead picker backed by a datalist', () => {
    const opts = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const r = row(field({ kind: 'select', options: opts }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    const input = document.querySelector<HTMLInputElement>('[data-jff-editor="picker"]')!
    expect(input.getAttribute('list')).toBe('opts-0:1')
    expect(document.querySelectorAll('datalist option')).toHaveLength(7)
  })

  it('renders harvested combobox options as a picker too', () => {
    const r = row(field({ kind: 'combobox', options: ['Brazil', 'Portugal'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-editor="picker"]')).not.toBeNull()
  })

  it('annotates an empty-options combobox as a dropdown whose options load on fill', () => {
    const r = row(field({ kind: 'combobox', options: [] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-editor="combobox-empty"]')).not.toBeNull()
    expect(screen.getByText(/dropdown — options load on fill/)).toBeTruthy()
  })

  it('wires the resume-target file row to Put on page and never shows a textarea', () => {
    const onFillResume = vi.fn()
    const r = row(field({ kind: 'file', label: 'Resume', required: true }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} resumeTarget resumeName="cv.pdf" onFillResume={onFillResume} /></ul>)
    expect(screen.getByText(/cv\.pdf/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put on page' }))
    expect(onFillResume).toHaveBeenCalledWith('0:1')
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
  })

  it('renders any other file row manual-only with its score reason', () => {
    const r = row(field({ kind: 'file', label: null }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText(/resume score 0/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Put on page' })).toBeNull()
  })

  it('shows the description as a subtitle under the label', () => {
    const r = row(field({ description: 'Answer for your current country.' }), resolution())
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-description]')!.textContent).toBe('Answer for your current country.')
  })

  it('shows the tier as a badge and stamps data-jff-tier on the row', () => {
    render(<ul><FieldRow row={needsInput()} {...props} /></ul>)
    const li = document.querySelector('li')!
    expect(li.getAttribute('data-jff-tier')).toBe('needs_input')
    expect(li.querySelector('[data-jff-tier-badge]')!.textContent).toBe('needs input')
  })
})

describe('FieldRow — foreign rows and hints (A9/B1 seam)', () => {
  const foreignRow = () => row(
    field({ frameId: 3, label: 'Newsletter email' }),
    resolution({ handle: { frameId: 3, fid: 1, epoch: 1 }, tier: 'needs_input', value: null, source: null, key: null, reason: 'other-frame' }),
  )

  it('foreign: frame badge, manual Fill only, no Generate', () => {
    render(<ul><FieldRow row={foreignRow()} {...props} edited="x" foreign /></ul>)
    expect(screen.getByText('frame 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fill' })).toBeTruthy()
  })

  it('renders the human hint for a hinted reason', () => {
    const r = row(field(), resolution({ tier: 'needs_input', value: null, source: null, reason: 'choice-needs-user-click' }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText('Select this answer on the page yourself.')).toBeTruthy()
  })
})
```

ALSO adapt one existing test: `'lists the available options for a select so the user can see what is valid'` asserted the comma-joined option paragraph under a textarea — a ≤5-option select now renders those SAME options inside the picker datalist. Change its assertions to `document.querySelectorAll('datalist option')` texts. No other existing test changes (text rows keep the textarea; skipped/acting/accept tests are untouched).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/FieldRow.test.tsx`
Expected: new describes FAIL (no editors, no badges, no hints).

- [ ] **Step 3: Implement — replace `extension/src/panel/FieldRow.tsx`**

```tsx
import type { ResolutionTier } from '@jff/shared'
import { SOURCE_BADGE, type Row } from './group'
import { scoreResumeField } from './resumeTarget'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE, TIER_ACCENT, busyLabel } from './ui'

export const TIER_BADGE: Record<ResolutionTier, string> = {
  auto: 'filled', proposed: 'proposed', needs_input: 'needs input', skipped: 'skipped',
}

/**
 * First-class refusal reasons rendered as a human hint under the row. The
 * 'choice-needs-user-click' copy ships NOW (B1 seam): plan 3's fillChoice only
 * has to RETURN the reason for the hint to render.
 */
export const REASON_HINT: Record<string, string> = {
  'choice-needs-user-click': 'Select this answer on the page yourself.',
  'other-frame': 'Outside the application frame. Fill puts your value there; nothing is generated or saved for it.',
}

const SEGMENTED_MAX_OPTIONS = 5

export interface FieldRowProps {
  row: Row
  edited: string | null
  onEdit: (ref: string, value: string) => void
  onAccept: (ref: string) => void
  onGenerate: (ref: string) => void
  /** Puts the row's current value on the page WITHOUT accepting it as a mapping. */
  onFill: (ref: string) => void
  generating: boolean
  filled: boolean
  /** Which of this row's page-writing actions is in flight, if any. */
  acting: 'accept' | 'fill' | null
  /** SOME row is acting. Page writes are serialized globally, so every row's
   *  buttons must look disabled — an enabled button that silently no-ops is the
   *  failure mode this rule removes. */
  locked: boolean
  /** A9: the row belongs to a non-elected frame — manual Fill only. */
  foreign?: boolean
  /** A8: this file row won the resume scoring and is wired to the stored resume. */
  resumeTarget?: boolean
  resumeName?: string | null
  onFillResume?: (ref: string) => void
}

type EditorKind = 'segmented' | 'picker' | 'combobox-empty' | 'file' | 'textarea'

function editorKindOf(row: Row): EditorKind {
  const { field } = row
  if (field.kind === 'file') return 'file'
  if ((field.kind === 'choice' || field.kind === 'radiogroup')
    && field.options.length > 0 && field.options.length <= SEGMENTED_MAX_OPTIONS) return 'segmented'
  if (field.options.length > 0) return 'picker' // >5-option sets, selects, harvested comboboxes
  if (field.kind === 'combobox') return 'combobox-empty'
  return 'textarea'
}

export function FieldRow(p: FieldRowProps) {
  const { row, edited, onEdit, onAccept, onGenerate, onFill, generating, filled, acting, locked } = p
  const { field, resolution, ref } = row
  const label = field.label ?? '(unlabelled field)'
  const value = edited ?? resolution.value ?? ''
  const rowClass = `${ROW_BASE} ${TIER_ACCENT[resolution.tier]}`
  const hint = REASON_HINT[resolution.reason]

  if (resolution.tier === 'skipped') {
    return (
      <li className={rowClass} data-jff-tier="skipped">
        <div className="flex items-baseline gap-1.5"><span className="font-semibold">{label}</span></div>
        <p className={`mt-1 text-[12px] ${MUTED}`}>Demographic question. Never auto-filled.</p>
      </li>
    )
  }

  const editor = editorKindOf(row)

  return (
    <li className={rowClass} data-jff-tier={resolution.tier}>
      <div className="flex items-baseline gap-1.5">
        <label className="font-semibold" htmlFor={`f-${ref}`}>{label}</label>
        {field.required && <span className="text-red-600 dark:text-red-400" title="required">*</span>}
        <span
          data-jff-tier-badge="1"
          className={`rounded-full border border-neutral-200 px-1.5 text-[11px] dark:border-neutral-700 ${MUTED}`}
        >
          {TIER_BADGE[resolution.tier]}
        </span>
        {p.foreign === true && (
          <span data-jff-frame-badge="1" className={`rounded-full border border-amber-300 px-1.5 text-[11px] dark:border-amber-600 ${MUTED}`}>
            frame {field.frameId}
          </span>
        )}
        {resolution.source !== null && (
          <span className={`ml-auto rounded-full border border-neutral-200 px-1.5 text-[11px] dark:border-neutral-700 ${MUTED}`}>
            {SOURCE_BADGE[resolution.source]}
          </span>
        )}
      </div>

      {field.description !== undefined && field.description !== '' && (
        <p data-jff-description="1" className={`mt-0.5 text-[12px] ${MUTED}`}>{field.description}</p>
      )}

      {editor === 'segmented' && (
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" data-jff-editor="segmented">
          {field.options.map((opt) => (
            <button
              key={opt} type="button" aria-pressed={value === opt}
              className={`${BTN} ${value === opt ? 'border-blue-600 font-semibold text-blue-700 dark:border-blue-400 dark:text-blue-300' : ''}`}
              onClick={() => onEdit(ref, opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {editor === 'picker' && (
        <>
          <input
            id={`f-${ref}`} data-jff-editor="picker" list={`opts-${ref}`}
            className={`${INPUT} mt-1.5`} value={value}
            onChange={(e) => onEdit(ref, e.target.value)}
          />
          <datalist id={`opts-${ref}`}>
            {field.options.map((o) => <option key={o} value={o} />)}
          </datalist>
        </>
      )}

      {editor === 'combobox-empty' && (
        <>
          <input
            id={`f-${ref}`} data-jff-editor="combobox-empty"
            className={`${INPUT} mt-1.5`} value={value}
            onChange={(e) => onEdit(ref, e.target.value)}
          />
          <p className={`mt-1 text-[12px] ${MUTED}`}>dropdown — options load on fill</p>
        </>
      )}

      {editor === 'file' && (p.resumeTarget === true
        ? (
            <div className="mt-1.5 flex items-center gap-2" data-jff-editor="resume">
              <span className={MUTED}>{p.resumeName ?? '(no resume stored)'}</span>
              <button
                type="button" className={BTN_PRIMARY}
                disabled={p.resumeName == null || locked || acting !== null}
                onClick={() => p.onFillResume?.(ref)}
              >
                {busyLabel(acting === 'fill', 'Put on page', 'Uploading…')}
              </button>
              {filled && <span className={`text-[11px] ${MUTED}`}>on the page</span>}
            </div>
          )
        : (
            // Two identical resume buttons would reintroduce the autofill-pane
            // trap: every non-winning file row is manual-only, with its score.
            <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-editor="file">
              File field — resume score {scoreResumeField(field)}. Set it on the page yourself.
            </p>
          ))}

      {editor === 'textarea' && (
        <textarea
          id={`f-${ref}`}
          className={`${INPUT} mt-1.5 resize-y`}
          rows={value.length > 90 ? 4 : 1}
          value={value}
          onChange={(e) => onEdit(ref, e.target.value)}
        />
      )}

      {hint !== undefined && <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-hint="1">{hint}</p>}

      {editor !== 'file' && (
        <div className="mt-1.5 flex items-center gap-2">
          {resolution.tier === 'proposed' && (
            <button type="button" className={BTN_PRIMARY} disabled={locked || acting !== null} onClick={() => onAccept(ref)}>
              {busyLabel(acting === 'accept', 'Accept', 'Accepting…')}
            </button>
          )}
          {resolution.tier === 'needs_input' && (
            <>
              {p.foreign !== true && (
                <button type="button" className={BTN} disabled={generating || locked || acting !== null} onClick={() => onGenerate(ref)}>
                  {generating ? 'Drafting…' : 'Generate with AI'}
                </button>
              )}
              <button type="button" className={BTN_PRIMARY} disabled={value.trim() === '' || locked || acting !== null} onClick={() => onFill(ref)}>
                {busyLabel(acting === 'fill', 'Fill', 'Filling…')}
              </button>
              {filled && <span className={`text-[11px] ${MUTED}`}>on the page</span>}
            </>
          )}
          <span className={`ml-auto font-mono text-[11px] ${MUTED}`} title={resolution.reason}>{resolution.reason}</span>
        </div>
      )}
    </li>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/FieldRow.test.tsx && npm run typecheck && npm run lint`
Expected: new describes green; every existing FieldRow test green except the deliberately-adapted select-options one; App.test.tsx still compiles (all new props optional).

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): kind-aware field editors, tier/frame badges, descriptions, refusal hints"`

---

## Task 11: `App.tsx` — document-order rows, "Other page fields", resume row wiring, resume note

**Files:**
- Modify: `extension/src/panel/App.tsx` (render core + action lookups + election state)
- Modify: `extension/src/panel/group.ts` (DELETE `groupRows` — Task 8 kept it alive for exactly this handover)
- Modify: `extension/src/panel/group.test.ts` (delete the `groupRows` describe)
- Modify: `extension/src/panel/App.test.tsx` (selector migration + new tests)

**Interfaces:**
- Consumes: `buildRows` (Task 8), `ElectionOutcome` via `ScanOutcome.election` (Task 6), `pickResumeTarget` (Task 5), FieldRow's new props (Task 10), `loadResume`.
- Produces: the A9 render contract — `[data-jff-rows]` (elected rows, document order) + `[data-jff-foreign]` (collapsed `<details>` naming the elected frame host+score) replace the four `data-jff-group` sections; `onFillResume` sends `JFF_FILL_RESUME` targeting the ROW's own fid through the existing base64 plumbing; the "resume field not identified" note. Save behavior unchanged (foreign resolutions never enter App state).

Design constraints for the integrator:

1. **State:** add `const [election, setElection] = useState<ElectionOutcome | null>(null)` (import the type from `./scan`). `resetScanState` clears it (`setElection(null)`); the post-scan generation-guarded block sets it (`setElection(out.election)`), alongside the existing `setFields`/`setResolutions`.
2. **Rows:** replace `const groups = groupRows(fields, resolutions)` with:

```ts
  const { main, foreign } = buildRows(fields, resolutions, election?.frameId ?? null)
  // A8/A9: the SAME pure scorer scan.ts used decides which file row is wired to
  // the stored resume — recomputed over the CURRENT fields so a post-resume
  // re-enumeration can never leave the button on a stale fid.
  const resumeTargetField = pickResumeTarget(main.map((r) => r.field))
  const resumeTargetRef = resumeTargetField === null ? null : refOf(resumeTargetField)
```

3. **Action lookups** — the tier check IS the collection today, so a bare ref-find would silently delete three guards. Use these three lines verbatim:

```ts
    const row = main.find((r) => r.ref === ref && r.resolution.tier === 'proposed')      // onAccept
    const row = main.find((r) => r.ref === ref && r.resolution.tier === 'needs_input')   // onGenerate (foreign rows never generate)
    const row = [...main, ...foreign].find((r) => r.ref === ref && r.resolution.tier === 'needs_input') // onFill
```

The manual Fill path spanning `[...main, ...foreign]` is exactly what foreign rows keep. No other body changes: the generation guards, `fillOne`, and `clearActionFailure` stay byte-for-byte.
4. **`onFillResume`** (new, next to `onFill`) — same generation/acting discipline as the other page-writing actions:

```ts
  /** A9: put the stored resume on the A8-winning file row, targeting ITS fid
   *  through the existing base64 JFF_FILL_RESUME plumbing. */
  const onFillResume = async (ref: string): Promise<void> => {
    const row = main.find((r) => r.ref === ref)
    if (row === undefined || tabId === null || acting !== null) return
    const resume = await loadResume()
    if (resume === null) return
    const gen = resetGenRef.current
    setActing({ ref, action: 'fill' })
    try {
      const { replies } = await sendToTab(row.field.frameId, {
        type: 'JFF_FILL_RESUME', epoch: row.field.epoch,
        handle: { frameId: row.field.frameId, fid: row.field.fid, epoch: row.field.epoch },
        fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
      })
      if (resetGenRef.current !== gen) return
      const p = replies[0]?.payload as { ok?: boolean; error?: string } | undefined
      if (p?.ok !== true) throw new Error(p?.error ?? 'the page rejected the file')
      setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
      clearActionFailure()
    } catch (e) {
      if (resetGenRef.current !== gen) return
      setScanStatus({ kind: 'action_failed', reason: `Resume fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }
```

5. **Render:** replace the whole `(['needs_input', 'proposed', 'auto', 'skipped'] as const).map(...)` block with:

```tsx
        : (
            <>
              {main.length > 0 && (
                <section className="mt-4" data-jff-rows="1">
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {main.map((row) => (
                      <FieldRow
                        key={row.ref} row={row} edited={edits[row.ref] ?? null}
                        onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                        generating={generatingRef === row.ref}
                        filled={filledRefs.includes(row.ref)}
                        acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                        locked={acting !== null}
                        resumeTarget={row.ref === resumeTargetRef}
                        resumeName={resumeName}
                        onFillResume={onFillResume}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {foreign.length > 0 && (
                // Collapsed at the bottom, NAMING the elected frame so a
                // mis-election is visible and explainable (the override UI is
                // spec-deferred; this header is the mitigation).
                <details className="mt-4" data-jff-foreign="1">
                  <summary className={`cursor-pointer text-[11px] font-semibold uppercase tracking-widest ${MUTED}`}>
                    Other page fields ({foreign.length}) — application frame: {electedFrameName(election)}
                  </summary>
                  <ul className="m-0 mt-2 grid list-none gap-2 p-0">
                    {foreign.map((row) => (
                      <FieldRow
                        key={row.ref} row={row} edited={edits[row.ref] ?? null}
                        onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                        generating={false}
                        filled={filledRefs.includes(row.ref)}
                        acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                        locked={acting !== null}
                        foreign
                      />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
```

with a module-level helper (exported for tests):

```ts
/** "host:port (score N)" — the port matters: two fixture origins share a host. */
export const electedFrameName = (e: ElectionOutcome | null): string => {
  if (e === null) return '(none)'
  let host = `frame ${e.frameId}`
  if (e.url !== null) { try { host = new URL(e.url).host } catch { /* keep frame id */ } }
  return `${host} (score ${e.score})`
}
```

6. **Resume note** — inside the existing `data-jff-resume` label, immediately after the resume-name inline expression (App.tsx:583 renders `Resume {resumeName === null ? '(none stored)' : \`(${resumeName})\`}` — an inline expression, NOT a `<span>`; do not go looking for a span to append to):

```tsx
        {resumeName !== null && main.some((r) => r.field.kind === 'file') && resumeTargetRef === null && (
          <span className="text-amber-600 dark:text-amber-400" data-jff-resume-note="1"> — resume field not identified; nothing was uploaded</span>
        )}
```

7. **Delete `groupRows`** from `group.ts` and its describe from `group.test.ts` (`buildRows` owns the contract now). Remove the now-unused import from `App.tsx`.

- [ ] **Step 1: Migrate + add tests in `App.test.tsx` (failing)**

Selector migration (mechanical, three sites): replace every `[data-jff-group="X"]` with `li[data-jff-tier="X"]` (lines ~722–723 and ~895–896) and the bare `[data-jff-group]` (line ~390) with `[data-jff-rows]`. Then append:

```tsx
describe('App — election rendering (A7/A9)', () => {
  const twoFrameScanReply = {
    ok: true,
    replies: [
      { frameId: 0, url: 'https://careers.acme.com/', payload: { ok: true, scan: { epoch: 1, fields: [
        { frameId: -1, fid: 0, epoch: 1, label: 'Newsletter email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false },
      ], unreachableWidgets: 0, activeCaptcha: false } } },
      { frameId: 1, url: 'https://ats.acme.com/embed', payload: { ok: true, scan: { epoch: 1, fields: [
        { frameId: -1, fid: 0, epoch: 1, label: 'First name', name: 'first', idAttr: null, kind: 'text', options: [], required: true, visible: true, currentValue: null, demographic: false },
        { frameId: -1, fid: 1, epoch: 1, label: 'Why us?', name: 'why', idAttr: null, kind: 'textarea', options: [], required: false, visible: true, currentValue: null, demographic: false },
      ], unreachableWidgets: 0, activeCaptcha: false } } },
    ],
    failures: [],
  }

  function installTwoFrameScan(): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0, 1] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return twoFrameScanReply
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 1, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
      return { ok: true }
    })
    // Resolutions come back for the ELECTED frame's fields only, like the real host.
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'needs_input' as const,
          value: null, source: null, key: null, answerId: null, reason: 'custom',
        })), llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('renders elected rows in document order and demotes the newsletter field', async () => {
    installTwoFrameScan()
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('[data-jff-rows] li')).toHaveLength(2))
    const labels = Array.from(document.querySelectorAll('[data-jff-rows] li label.font-semibold')).map((n) => n.textContent)
    expect(labels).toEqual(['First name', 'Why us?'])
    const foreignEl = document.querySelector('[data-jff-foreign]')!
    expect(foreignEl.textContent).toContain('Other page fields (1)')
    expect(foreignEl.textContent).toContain('ats.acme.com') // the ELECTED frame is named
    expect(foreignEl.textContent).toContain('Newsletter email')
  })

  it('offers no Generate on a foreign row but keeps manual Fill', async () => {
    installTwoFrameScan()
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-foreign]')).not.toBeNull())
    const rowEl = document.querySelector('[data-jff-foreign] li')!
    const names = Array.from(rowEl.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(names.some((n) => n.includes('Generate'))).toBe(false)
    expect(names.some((n) => n.includes('Fill'))).toBe(true)
  })
})

describe('App — resume row wiring (A8/A9)', () => {
  it('puts the stored resume on the page from the winning file row, targeting its own fid', async () => {
    const { saveResume } = await import('./resume')
    await saveResume(new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' }))
    const sentMessages: { type?: string; handle?: { fid: number } }[] = []
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string; handle?: { fid: number } } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message !== undefined) sentMessages.push(msg.message)
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return { ok: true, replies: [{ frameId: 0, url: 'https://ats.example/', payload: { ok: true, scan: { epoch: 1, fields: [
          { frameId: -1, fid: 0, epoch: 1, label: null, name: null, idAttr: null, kind: 'file', options: [], required: false, visible: true, currentValue: null, demographic: false },
          { frameId: -1, fid: 1, epoch: 1, label: 'Resume', name: 'resume', idAttr: null, kind: 'file', options: [], required: true, visible: true, currentValue: null, demographic: false, accept: '.pdf' },
        ], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'needs_input' as const,
          value: null, source: null, key: null, answerId: null, reason: 'custom',
        })), llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    const putButton = await screen.findByRole('button', { name: 'Put on page' })
    // The scan already uploaded once (auto path); the ROW re-upload is the user's.
    fireEvent.click(putButton)
    await waitFor(() => {
      const uploads = sentMessages.filter((m) => m.type === 'JFF_FILL_RESUME')
      expect(uploads.length).toBeGreaterThanOrEqual(1)
      // every upload targeted the WINNING fid, never the fid-0 autofill pane
      expect(uploads.every((u) => u.handle!.fid === 1)).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/App.test.tsx`
Expected: new describes FAIL (no `[data-jff-rows]`, no foreign group, no Put on page).

- [ ] **Step 3: Implement** per the seven constraints; then delete `groupRows` + its describe.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel && npm run typecheck && npm run lint`
Expected: ALL panel suites green — including the migrated navigation/action tests (the generation-guard tests at ~lines 660–950 prove the rewrite kept the discipline) and save.test.ts untouched-and-green (foreign fields never reach `buildSaveItems`' resolutions).

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): document-order rows, Other-page-fields demotion, resume row wiring, resume note"`

---

## Task 12: e2e — second origin, election fixture pair, election spec, selector migration

**Files:**
- Modify: `e2e/static-server.ts` (root parameter)
- Create: `e2e/fixtures/ashby-host/newsletter-page.html`
- Create: `e2e/fixtures/ashby-embed/apply-frame.html`
- Create: `e2e/election.spec.ts`
- Modify: `e2e/full-loop.spec.ts` (three selector lines: 90, 103–104, 200)

**Interfaces:**
- Consumes: the seam build (`?jffFakeHost=1` + `__jffHostBridge`), per-frame webNavigation injection (commit 295ff05), Task 11's `[data-jff-rows]`/`[data-jff-foreign]`/`data-jff-tier` contract.
- Produces: a TWO-ORIGIN harness (`startFixtureServer(root)` twice = two ports = cross-origin iframe) that plan 3's choice-fill e2e reuses; the election spec proving A6/A7/A8-adjacent behavior in a real browser with real CSS (this is where `defaultMeasure`/`isClipped` finally run un-mocked).

- [ ] **Step 1: Parameterize the static server**

In `e2e/static-server.ts` replace the fixed `ROOT` with a parameter (callers without arguments are unchanged):

```ts
const here = dirname(fileURLToPath(import.meta.url))

export async function startFixtureServer(root = 'fixtures/greenhouse-apply'): Promise<{ origin: string; stop: () => Promise<void>; server: Server }> {
  const ROOT = resolve(here, root)
```

(body unchanged; `ROOT` moves inside the function.)

- [ ] **Step 2: Write the fixture pair**

`e2e/fixtures/ashby-host/newsletter-page.html` — the TOP frame: one recognizer-resolvable input plus the application iframe whose src arrives by query (two servers bind random ports, so it cannot be hard-coded):

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme Careers</title></head>
<body>
  <h1>Careers at Acme</h1>
  <p>Get job alerts in your inbox.</p>
  <label for="nl-email">Email</label>
  <input id="nl-email" name="email" type="email" placeholder="you@example.com">
  <button type="button">Subscribe</button>
  <iframe id="app-frame" title="Application" width="100%" height="900"></iframe>
  <script>
    const src = new URLSearchParams(location.search).get('frame')
    if (src) document.getElementById('app-frame').src = src
  </script>
</body>
</html>
```

`e2e/fixtures/ashby-embed/apply-frame.html` — the application frame, distilled Ashby patterns with REAL CSS (dangling labels, required class token, hidden-checkbox choice, click-mounted combobox listbox, two file inputs):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><title>Apply</title>
<style>
  body { font-family: sans-serif; margin: 16px; }
  ._label_1e3gg_42 { display: block; font-weight: 600; margin-top: 14px; }
  ._required_f7cvd_91::after { content: ' *'; color: #c00; }
  /* Ashby hides the real toggle behind styled buttons */
  ._input_1svni_78 { display: none; }
  /* the autofill-pane trap: visually hidden by clipping, not display:none */
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  [role="listbox"] { border: 1px solid #999; margin: 0; padding: 2px; list-style: none; }
  [role="option"] { padding: 2px 6px; cursor: pointer; }
</style>
</head>
<body>
  <!-- dangling label + name==for: the label's `for` matches no id, the input's NAME matches it -->
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42 _required_f7cvd_91" for="first-uuid">First name</label>
    <input name="first-uuid" type="text">
  </div>
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42 _required_f7cvd_91" for="last-uuid">Last name</label>
    <input name="last-uuid" type="text">
  </div>

  <!-- yes/no choice: two untyped buttons + a display:none checkbox -->
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42 _required_f7cvd_91" for="yn-uuid">Are you legally authorized to work in your current country of employment?</label>
    <div class="_container_1svni_28">
      <button class="_option_1svni_32">Yes</button>
      <button class="_option_1svni_32">No</button>
      <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="yn-uuid">
    </div>
  </div>

  <!-- dangling-label combobox whose listbox mounts on click and closes on Escape -->
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42 _required_f7cvd_91" for="country-uuid">Select your country of employment</label>
    <div class="_inputContainer_d7ago_28">
      <input class="_input_d7ago_28" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
    </div>
  </div>

  <!-- the REAL resume field: labelled, required, pdf accept -->
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42 _required_f7cvd_91" for="resume-input">Resume</label>
    <input id="resume-input" name="resume" type="file" accept=".pdf,.doc,.docx" required>
  </div>
  <!-- the autofill-pane trap: clipped, unlabelled, first-in-document was the OLD target -->
  <input type="file" class="visually-hidden" accept=".pdf">

  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42" for="essay-input">Describe the fastest measurable outcome you delivered.</label>
    <div class="_description_1e3gg_48">Please include the total timeline from start to finish.</div>
    <textarea id="essay-input" name="essay-input" rows="4" placeholder="Type here..."></textarea>
  </div>

  <script>
    const combo = document.querySelector('[role="combobox"]')
    const wrap = combo.parentElement
    combo.addEventListener('click', () => {
      if (wrap.querySelector('[role="listbox"]')) return
      const lb = document.createElement('ul')
      lb.setAttribute('role', 'listbox')
      for (const t of ['Brazil', 'Portugal', 'United States']) {
        const o = document.createElement('li')
        o.setAttribute('role', 'option')
        o.textContent = t
        lb.appendChild(o)
      }
      wrap.appendChild(lb)
    })
    combo.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') wrap.querySelector('[role="listbox"]')?.remove()
    })
  </script>
</body>
</html>
```

NOTE: the autofill-pane input is clip-hidden, NOT `display:none` — and clipping IS a `visible` term (plan 1 Task 7), so in a real browser `defaultMeasure` computes `clipped: true` and the pane enumerates `visible: false`. Unlabelled and scoring 0 on A8, it is therefore JUNK-FILTERED: it never reaches resolve and never renders a row. The real resume input is clipped-free, labelled and required, so it is kept and still gives its frame the file bonus in the election (score unchanged). What this fixture proves in the browser is twofold: the junk filter dropping the pane (no `(unlabelled field)` row), and the upload landing on the labelled input — the pane's `files` list stays empty.

- [ ] **Step 3: Write `e2e/election.spec.ts`**

```ts
import { test, expect } from '@playwright/test'
import { launchWithExtension, panelUrl } from './ext'
import { startFixtureServer } from './static-server'

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

interface BridgeReq { requestId: string; method: string; params: unknown }
interface ResolveParams { jobText: string; fields: { frameId: number; fid: number; epoch: number; label: string | null; kind: string; options: string[] }[] }

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
    const finder = await ext.context.newPage()
    await finder.goto(panelUrl(ext.extensionId))
    const tabId = await finder.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://*/newsletter-page.html*' })
      return tabs[tabs.length - 1]!.id!
    })

    // Scripted host: auto-values for text and choice kinds — the choice value is
    // BAIT for the interim guard (it must never reach the hidden checkbox).
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
            epoch: (p as unknown as { epoch: number }).epoch,
            resolutions: p.fields.map((f) => ({
              handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
              tier: f.kind === 'text' || f.kind === 'choice' ? 'auto' : 'needs_input',
              value: f.kind === 'text' ? 'ELECTED-FILL' : f.kind === 'choice' ? 'Yes' : null,
              source: f.kind === 'text' || f.kind === 'choice' ? 'profile' : null,
              key: null, answerId: null, reason: 'e2e',
            })),
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
    expect(resolveCalls[0]!.fields.map((f) => f.label)).not.toContain('Email')

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
    // Interim guard bypass: the auto 'Yes' for the choice row never clicked the
    // hidden checkbox (fillChoice is plan 3).
    expect(await appFrame.locator('input[name="yn-uuid"]').isChecked()).toBe(false)

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
    await expect(target.locator('#nl-email')).toHaveValue('')

    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await hostSrv.stop()
    await embedSrv.stop()
  }
})
```

- [ ] **Step 4: Migrate `full-loop.spec.ts` selectors** (the tier sections became document-order rows with `data-jff-tier` badges):

- Line 90: `panel.locator('[data-jff-group="auto"]')` → `panel.locator('li[data-jff-tier="auto"]').first()`
- Line 103: `panel.locator('[data-jff-group="needs_input"]')` → `panel.locator('li[data-jff-tier="needs_input"]').first()`
- Line 104: `panel.locator('[data-jff-group="needs_input"] li', { hasText: 'Describe a hard bug you fixed' })` → `panel.locator('li[data-jff-tier="needs_input"]', { hasText: 'Describe a hard bug you fixed' })`
- Line 200: `panel.locator('[data-jff-group="needs_input"]')` → `panel.locator('li[data-jff-tier="needs_input"]').first()`

Then confirm nothing else references the old attribute: `grep -rn 'data-jff-group' e2e extension` must return nothing.

- [ ] **Step 5: Run to verify**

Run: `npm run smoke`
Expected: foundation, full-loop, panel-port AND the new election spec all green, zero console errors. If the election spec flakes on the combobox harvest timing, the bug is in the harvest/restore path — fix the code, never widen the assertion to "options may be empty".

- [ ] **Step 6: Commit**

`git commit -am "test(e2e): two-origin election fixture — resolve/auto-fill/harvest scoped to the elected cross-origin frame"`

---

## Task 13: Slice verification + dist restore + spec ticks

**Files:** none (verification only; fix regressions in place if any surface). Spec file ticks only.

- [ ] **Step 1: Full unit sweep** — Run: `npx vitest run` — all projects green.
- [ ] **Step 2: Full verify** — Run: `npm run verify` — typecheck + lint + unit + Playwright green. Known-sensitive assertions that must stay green by construction: the greenhouse `#mystery` field still unlabelled; full-loop's snapshot-beats-panel-edit and SQLite assertions (election must not have changed what reaches `save`); the foundation EEO test (the srcdoc frame's demographic flag is computed content-side, election notwithstanding).
- [ ] **Step 3: Restore the plain dist** — Run: `npm run build`.
- [ ] **Step 4: Tick spec TODOs 12–17** in `docs/specs/2026-07-28-scan-fill-correctness-design.md` (quoted in Verification below). Leave TODO 18 UNTICKED — its "neither count lies when a batch fill fails" clause is B3's (plan 3 ticks it); this slice landed the separation and the state shape.
- [ ] **Step 5: Commit** — `git commit -am "chore: verify slice A-interaction green, tick spec TODOs 12-17"`

---

## Verification (slice level)

Command set:

```
npx vitest run                 # host + shared + extension unit suites
npm run verify                 # typecheck + lint + unit + e2e (seam build, incl. election.spec.ts)
npm run build                  # restore the plain dist afterward
```

Spec TODOs this slice ticks (quoted from the spec's Slice A list):

12. "Scan-time combobox harvest records the mounted options for openable comboboxes in the ELECTED frame only, and leaves `options: []` on failure; a combobox in a non-elected frame or a demographic combobox is never opened; a combobox with a pre-existing value has the identical value after harvest; the prompt marks combobox fields as a closed set whose option list may be partial." — Tasks 1/3/6/7 (+ Task 12 end-to-end).
13. "Exactly one frame is elected as the application frame (scored by field count, required controls, file input) and only its fields are sent to resolve, scan-time auto-fill, resume upload, and harvest. Bypass criteria: a recognizer-resolvable field in a non-elected frame (the newsletter email input) is never auto-filled and never appears in the resolve payload; election picks the form frame even when the user pasted job text." — Tasks 4/6 (+ Task 12 end-to-end, both bypass criteria).
14. "Non-elected-frame fields render collapsed under an 'Other page fields' group that names the elected frame, with a frame badge per row; they support manual fill only (no Generate, no auto-fill, not saved as answers)." — Tasks 8/10/11 (not-saved: foreign synthetic resolutions never enter App state, so `buildSaveItems` drops them — save.test.ts stays green unchanged).
15. "The resume upload targets the file field that scores on /resume|cv|currícul/i (label, name, accept; bonus for `required`); with zero positively-scoring candidates no upload happens. Bypass criterion: on the two-file-input fixture the autofill-pane input is never the upload target." — Tasks 2/5/6 (+ the e2e fixture carries the trap pair).
16. "Panel rows render kind-aware: choice/radiogroup with ≤5 options as segmented buttons, larger option sets as a picker, the A8-winning file row wired to the stored resume targeting its own fid (any other file row manual-only), textarea only for text kinds; descriptions render as subtitles." — Tasks 10/11.
17. "Panel rows follow the elected frame's document order, deterministic across rescans, with tier shown as accent + badge; 'Other page fields' sits collapsed at the bottom." — Tasks 8/10/11 (+ Task 12 document-order assertion).

NOT ticked here — TODO 18 ("The status line separates `filled` (page-accepted fills, per B3 reports) from `already on page` (page-sourced values); neither count lies when a batch fill fails."): Task 9 lands the separation, the state shape, and the exact `already on page` count; the `filled` count becomes page-accepted only when B3 (plan 3) consumes the JFF_FILL reports. Plan 3 ticks it.

## Plan decisions (interpretations an executor must not re-litigate)

1. **`EnumField.accept` is a schema addition.** Spec A8 scores the file input's `accept` attribute, but the scoring runs panel-side on `EnumField` and zod strips unknown keys — without the schema property the +1 term is unimplementable. Optional, so a stale content script omits it harmlessly. This is the only addition beyond the spec-enumerated `JFF_HARVEST`.
2. **Election scores KEPT fields** (post-`dropJunk`), not raw enumeration. The spec says "score per frame report"; raw counts would let hidden junk (the reCAPTCHA textarea) tilt the election toward frames the panel itself considers junk-laden. Kept fields are the panel's honest signal.
3. **Harvest targets only comboboxes whose enumerated `options` are empty.** The spec says "openable comboboxes"; opening a combobox whose options are already known adds mutation risk for zero information. A statically-readable listbox needs no click.
4. **Harvest restore writes the literal snapshot, even when the snapshot was `''`.** The spec's "never `''`" bans clear-to-empty as a *restore strategy* for a page-sourced value; when the pre-harvest value WAS empty, restoring `''` is the identical-value guarantee, not a clear.
5. **Election re-runs after the post-resume re-enumeration.** Fids were re-stamped under a new epoch, so the pre-upload election object is stale by construction. The recomputation is deterministic and the application frame only gains signal from its own resume-parse.
6. **"Picker with typeahead" = input + native `<datalist>`.** Native typeahead, keyboard-accessible, zero dependencies, and the committed value still flows through the one `edits[ref]` path every action already reads. A custom dropdown would re-implement the browser for no spec'd gain. Known limitation, accepted for v1: Chrome renders `input[list]` as FREE TEXT with suggestions, not a constrained picker — the user can commit a non-option. Accepted because both fill paths verify against the real options (B2's exact-match combobox fill and `fillSelect`), so a non-option fails loudly instead of misfilling; revisit if users commit non-options often.
7. **The "resume field not identified" note and the winning row are RECOMPUTED panel-side** with the same `pickResumeTarget` scan.ts used, instead of plumbing a fid through `ScanOutcome`. Same pure function + same field list = same answer, with no risk of a stale fid after re-enumeration.
8. **`data-jff-group` selectors migrate to `data-jff-tier` row badges** in App.test.tsx and full-loop.spec.ts. The spec's A9 note pre-authorizes this: those tests "assert on the old semantics and change with this".
9. **Foreign rows keep Accept structurally impossible** (their synthetic tier is only ever `needs_input`, or `skipped` for demographic fields — never `proposed`), and the `onFill` lookup spanning `[...main, ...foreign]` is the ONLY action path that can touch them. A foreign demographic row renders through FieldRow's skipped early-return, so it has no actions at all.

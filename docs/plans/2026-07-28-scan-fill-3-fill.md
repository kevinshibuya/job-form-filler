# Scan/Fill Correctness — Plan 3 of 3: B (B1–B3) Implementation Plan

**Status:** completed 2026-07-29
Progress was tracked in the SDD ledger, which no longer exists. Checkboxes below reflect authoring, not execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fill path write choice widgets, comboboxes and batched auto-fills correctly and VERIFIABLY: a `fillChoice` that reaches Ashby's hidden-input-plus-buttons pattern through the safest working step and never reports success without an observable state change (B1); a `fillCombobox` that only ever touches a listbox attributable to its control, types to filter, accepts exact matches only and restores the pre-fill value on failure (B2); and a scan-time batch-fill path whose `JFF_FILL` reports are finally consumed — the status line's `filled` becomes the page-accepted count and failed rows surface their reason (B3). The interim choice auto-fill guard from plan 1 is deleted.

**Architecture:** All fill behavior stays in the content layer (`extension/src/content/fill.ts`). `fillChoice` re-detects the choice structure with the SAME `detectChoice` the enumerator used (plan 1's exported invariant: filler and enumerator can never disagree), dispatched in `fillOne` immediately after the combobox branch — BEFORE the radio and checkbox branches, because radio dispatches first today and would swallow radio-backed choices into `fillRadioGroup`. `fillCombobox` replaces `listboxOf`'s document-wide fallback with plan 2's `attributableListbox` from `harvest.ts`. Report consumption is panel-layer: `scan.ts`'s existing per-frame auto-fill loop (plan 2's designated B3 collection site) accumulates the `JFF_FILL` replies into a new `ScanOutcome.fill`; `App.tsx` swaps the interim `filled` count source for the page-accepted number and demotes failed-fill resolutions to `needs_input` carrying the fill reason, so plan 2's `REASON_HINT['choice-needs-user-click']` renders with zero new row plumbing. No shared-schema change: `FillReportSchema` and the `JFF_FILL` reply envelope already carry everything B3 needs (verified against `shared/src/messages.ts:158-163` and `extension/src/content/index.ts:99-105`).

**Tech Stack:** TypeScript strict, zod (closed schemas in `shared/src` — untouched this slice), vitest (extension=jsdom project), React panel, Playwright e2e on plan 2's two-origin harness. No new dependencies.

**Spec:** `docs/specs/2026-07-28-scan-fill-correctness-design.md` (approved; sections B1–B3). This plan covers the 7 Slice-B TODOs plus the completion of Slice-A TODO 18 ("neither count lies"). Predecessors: `docs/plans/2026-07-28-scan-fill-1-core.md` (A1–A5) and `docs/plans/2026-07-28-scan-fill-2-interaction.md` (A6–A9) — **this plan runs on the tree where BOTH predecessor plans are fully executed and green**, and consumes their interfaces exactly (see "Interfaces consumed"). It re-creates none of them.

**Scope guard:** Do NOT touch shared schemas, host code, harvest, election, resume targeting, or the panel's row/editor composition beyond the B3 count/demotion edits. Do not change `attributableListbox` (B2 consumes it as-is). Do not add an epoch/generation mechanism — the existing discipline already covers every new await. The general BUTTON rail in `fillOne` (`fill.ts:103-105`) stays byte-identical.

## Global Constraints

Copied from the spec (standing decisions) — every task's requirements implicitly include them:

> Constraints (standing decisions): generic engine, no per-ATS adapters — every heuristic below is justified as HTML/convention repair, not Ashby-specific; never auto-submit; panel-driven UX; thin extension / smart host; do not regress radio grouping by name, shadow-DOM walking, demographic skipping, per-frame injection, epoch/generation discipline.

Plus house rules:

- TypeScript everywhere, **never `any`**; the reply boundary keeps the existing `payload as {...}` narrowing pattern. Root tsconfig has `exactOptionalPropertyTypes: false`.
- `shared/` and `host/` are Node ESM (`.js` import extensions); `extension/` is Vite/bundler-resolution (extensionless).
- Schemas in `shared/src` are CLOSED and this plan adds NOTHING to them. `FillReportSchema` already exposes `{epoch, filled: FieldHandle[], failed: {handle, reason}[]}` and the `JFF_FILL` reply already wraps it as `{ok: true, fill: report}` — B3 consumes, it does not extend.
- Never auto-submit, ever: the submit vocabulary gate and the form-ancestor gate are hard rails, and every refusal is a first-class `fill.failed` reason (`choice-needs-user-click`, `no-state-change`, `no-matching-option`).
- A fill reports success ONLY on verified page state (observable delta for choice, committed value for combobox). Reporting ok without evidence is the misfill class this whole spec kills.
- On failure, a control is restored to its PRE-FILL snapshot — never cleared to `''` (a page-sourced value must survive a failed fill identically).
- `npm run verify` (typecheck + lint + unit + e2e) green at the end of the slice; `npm run build` restores the plain dist afterward.
- Commit after every task. Never merge or push to `main` without explicit permission.

## Pre-execution gates (orchestrator, before Task 1)

1. Fresh-context Opus review of THIS PLAN (reviewer-opus-high) + one codex-review cross-vendor pass. Findings fix the plan first.
2. Baseline verify: `npm run verify` (FULL suite including every e2e spec: foundation, full-loop, panel-port, election) must be green on the plan-2-final tree before Task 1.

## Task → Model routing (initial assignment — the orchestrator re-judges at dispatch)

| Task | Model + effort | Why | Per-task verify |
| --- | --- | --- | --- |
| 1. Fill-side fixtures | editor-sonnet-low | Inert data, full content given verbatim. | `npm run typecheck && npm run lint` |
| 2. `fillChoice` + `fillOne` routing (B1) | integrator-opus-high | Highest blast radius in the slice: a wrong branch order or a mis-gated click writes to a LIVE application — worst case clicking a submit control. The two-step/verify semantics span many branch tests that must land coherently. | `npx vitest run extension/src/content/fill.test.ts && npm run typecheck` |
| 3. `fillCombobox` hardening (B2) | implementer-sonnet-medium | Full code given; two existing tests adapt deliberately; real-timer waits need care. | `npx vitest run extension/src/content/fill.test.ts && npm run typecheck` |
| 4. `scan.ts` — collect fill reports, delete interim guard (B3) | integrator-opus-high | Touches every return site of the ScanError/evidence contract in the orchestration — same rationale as plan 2 Task 6, which is why that one was opus too. | `npx vitest run extension/src/panel/scan.test.ts && npm run typecheck` |
| 5. `App.tsx` — page-accepted `filled`, failed-row demotion (B3) | implementer-sonnet-medium | Small prod diff + a React-harness stub migration across the App suite. | `npx vitest run extension/src/panel && npm run typecheck` |
| 6. e2e — choice fill end-to-end + batch-failure surfacing | integrator-opus-high | Fixture becomes a controlled widget; judgment about what the browser can prove; extends the election spec without breaking its A6/A7 assertions. | `npm run smoke` |
| 7. Slice verification + dist restore + spec TODO ticks | verifier-sonnet-low | Mechanical command-set run + evidence. | `npm run verify && npm run build` |

**Escalation rule:** if a `-sonnet-` task fails its own test cycle twice, re-dispatch to `integrator-opus-high` rather than iterating.

## Interfaces consumed (produced by plans 1–2; do not change their shapes)

- **`detectChoice(el): ChoiceDetection | null`**, `ChoiceDetection = { wrapper, buttons, options }`, `CHOICE_*` constants, `selfHidden` — `extension/src/content/enumerate.ts` (plan 1 Task 6). `fillChoice` MUST re-detect with this exact function.
- **`kindOf` / `isSoleControl`** — `extension/src/content/dom.ts` (plan 1 Task 3); used transitively by `detectChoice`.
- **`'choice'` in `WidgetKindSchema`** — `shared/src/field.ts` (plan 1 Task 2).
- **The interim choice auto-fill guard** (`choiceRefs` skip in `scan.ts`, plan 1 Task 10) — this plan DELETES it (Task 4).
- **`attributableListbox(root, el, before)`** — `extension/src/content/harvest.ts` (plan 2 Task 3). B2 imports it; the attribution rule is defined ONCE.
- **The auto-fill loop's per-frame `try/catch`** in `scan.ts` (`for (const [frameId, fills] of byFrame)`) — plan 2 Task 6 pinned it as B3's collection site; nothing else about the loop moves.
- **`ScanOutcome.election: ElectionOutcome | null`** — plan 2 Task 6. Untouched; the loop's fills are already elected-frame-only.
- **`ScanUiState` `done` shape** `{ kind: 'done'; filled; alreadyOnPage; proposed; needsInput }` — plan 2 Task 9. B3 swaps only the `filled` COUNT SOURCE (the `B3` comment in `App.tsx` marks the site); type and copy do not change.
- **`REASON_HINT['choice-needs-user-click']`** ("Select this answer on the page yourself.") — plan 2 Task 10, already rendering for any `needs_input` row whose `resolution.reason` matches. B1/B3 only have to deliver the reason.
- **Two-origin e2e harness** — `startFixtureServer(root)`, `e2e/fixtures/ashby-host/newsletter-page.html`, `e2e/fixtures/ashby-embed/apply-frame.html`, `e2e/election.spec.ts` (plan 2 Task 12).
- **Plan 1 fixture module** `extension/src/content/fixtures/ashby.ts` — `ASHBY_YESNO_EN`, `ASHBY_YESNO_PT`, `ASHBY_CHOICE_RADIO`, `STYLED_HIDDEN_CHECKBOX` are reused; Task 1 appends the fill-side variants.

---

## Task 1: Fill-side fixtures

**Files:**
- Modify: `extension/src/content/fixtures/ashby.ts` (append four exports; nothing existing changes)

**Interfaces:**
- Consumes: nothing.
- Produces: `CHOICE_RADIO_OPAQUE_VALUES`, `CHOICE_FORM_WRAPPED`, `CHOICE_SUBMIT_WORDED`, `TWO_OPEN_COMBOBOX` — imported by Tasks 2–3 tests.

- [ ] **Step 1: Append to `extension/src/content/fixtures/ashby.ts`**

```ts
/** Radio-backed choice whose radio VALUES are opaque tokens that match no
 *  button text: nothing NAMES the option on the input side, so fillChoice must
 *  answer through the (ungated) buttons — while fillRadioGroup would answer
 *  no-matching-option. Proves the dispatch order (choice BEFORE radio) with a
 *  distinguishable outcome. */
export const CHOICE_RADIO_OPAQUE_VALUES = `
<div class="_fieldEntry_1e3gg_28">
  <label class="_label_1e3gg_42" for="ov-uuid-0001">Do you require visa sponsorship?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_option_1svni_32">Sim</button>
    <button class="_option_1svni_32">Não</button>
    <input type="radio" class="_input_1svni_78" tabindex="-1" name="ov-uuid-0001" value="opt_0">
    <input type="radio" class="_input_1svni_78" tabindex="-1" name="ov-uuid-0001" value="opt_1">
  </div>
</div>`

/** Choice whose untyped buttons sit INSIDE a <form>: gate (c) refuses them —
 *  an untyped button in a form is a submit control in disguise. */
export const CHOICE_FORM_WRAPPED = `
<form action="/apply">
  <div class="_fieldEntry_1e3gg_28">
    <label class="_label_1e3gg_42" for="fw-uuid-0001">Are you willing to relocate?</label>
    <div class="_container_1svni_28 _yesno_1e3gg_148">
      <button class="_option_1svni_32">Yes</button>
      <button class="_option_1svni_32">No</button>
      <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="fw-uuid-0001">
    </div>
  </div>
</form>`

/** Choice whose matching option text is submit-worded ("Enviar"): gate (b)
 *  refuses it even though this page has NO <form> at all — exactly the
 *  motivating Ashby page's shape, where "no form ancestor" is true for every
 *  button on the page. */
export const CHOICE_SUBMIT_WORDED = `
<div class="_fieldEntry_1e3gg_28">
  <label class="_label_1e3gg_42" for="sw-uuid-0001">Ready to send your application?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148">
    <button class="_option_1svni_32">Enviar</button>
    <button class="_option_1svni_32">Não</button>
    <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="sw-uuid-0001">
  </div>
</div>`

/** Two comboboxes, the second with its listbox already mounted and attributed
 *  (aria-controls). Filling the FIRST must never touch the second's options —
 *  the cross-combobox bug B2 kills. */
export const TWO_OPEN_COMBOBOX = `
<div class="field">
  <label for="cb-a">Country</label>
  <input id="cb-a" role="combobox" aria-haspopup="listbox">
</div>
<div class="field">
  <label for="cb-b">Language</label>
  <input id="cb-b" role="combobox" aria-haspopup="listbox" aria-controls="lb-b">
  <ul role="listbox" id="lb-b"><li role="option">Portuguese</li><li role="option">English</li></ul>
</div>`
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: clean (inert data; nothing imports the new exports yet).

- [ ] **Step 3: Commit**

`git commit -am "test(fixtures): fill-side choice and combobox fixtures for slice B"`

---

## Task 2: `fillChoice` (B1) + `fillOne` routing before the radio/checkbox branches

**Files:**
- Modify: `extension/src/content/fill.ts` (new section + one insertion in `fillOne`)
- Modify: `extension/src/content/fill.test.ts` (new describe)

**Interfaces:**
- Consumes: `detectChoice`, `selfHidden`, `defaultMeasure`, `ChoiceDetection` from `./enumerate` (plan 1); `optionLabelOf` from `./dom` (already imported).
- Produces: `export async function fillChoice(el: HTMLInputElement, detection: ChoiceDetection, value: string): Promise<FillOutcome>`; `fillOne` routes SELF-HIDDEN checkbox/radio inputs with a non-null `detectChoice` through it, immediately after the combobox branch — the enumerator's full re-kinding predicate, so a visible checkbox near buttons is never treated as a choice. New refusal reasons on the wire: `choice-needs-user-click`, `no-state-change`. Task 6's e2e and the manual gate observe which step fires.
- No import cycle: `enumerate.ts` does not import `fill.ts` (verified), so `fill → enumerate` is one-directional.

Behavioral contract (spec B1 + Plan decisions 1–2 below — the executor implements the code given, which encodes it):

- **Step 1 — the hidden input, but only when a click can NAME the requested option.**
  - Radio-backed: the same-name member whose `value` attr or `optionLabelOf` normalizes to the value wins. INDEX ALIGNMENT IS NOT A STEP-1 CANDIDATE — "buttons and radios are parallel arrays" is an assumption about the page, and a wrong index answers the wrong question. No nameable member → straight to step 2; index alignment returns only as step 2's last resort (below).
  - Checkbox-backed: the value must map through the affirmative/negative vocabulary (`/^(true|yes|sim|on|1|checked)$/i` / `/^(false|no|não|nao|off|0)$/i`). Click only when `el.checked !== want` — when `checked === want` already, a click would toggle AWAY from the desired state, and silently reporting ok would be exactly the "filling No silently no-ops" lie the spec kills: fall through to step 2 so the page's real state machine (the buttons) registers the answer. Unmappable value → step 2.
  - Verification: snapshot → click → NEXT-FRAME re-snapshot → any delta = done, no button touched; no delta = fall through to step 2.
- **Step 2 — the gated button click.** The matching button (normalized text == normalized value) must (a) be a descendant of the detected wrapper (structural by construction — `detectChoice` collects buttons from the wrapper — but asserted anyway), (b) NOT match `/^(submit|apply|send|continue|next|enviar|candidatar)/i`, (c) have `type="button"` OR no `<form>` ancestor. Gate pass → snapshot → click → next-frame re-snapshot → delta = ok, none = `{ok:false, reason:'no-state-change'}`.
- **Last resort, only after the gate REFUSES** (no matching button, or a gate that failed): retry step 1 with the index-aligned member radio (member count == option count). Delta = ok; otherwise `{ok:false, reason:'choice-needs-user-click'}`. Ordering matters: the safest working step first, the risky one only when the alternative is giving up.
- **Snapshot contents:** every same-name member's `checked`+`value`, plus every button's `className`, `aria-pressed`, `aria-checked`, `data-state` (spec's exact list).
- The general BUTTON rail at the top of `fillOne` is byte-identical.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/content/fill.test.ts` (extend the top imports with `import { ASHBY_CHOICE_RADIO, ASHBY_YESNO_EN, ASHBY_YESNO_PT, CHOICE_FORM_WRAPPED, CHOICE_RADIO_OPAQUE_VALUES, CHOICE_SUBMIT_WORDED, STYLED_HIDDEN_CHECKBOX, TWO_OPEN_COMBOBOX } from './fixtures/ashby'` — `TWO_OPEN_COMBOBOX` is used by Task 3; importing it now is fine):

```ts
/** Wire click spies on every option button in the current DOM. */
function spyButtons(): { clicks: string[]; buttons: HTMLButtonElement[] } {
  const clicks: string[] = []
  const buttons = Array.from(document.querySelectorAll('button'))
  for (const b of buttons) b.addEventListener('click', () => clicks.push((b.textContent ?? '').trim()))
  return { clicks, buttons }
}

/** Ashby-like controlled checkbox: the page ignores direct input clicks and
 *  drives all state from the buttons. */
function controlCheckbox(): HTMLInputElement {
  const cb = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  cb.addEventListener('click', (e) => e.preventDefault())
  return cb
}

/** Page behavior for the buttons: clicking one marks it aria-pressed. */
function pressableButtons(): void {
  for (const b of Array.from(document.querySelectorAll('button'))) {
    b.addEventListener('click', () => {
      for (const s of Array.from(b.parentElement!.querySelectorAll('button'))) {
        s.setAttribute('aria-pressed', String(s === b))
      }
    })
  }
}

describe('fillOne — choice widgets (B1)', () => {
  it('radio-backed: clicks the value-matching member radio, zero button clicks', async () => {
    document.body.innerHTML = ASHBY_CHOICE_RADIO
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'No')).resolves.toEqual({ ok: true })
    expect(document.querySelector<HTMLInputElement>('input[value="no"]')!.checked).toBe(true)
    expect(clicks).toEqual([])
  })

  it('radio-backed with opaque values: answers through the ungated button (fillRadioGroup could not)', async () => {
    document.body.innerHTML = CHOICE_RADIO_OPAQUE_VALUES
    pressableButtons()
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'Não')).resolves.toEqual({ ok: true })
    // Proof it routed through fillChoice BEFORE the radio branch: the radios'
    // values (opt_0/opt_1) match neither 'Não' nor any option label, so
    // fillRadioGroup would have answered no-matching-option. Nothing NAMES the
    // option on the input side, so step 1 is skipped (index alignment is not a
    // step-1 candidate) and the ungated button carries the answer.
    expect(clicks).toEqual(['Não'])
    expect(document.querySelectorAll('button')[1]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to index alignment ONLY after the button gate refuses', async () => {
    // Untyped buttons inside a <form> fail gate (c); with no nameable member
    // radio, index alignment is the last thing left before asking the user.
    document.body.innerHTML = `
      <form action="/apply">
        <div class="_container_1svni_28 _yesno_1e3gg_148">
          <button class="_option_1svni_32">Sim</button>
          <button class="_option_1svni_32">Não</button>
          <input type="radio" class="_input_1svni_78" name="ix-uuid" value="opt_0">
          <input type="radio" class="_input_1svni_78" name="ix-uuid" value="opt_1">
        </div>
      </form>`
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'Não')).resolves.toEqual({ ok: true })
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"]')!.checked).toBe(true)
    expect(clicks).toEqual([]) // the in-form button was never clicked
  })

  it('checkbox-backed, click-accepting: fills affirmative with ZERO button clicks', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const { clicks } = spyButtons()
    const cb = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: true })
    expect(cb.checked).toBe(true)
    expect(clicks).toEqual([])
  })

  it('checkbox-backed, controlled input: falls through to the matching button', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const cb = controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: true })
    expect(cb.checked).toBe(false) // the input click was prevented; the button carried the answer
    expect(clicks).toEqual(['Yes'])
    expect(document.querySelectorAll('button')[0]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('filling "No" on an unchecked controlled box NEVER silently no-ops: the button is clicked', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const cb = controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'No')).resolves.toEqual({ ok: true })
    expect(clicks).toEqual(['No'])
    expect(document.querySelectorAll('button')[1]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('matches i18n option texts verbatim (Não), never boolean-mapped', async () => {
    document.body.innerHTML = ASHBY_YESNO_PT
    controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Não')).resolves.toEqual({ ok: true })
    expect(clicks).toEqual(['Não'])
  })

  it('never clicks an untyped button inside a <form>', async () => {
    document.body.innerHTML = CHOICE_FORM_WRAPPED
    const cb = controlCheckbox() // step 1 is prevented, so only the gate stands between us and the button
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
    expect(clicks).toEqual([])
  })

  it('refuses a submit-worded button even with NO <form> on the page', async () => {
    document.body.innerHTML = CHOICE_SUBMIT_WORDED
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Enviar'))
      .resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
    expect(clicks).toEqual([])
  })

  it('answers choice-needs-user-click when no button matches the value', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    controlCheckbox()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Maybe'))
      .resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
  })

  it('reports no-state-change when the clicked button produces no observable delta', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    controlCheckbox() // inert buttons: no listeners, no attribute changes
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Yes'))
      .resolves.toEqual({ ok: false, reason: 'no-state-change' })
    expect(clicks).toEqual(['Yes']) // the click WAS attempted; success was not claimed without evidence
  })

  it('a styled hidden checkbox with no sibling buttons still takes the plain checkbox path', async () => {
    document.body.innerHTML = STYLED_HIDDEN_CHECKBOX
    const el = document.getElementById('tos-check') as HTMLInputElement
    // Correct no-op: unchecking an already-unchecked box reports ok, zero clicks.
    const clicks = vi.fn()
    el.addEventListener('click', clicks)
    await expect(fillOne(el, 'false')).resolves.toEqual({ ok: true })
    expect(clicks).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/content/fill.test.ts`
Expected: the new describe FAILS — checkbox-backed choices route into `fillCheckbox` ('Yes' checks the CONTROLLED box? no — prevented, so `click-rejected`; 'No' on unchecked reports ok silently; 'Não'/'Maybe' report ok/click-rejected), radio-backed opaque values answer `no-matching-option`. Every pre-existing test still passes.

- [ ] **Step 3: Implement in `extension/src/content/fill.ts`**

Extend the enumerate import: `import { defaultMeasure, detectChoice, elementByFid, selfHidden, type ChoiceDetection } from './enumerate'`.

Add below `fillCheckbox`:

```ts
/* --------------------------------------------------------------- B1: choice */

/** Submit vocabulary: a button whose normalized text starts with one of these
 *  is NEVER clicked, whatever the other gates say. */
const SUBMIT_WORD_RE = /^(submit|apply|send|continue|next|enviar|candidatar)/i

const AFFIRMATIVE_RE = /^(true|yes|sim|on|1|checked)$/i
const NEGATIVE_RE = /^(false|no|não|nao|off|0)$/i

/** The page's framework needs a frame to react before the re-snapshot. rAF in
 *  a real browser; a macrotask where the environment has none (jsdom). */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })

/** Same-name radios in the wrapper are ONE choice control (plan 1's radio
 *  exemption); a checkbox stands alone. */
function choiceMembers(el: HTMLInputElement, wrapper: Element): HTMLInputElement[] {
  if (el.type !== 'radio') return [el]
  const name = el.getAttribute('name')
  if (name === null || name === '') return [el]
  return Array.from(wrapper.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`,
  ))
}

/** The observable-state fingerprint the spec verifies against: every member's
 *  checked/value plus every button's className and aria/data state. Any delta
 *  between two fingerprints is evidence the page took the fill. */
function choiceFingerprint(members: HTMLInputElement[], buttons: HTMLButtonElement[]): string {
  const inputs = members.map((m) => `${String(m.checked)}|${m.value}`)
  const btns = buttons.map((b) => [
    b.className,
    b.getAttribute('aria-pressed'),
    b.getAttribute('aria-checked'),
    b.getAttribute('data-state'),
  ].join('|'))
  return [...inputs, ...btns].join('\n')
}

/**
 * B1: fill a hidden-input-plus-buttons choice widget, cheapest and safest step
 * first, success ONLY on an observable state change.
 *
 * Step 1 — the hidden input itself, but only when a click can NAME the
 * requested option: the value-matching member radio, or the checkbox when the
 * value maps through the yes/no vocabulary AND the click moves TOWARD the
 * desired state. A checkbox already at the desired state gets no click and no
 * silent ok — the buttons are the page's real state machine, and "filling No
 * silently no-ops" is the exact lie this function exists to kill (spec B1).
 *
 * Step 2 — the gated button click: text match, never submit-worded, and
 * type="button" or no <form> ancestor. The motivating Ashby page has NO <form>
 * at all, so gates (a)/(b) carry the rail there.
 *
 * Last resort — index alignment (member radio at the matching option's index),
 * tried ONLY when step 2's gate refused. It assumes the page renders buttons
 * and radios as parallel arrays; that assumption is cheap to be wrong about
 * only when the alternative is refusing the fill outright.
 */
export async function fillChoice(
  el: HTMLInputElement,
  detection: ChoiceDetection,
  value: string,
): Promise<FillOutcome> {
  const { wrapper, buttons, options } = detection
  const members = choiceMembers(el, wrapper)
  const target = norm(value)

  const clickAndVerify = async (input: HTMLElement): Promise<boolean> => {
    const before = choiceFingerprint(members, buttons)
    input.click()
    await nextFrame()
    return choiceFingerprint(members, buttons) !== before
  }

  // STEP 1 — only an input that NAMES the option: the member whose value attr
  // or option label matches. Index alignment is deliberately NOT a step-1
  // candidate: "buttons and radios are parallel arrays" is an assumption about
  // the page, and when it is wrong the click answers the WRONG option — a
  // misfill, which is worse than asking the user. It comes back below as a last
  // resort, once the safer button path has refused.
  const optIndex = options.findIndex((o) => norm(o) === target)
  const byIndex = el.type === 'radio' && members.length === options.length && optIndex >= 0
    ? members[optIndex] ?? null
    : null

  let stepOneTarget: HTMLInputElement | null = null
  if (el.type === 'radio') {
    const byValue = members.find((m) => norm(m.value) === target)
    const byLabel = members.find((m) => norm(optionLabelOf(m)) === target)
    stepOneTarget = byValue ?? byLabel ?? null
  } else if (AFFIRMATIVE_RE.test(target) || NEGATIVE_RE.test(target)) {
    const want = AFFIRMATIVE_RE.test(target)
    if (el.checked !== want) stepOneTarget = el
  }
  if (stepOneTarget !== null && await clickAndVerify(stepOneTarget)) return { ok: true }

  // STEP 2 — the gated button click.
  const btn = buttons.find((b) => norm(b.textContent ?? '') === target)
  const gated = btn === undefined
    || !wrapper.contains(btn) // (a) — structural by construction, asserted anyway
    || SUBMIT_WORD_RE.test(norm(btn.textContent ?? '')) // (b)
    || (btn.type !== 'button' && btn.closest('form') !== null) // (c)
  if (gated) {
    // The gate REFUSED (or no button matched). Only now is index alignment
    // worth its risk — the alternative left is handing the row back to the user.
    if (byIndex !== null && byIndex !== stepOneTarget && await clickAndVerify(byIndex)) return { ok: true }
    return { ok: false, reason: 'choice-needs-user-click' }
  }
  if (await clickAndVerify(btn)) return { ok: true }
  return { ok: false, reason: 'no-state-change' }
}
```

Then insert the routing into `fillOne`, between the combobox line and the `HTMLSelectElement` line — the surrounding lines (the BUTTON rail above, every branch below) are byte-identical:

```ts
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return fillCombobox(el, value)
  // B1: choice widgets dispatch on LIVE structure — the same detectChoice the
  // enumerator used, under the same selfHidden gate, so filler and enumerator
  // can never disagree — and BEFORE the radio and checkbox branches: radio
  // dispatches first below, and a later placement would swallow radio-backed
  // choices into fillRadioGroup.
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && selfHidden(defaultMeasure(el))) {
    const choice = detectChoice(el)
    if (choice !== null) return fillChoice(el, choice, value)
  }
  if (el instanceof HTMLSelectElement) return fillSelect(el, value)
```

The gate is the enumerator's FULL predicate, not just `detectChoice`: `enumerateFields` only re-kinds a control to `choice` when `selfHidden(measure(el))` is true, so a VISIBLE checkbox that merely happens to sit next to two short buttons must keep the plain checkbox path here too. Executor note: in jsdom `getBoundingClientRect()` is 0×0, so `isClipped` → true → `selfHidden` → true, and every Task 2 unit test below passes unchanged; the gate only bites in a real browser — which is exactly where the visible-checkbox false positive lives.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/content && npm run typecheck && npm run lint`
Expected: the new describe green, every pre-existing content test still green — especially `'toggles a checkbox by clicking, only when the state must change'` (a bare checkbox has no sibling buttons → `detectChoice` null → `fillCheckbox` path untouched) and `'never clicks a submit control'` (the BUTTON rail is above the choice branch and byte-identical).

- [ ] **Step 5: Commit**

`git commit -am "feat(content): fillChoice — value-naming input click, gated button click, observable-state verification"`

---

## Task 3: `fillCombobox` hardening (B2) — attribution, typeahead, exact-only, restore

**Files:**
- Modify: `extension/src/content/fill.ts` (replace `listboxOf` + `fillCombobox`)
- Modify: `extension/src/content/fill.test.ts` (new describe; TWO existing tests adapted deliberately)

**Interfaces:**
- Consumes: `attributableListbox` + `mountedListboxes` from `./harvest` (plan 2 — the ONE definition of the attribution rule and of its `before` snapshot), `setNativeValue`, `nextFrame` (Task 2), `TWO_OPEN_COMBOBOX` (Task 1).
- Produces: a `fillCombobox` that (1) never touches an unattributable listbox, (2) drives the typeahead with `setNativeValue` when the target option is not mounted, (3) selects EXACT normalized matches only (prefix fallback deleted), (4) verifies the committed value/text EQUALS the choice (normalized), (5) restores the pre-fill snapshot and closes the listbox (Escape + blur, harvest's recipe) on every failure path. `listboxOf` is DELETED (its only caller was `fillCombobox`).
- Import note: this creates the module pair `harvest.ts ⇄ fill.ts` (`harvest` already imports `setNativeValue` from `fill`). Both edges bind hoisted function declarations used only at call time, no top-level execution depends on the other module, and no `import/no-cycle` lint rule exists in this repo — safe under Vite and Vitest (Plan decision 5).

Behavioral contract (spec B2, exact):

1. Snapshot the control's value BEFORE anything (never restore to `''` unless `''` WAS the snapshot). Snapshot the set of mounted `[role=listbox]` elements. Real `.click()` to open.
2. Poll (50ms) up to 500ms for an attributable listbox containing an EXACT normalized match. Break early as soon as the attributable listbox has options but no exact match (waiting longer adds nothing — the typeahead is the next move).
3. No attributable listbox at all within the window → fail `no-matching-option` (restore + close). Options mounted but no exact match: if the control is not a typeable input → fail `no-matching-option` (restore + close); else `setNativeValue(el, value)` to drive the typeahead, then poll the FULL 500ms for an exact match (no early break — the page filters asynchronously). Still none → restore + close, fail `no-matching-option`.
4. Exact hit → `.click()` it → next frame → verify the committed value (`input.value`, else `textContent`) is normalized-EQUAL to the normalized choice — never "contains": a committed 'United States Minor Outlying Islands' must not pass a 'United States' fill. Mismatch → restore the snapshot + close, fail `no-matching-option`.

- [ ] **Step 1: Write the failing tests + adapt two existing ones**

Adapt these two tests in the `fillOne` describe of `extension/src/content/fill.test.ts` — both change DELIBERATELY because B2 adds commit verification, which the old inert fixtures cannot pass:

1. `'opens an ARIA combobox and clicks the matching option'`: inside the existing option-spy loop, make the page commit the pick — after `o.addEventListener('click', () => picked.push(o.textContent ?? ''))` add a second listener:

```ts
      o.addEventListener('click', () => { combo.textContent = o.textContent })
```

(The assertion block is unchanged; the div combobox now passes the committed-text check the way a real widget would.)

2. `'reports a failure when the combobox has no matching option'`: unchanged assertions, but it now exercises the "mounted options, unmatched, not typeable" path — verify it still passes as written (it must; if it hangs 500ms+ the early-break is missing).

Then append the new describe:

```ts
describe('fillCombobox — attribution, typeahead, restore (B2)', () => {
  it("never selects an option from another combobox's listbox", async () => {
    document.body.innerHTML = TWO_OPEN_COMBOBOX
    const otherOptions: string[] = []
    for (const o of Array.from(document.querySelectorAll('[role="option"]'))) {
      o.addEventListener('click', () => otherOptions.push(o.textContent ?? ''))
    }
    const a = document.getElementById('cb-a') as HTMLInputElement
    // cb-a owns no listbox and none appears for it: attribution fails, the fill
    // fails — and cb-b's mounted listbox is NEVER consulted (the old
    // document-wide fallback would have clicked 'Portuguese').
    await expect(fillOne(a, 'Portuguese')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(otherOptions).toEqual([])
    expect((document.getElementById('cb-b') as HTMLInputElement).value).toBe('')
  }, 10_000) // runs the real 500ms attribution window

  it('uses a listbox that appears in response to OUR click', async () => {
    document.body.innerHTML = '<div><input id="c" role="combobox"></div>'
    const el = document.getElementById('c') as HTMLInputElement
    el.addEventListener('click', () => {
      const lb = document.createElement('ul')
      lb.setAttribute('role', 'listbox')
      for (const t of ['Brazil', 'Portugal']) {
        const o = document.createElement('li')
        o.setAttribute('role', 'option')
        o.textContent = t
        o.addEventListener('click', () => setNativeValue(el, t))
        lb.appendChild(o)
      }
      el.parentElement!.appendChild(lb)
    })
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: true })
    expect(el.value).toBe('Portugal')
  })

  it('types natively to filter when the target option is not mounted, then selects the EXACT match', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb">
        <ul role="listbox" id="lb"><li role="option">Brazil</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    const lb = document.getElementById('lb')!
    // The page's typeahead: re-render the options from the typed value.
    el.addEventListener('input', () => {
      lb.innerHTML = ''
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = 'Portugal'
      o.addEventListener('click', () => setNativeValue(el, 'Portugal'))
      lb.appendChild(o)
    })
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: true })
    expect(el.value).toBe('Portugal')
  })

  it('rejects a prefix match and RESTORES the pre-fill value (prefix guessing removed)', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb" value="Lisbon">
        <ul role="listbox" id="lb"><li role="option">Portugal</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    const picked = vi.fn()
    document.querySelector('[role="option"]')!.addEventListener('click', picked)
    // Old behavior: 'Port' prefix-matched 'Portugal'. Now: no exact match, the
    // typeahead types 'Port', the page never mounts an exact option, and the
    // control comes back EXACTLY as it was — never cleared to ''.
    await expect(fillOne(el, 'Port')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(picked).not.toHaveBeenCalled()
    expect(el.value).toBe('Lisbon')
  }, 10_000) // runs the real post-typeahead 500ms window

  it('fails and restores when the page rejects the committed value', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb" value="Kept">
        <ul role="listbox" id="lb"><li role="option">Portugal</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    // The option click commits NOTHING (a controlled widget that ignored us).
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(el.value).toBe('Kept')
  })

  it('closes the listbox via Escape on failure so no dropdown is left open', async () => {
    document.body.innerHTML = '<div><input id="c" role="combobox"></div>'
    const el = document.getElementById('c') as HTMLInputElement
    el.addEventListener('click', () => {
      if (el.parentElement!.querySelector('[role="listbox"]') !== null) return
      const lb = document.createElement('ul')
      lb.setAttribute('role', 'listbox')
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = 'Brazil'
      lb.appendChild(o)
      el.parentElement!.appendChild(lb)
    })
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') el.parentElement!.querySelector('[role="listbox"]')?.remove()
    })
    await expect(fillOne(el, 'Nowhere')).resolves.toMatchObject({ ok: false })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  }, 10_000)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/content/fill.test.ts`
Expected: the new describe FAILS — the cross-combobox test selects 'Portuguese' via the document-wide fallback, the prefix test succeeds instead of failing, nothing restores, nothing closes. The two adapted tests still pass against the OLD code (the extra listeners are additive).

- [ ] **Step 3: Implement in `extension/src/content/fill.ts`**

Add the import: `import { attributableListbox, mountedListboxes } from './harvest'` — the attribution rule AND its matching pre-interaction snapshot are defined once, in `harvest.ts` (plan 2 Task 3); both search the control's scope (open shadow root) and the document.

DELETE `listboxOf` entirely. Replace `fillCombobox` with:

```ts
/** How long the combobox may take to mount options after our click, and again
 *  after our typeahead keystroke (spec B2, mirrors HARVEST_LISTBOX_TIMEOUT_MS). */
const COMBOBOX_WAIT_MS = 500
const COMBOBOX_POLL_MS = 50

/**
 * B2: interact ONLY with a listbox attributable to this control — aria-owns/
 * aria-controls, or one that appeared in response to OUR interaction (the same
 * attributableListbox rule the harvest defined; the document-wide fallback was
 * the cross-combobox bug). No exact normalized match mounted → drive the
 * typeahead with a native value write → EXACT match only (prefix guessing
 * removed) → verify the page committed the choice. Every failure path restores
 * the pre-fill snapshot (never a clear to '') and closes via Escape + blur.
 */
async function fillCombobox(el: Element, value: string): Promise<FillOutcome> {
  const input = el instanceof HTMLInputElement ? el : null
  const snapshot = input === null ? null : input.value
  const before = mountedListboxes(document, el)
  ;(el as HTMLElement).click()
  const target = norm(value)

  const lookup = (): { mounted: boolean; options: number; hit: HTMLElement | null } => {
    const listbox = attributableListbox(document, el, before)
    if (listbox === null) return { mounted: false, options: 0, hit: null }
    const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'))
    return {
      mounted: true,
      options: options.length,
      hit: options.find((o) => norm(o.textContent ?? '') === target) ?? null,
    }
  }

  const waitForHit = async (breakOnOptions: boolean): Promise<{ hit: HTMLElement | null; sawListbox: boolean }> => {
    const deadline = Date.now() + COMBOBOX_WAIT_MS
    let sawListbox = false
    for (;;) {
      const m = lookup()
      sawListbox = sawListbox || m.mounted
      if (m.hit !== null) return { hit: m.hit, sawListbox }
      // Options are mounted and the choice is not among them: waiting longer
      // adds nothing — the typeahead is the next move.
      if (breakOnOptions && m.options > 0) return { hit: null, sawListbox }
      if (Date.now() >= deadline) return { hit: null, sawListbox }
      await wait(COMBOBOX_POLL_MS)
    }
  }

  const failClosed = (): FillOutcome => {
    // Close the way a user backs out (harvest's recipe), then put the control
    // back EXACTLY as we found it — a page-sourced value must survive, and ''
    // is only ever written when '' WAS the snapshot.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    if (el instanceof HTMLElement) el.blur()
    if (input !== null && snapshot !== null && input.value !== snapshot) setNativeValue(input, snapshot)
    return { ok: false, reason: 'no-matching-option' }
  }

  let { hit, sawListbox } = await waitForHit(true)
  if (hit === null) {
    // No attributable listbox, or a listbox whose mounted options lack the
    // choice on a control we cannot type into: nothing safe left to try.
    if (!sawListbox || input === null) return failClosed()
    setNativeValue(input, value)
    ;({ hit } = await waitForHit(false))
    if (hit === null) return failClosed()
  }

  hit.click()
  await nextFrame()
  // EXACT normalized equality, never `includes`: a widget that committed
  // 'United States Minor Outlying Islands' would false-pass a 'United States'
  // fill, which is a misfill reported as success — the class this slice kills.
  const committed = input !== null ? input.value : (el.textContent ?? '')
  if (norm(committed) !== target) return failClosed()
  return { ok: true }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/content && npm run typecheck && npm run lint`
Expected: fill.test fully green (new describe + both adapted tests + every untouched test), harvest/enumerate/dom/classify/snapshot suites untouched and green.

- [ ] **Step 5: Commit**

`git commit -am "feat(content): fillCombobox — attributed listbox only, native typeahead, exact match, verified commit, restore on failure"`

---

## Task 4: `scan.ts` — collect `JFF_FILL` reports, delete the interim choice guard (B3)

**Files:**
- Modify: `extension/src/panel/scan.ts` (auto-fill loop + `ScanOutcome` + every return site)
- Modify: `extension/src/panel/scan.test.ts` (one rewritten test + one new describe + a mechanical outcome-literal sweep)

**Interfaces:**
- Consumes: the per-frame auto-fill `try/catch` (plan 2's designated collection site), `FillReport` + `FieldHandle` types from `@jff/shared`, plan 1's interim `choiceRefs` guard (to delete), and plan 1 Task 10's file-scope `depsWithFields` test helper.
- Produces: `export interface FillFailure { handle: FieldHandle; reason: string }`; `export interface CollectedFill { filled: FieldHandle[]; failed: FillFailure[] }`; `ScanOutcome.fill: CollectedFill` (insert after `resolutions`). Panel-internal types only — NO shared-schema change. Consumed by Task 5 (`App.tsx`) and Task 6 (e2e).

Design constraints (each is load-bearing):

1. **Types + helper**, next to `ScanOutcome`:

```ts
export interface FillFailure { handle: FieldHandle; reason: string }

/** B3: what the batched scan-time auto-fill ACTUALLY did, per the frames' own
 *  JFF_FILL reports. `filled` is page-accepted only — the count the status
 *  line shows. Failures carry the frame's per-field reason so the panel can
 *  demote the row and render the hint. */
export interface CollectedFill { filled: FieldHandle[]; failed: FillFailure[] }

const emptyFill = (): CollectedFill => ({ filled: [], failed: [] })
```

Extend the shared import: `import type { ContentMessage, EnumField, FieldHandle, FillReport, HostErrorKind, Resolution, ResolveResult } from '@jff/shared'`.

2. **Delete the interim guard** (plan 1 Task 10): remove the `choiceRefs` `Set` construction and the `if (choiceRefs.has(...)) continue` line from the auto-fill selection loop. The base skip condition (`r.tier !== 'auto' || r.source === 'page' || r.value === null || r.value === ''`) is untouched. Choice-kind resolutions now flow into `JFF_FILL` and are handled by Task 2's `fillChoice` in the content script.

3. **The collection**, replacing ONLY the body of the per-frame loop (the loop's structure, its comment about vanished frames, and the evidence report on throw all stay):

```ts
    const fill = emptyFill()
    for (const [frameId, fills] of byFrame) {
      try {
        const { replies } = await deps.sendToTab(frameId, { type: 'JFF_FILL', epoch, fills })
        const p = replies[0]?.payload as { ok?: boolean; error?: string; fill?: FillReport } | undefined
        if (p?.ok === true && p.fill !== undefined) {
          fill.filled.push(...p.fill.filled)
          fill.failed.push(...p.fill.failed)
        } else {
          // A refused envelope (stale_epoch, bad_fill_report) accepted NOTHING:
          // every fill sent to this frame failed, with the frame's own reason.
          for (const f of fills) fill.failed.push({ handle: f.handle, reason: p?.error ?? 'no-fill-report' })
        }
      } catch (e) {
        // A frame that vanished mid-fill (wizard advanced, iframe swapped) is
        // evidence, not a reason to throw away the resolved scan.
        reports = [...reports, { frameId, url: null, fields: null, error: `fill failed: ${String(e)}` }]
        for (const f of fills) fill.failed.push({ handle: f.handle, reason: 'frame-unreachable' })
      }
    }
```

4. **Every return site** of `runScan` gains a `fill` property: the final return uses the collected `fill`; EVERY earlier return (the PHASE-0 captcha/empty returns, plan 1's kept-empty return, the post-jobText captcha return, the post-resume captcha/empty returns, the llmError return) uses `fill: emptyFill()` — nothing was attempted, so empty is the honest report and `filled: 0` cannot lie.

5. **Nothing else moves**: election scoping, harvest, phase order, epoch discipline, `ScanError` evidence are plan 2's and stay byte-identical.

- [ ] **Step 1: Rewrite the interim-guard test, add the failing describe, sweep outcome literals**

In `extension/src/panel/scan.test.ts`:

(a) REPLACE the test `'never auto-fills a choice field before fillChoice lands (interim guard, removed by plan 3)'` (plan 1 Task 10) with:

```ts
  it('sends choice resolutions through the batch fill (interim guard deleted — fillChoice owns them now)', async () => {
    const { deps, sent } = depsWithFields(junkAnd2, 'auto')
    await runScan(deps)
    const fills = sent.filter((m) => m.type === 'JFF_FILL') as { fills: { handle: { fid: number } }[] }[]
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.some((m) => m.fills.some((x) => x.handle.fid === 2))).toBe(true) // the choice fid IS filled
  })
```

(b) Append a new describe (reuse the file's `field`/`makeDeps`/`depsWithFields` helpers; `depsWithFields` is plan 1 Task 10's and lives at FILE SCOPE, below `makeDeps`, precisely so this describe can call it — if its fill reply is the `makeDeps` default `{ ok: true, fill: { epoch, filled: [], failed: [] } }`, the echo/failure behaviors below override `sendToTab` per test. `depsWithFields` pushes to `sent` only for the message it answers itself, so the wrappers below must push their own `JFF_FILL` — as `reportingDeps` does):

```ts
describe('runScan — B3 fill report collection', () => {
  const twoAuto = [field(0, 0), field(0, 1, { kind: 'choice', visible: false, label: 'Authorized?', options: ['Yes', 'No'] })]

  /** Wraps depsWithFields so JFF_FILL answers with a scripted per-frame report. */
  function reportingDeps(reply: (fills: { handle: { frameId: number; fid: number; epoch: number } }[], epoch: number) => unknown) {
    const made = depsWithFields(twoAuto, 'auto')
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_FILL') {
        made.sent.push(message)
        return { replies: [{ frameId: frameId ?? 0, payload: reply(message.fills, message.epoch) }], failures: [] }
      }
      return inner(frameId, message)
    })
    return made
  }

  it('collects page-accepted and failed fills from the JFF_FILL reports', async () => {
    const { deps } = reportingDeps((fills, epoch) => ({
      ok: true,
      fill: {
        epoch,
        filled: [fills[0]!.handle],
        failed: [{ handle: fills[1]!.handle, reason: 'choice-needs-user-click' }],
      },
    }))
    const out = await runScan(deps)
    expect(out.fill.filled).toEqual([expect.objectContaining({ frameId: 0, fid: 0 })])
    expect(out.fill.failed).toEqual([
      { handle: expect.objectContaining({ frameId: 0, fid: 1 }), reason: 'choice-needs-user-click' },
    ])
  })

  it('a refused envelope (stale epoch) fails every fill sent to that frame, with its reason', async () => {
    const { deps } = reportingDeps(() => ({ ok: false, error: 'stale_epoch' }))
    const out = await runScan(deps)
    expect(out.fill.filled).toEqual([])
    expect(out.fill.failed.map((f) => f.reason)).toEqual(['stale_epoch', 'stale_epoch'])
  })

  it('a frame that dies mid-fill fails its fills as frame-unreachable AND keeps the evidence report', async () => {
    const made = depsWithFields(twoAuto, 'auto')
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_FILL') throw new Error('frame vanished mid-fill')
      return inner(frameId, message)
    })
    const out = await runScan(made.deps)
    expect(out.fill.filled).toEqual([])
    expect(out.fill.failed.map((f) => f.reason)).toEqual(['frame-unreachable', 'frame-unreachable'])
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('fill failed'))).toBe(true)
  })

  it('a scan that never fills reports an EMPTY fill, not a lying one', async () => {
    const { deps } = depsWithFields([field(0, 0)], 'needs_input')
    const out = await runScan(deps)
    expect(out.fill).toEqual({ filled: [], failed: [] })
  })
})
```

(c) MECHANICAL SWEEP: any pre-existing test that deep-equals a whole `ScanOutcome` (or an early-return outcome object) gains `fill: { filled: [], failed: [] }` in its expected literal. Tests using `toMatchObject`/property assertions are untouched. Search: `rg -n 'toEqual\(\{' extension/src/panel/scan.test.ts` and inspect each hit.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/scan.test.ts`
Expected: the rewritten guard test FAILS (fid 2 still skipped), the new describe FAILS (`out.fill` undefined). Pre-existing tests still pass (or fail ONLY on the missing `fill` key where the sweep applied — that is the same missing implementation).

- [ ] **Step 3: Implement** per design constraints 1–5.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel/scan.test.ts && npm run typecheck && npm run lint`
Expected: ALL scan tests green — especially plan 2's election/harvest describes (untouched behavior) and the epoch/evidence tests. If an election test fails, the loop edit leaked outside the collection site — fix the code, not the test.

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): scan collects JFF_FILL reports into ScanOutcome.fill; interim choice guard deleted"`

---

## Task 5: `App.tsx` — page-accepted `filled` count + failed-row demotion (B3)

**Files:**
- Modify: `extension/src/panel/App.tsx` (the post-scan generation-guarded block ONLY)
- Modify: `extension/src/panel/App.test.tsx` (default-stub echo migration + one new describe)

**Interfaces:**
- Consumes: `ScanOutcome.fill` (Task 4), `refOf` (already imported), plan 2's `done` state shape and `REASON_HINT`/`data-jff-tier` row contract.
- Produces: the status line's `filled` = `out.fill.filled.length` (page-accepted); resolutions whose batched fill FAILED are demoted in App state to `tier: 'needs_input'` carrying the fill reason — so the row re-renders with needs-input styling, the tier badge flips, `REASON_HINT` shows the hint for hinted reasons, and the user gets the Generate/Fill actions to recover. `alreadyOnPage`/`proposed`/`needsInput` are computed over the DEMOTED array so the four numbers always sum consistently (Plan decision 4 covers why demotion is safe for save/accept).

- [ ] **Step 1: Migrate the App.test.tsx JFF_FILL stubs, then add the failing describe**

(a) NO STUB MIGRATION IS REQUIRED — no existing App test yields a `tier: 'auto'` resolution, so the scan-time auto-fill loop never runs there and `out.fill` is empty. Do NOT touch `fillRefused`/`fillReply` (App.test.tsx:449, 854): their `failed[]` payloads are the subject of the per-action refusal tests. Run the suite; if a test regresses, add an echoing `JFF_FILL` branch to that stub only:

```ts
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        const fills = (msg.message as { fills: { handle: unknown }[] }).fills
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: fills.map((f) => f.handle), failed: [] } } }], failures: [] }
      }
```

(placed BEFORE that stub's generic `toContent` fallback; keep its existing frameId if it differs.)

(b) Append the new describe (reuse the suite's render/scan harness conventions — `SELF_CHECK`, `HostResponse`, the `installTwoFrameScan`-style stub pattern from plan 2's election describe):

```tsx
describe('App — B3 page-accepted fills and failure surfacing', () => {
  function installScanWithFillReport(): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const fields = [
      { frameId: -1, fid: 0, epoch: 1, label: 'First name', name: 'first', idAttr: null, kind: 'text', options: [], required: true, visible: true, currentValue: null, demographic: false },
      { frameId: -1, fid: 1, epoch: 1, label: 'Authorized to work?', name: 'auth', idAttr: null, kind: 'choice', options: ['Yes', 'No'], required: true, visible: false, currentValue: null, demographic: false },
    ]
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string; fills?: { handle: { frameId: number; fid: number; epoch: number } }[] } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return { ok: true, replies: [{ frameId: 0, url: 'https://ats.example/', payload: { ok: true, scan: { epoch: 1, fields, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        const fills = msg.message.fills!
        // The page accepted the text fill and REFUSED the choice fill.
        return {
          ok: true,
          replies: [{ frameId: 0, payload: { ok: true, fill: {
            epoch: 1,
            filled: fills.filter((f) => f.handle.fid === 0).map((f) => f.handle),
            failed: fills.filter((f) => f.handle.fid === 1).map((f) => ({ handle: f.handle, reason: 'choice-needs-user-click' })),
          } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number; kind: string }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'auto' as const,
          value: f.kind === 'choice' ? 'Yes' : 'Kevin', source: 'profile' as const,
          key: null, answerId: null, reason: 'test',
        })), llmError: null } }
      }
      if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
      return { requestId, ok: true, result: {} }
    }
  }

  it('counts only page-accepted fills and demotes the failed row with its reason and hint', async () => {
    installScanWithFillReport()
    render(<App />)
    // 1 page-accepted (text) — NOT 2, even though both resolutions are tier auto.
    await screen.findByText('✓ 1 filled, 0 already on page, 0 proposed, 1 need input')
    // The failed choice row dropped to needs-input styling with the refusal hint.
    const demoted = Array.from(document.querySelectorAll('li[data-jff-tier="needs_input"]'))
      .find((li) => li.textContent?.includes('Authorized to work?'))
    expect(demoted).toBeDefined()
    expect(demoted!.textContent).toContain('Select this answer on the page yourself.')
    // The accepted row keeps its auto tier.
    const kept = Array.from(document.querySelectorAll('li[data-jff-tier="auto"]'))
      .find((li) => li.textContent?.includes('First name'))
    expect(kept).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extension/src/panel/App.test.tsx`
Expected: the new test FAILS (`✓ 2 filled...` renders — the interim count source — and the choice row sits under `data-jff-tier="auto"` with no hint). The migrated stubs keep every pre-existing test green.

- [ ] **Step 3: Implement in `App.tsx`**

In `onScan`'s post-scan generation-guarded block, replace `setResolutions(out.resolutions)` with:

```ts
      // B3: a resolution whose batched auto-fill the page REJECTED is not
      // "filled" — demote it to needs_input carrying the fill reason, so the
      // row drops to needs-input styling, REASON_HINT renders the hint
      // (choice-needs-user-click → "Select this answer on the page yourself."),
      // and the user gets Generate/Fill to recover. Page-sourced rows are never
      // in `failed` (the loop skips them), so `already on page` is untouched.
      const failedFillReason = new Map(out.fill.failed.map((f) => [refOf(f.handle), f.reason]))
      const resolutions = out.resolutions.map((r) =>
        failedFillReason.has(refOf(r.handle))
          ? { ...r, tier: 'needs_input' as const, reason: failedFillReason.get(refOf(r.handle))! }
          : r)
      setResolutions(resolutions)
```

Then replace the count block (the one plan 2 Task 9 wrote with the `INTERIM — B3` comment) with:

```ts
      // A9/B3 status semantics: `filled` = PAGE-ACCEPTED batched fills, straight
      // from the frames' JFF_FILL reports — never inferred from tiers, so a
      // failed batch can never inflate it. `already on page` = page-sourced
      // values the engine never wrote. The remaining counts run over the
      // DEMOTED array so the four numbers always describe the rows on screen.
      const filled = out.fill.filled.length
      const alreadyOnPage = resolutions.filter((r) => r.tier === 'auto' && r.source === 'page').length
      const proposed = resolutions.filter((r) => r.tier === 'proposed').length
      const needsInput = resolutions.filter((r) => r.tier === 'needs_input').length
```

(The `setOutcome` done branch already consumes these four names — no further change. Note `out.resolutions` is still what the earlier lines read; only the two blocks above change.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run extension/src/panel && npm run typecheck && npm run lint`
Expected: ALL panel suites green — the new describe, the migrated App tests, ScanStatus (shape unchanged), FieldRow (hint contract already shipped in plan 2), group/save untouched. `save.test.ts` must stay green UNCHANGED: demotion preserves `resolution.value`, so `engine === final` still drops unedited demoted rows from the save (Plan decision 4).

- [ ] **Step 5: Commit**

`git commit -am "feat(panel): filled = page-accepted fills; failed batch fills demote to needs-input with their reason"`

---

## Task 6: e2e — choice fill end-to-end + batch-failure surfacing on the two-origin fixture

**Files:**
- Modify: `e2e/fixtures/ashby-embed/apply-frame.html` (make the yes/no widget a CONTROLLED Ashby-like widget)
- Modify: `e2e/election.spec.ts` (scripted-host values + new assertions; the A6/A7 assertions stay)

**Interfaces:**
- Consumes: plan 2's two-origin harness and election spec, Tasks 2–5 behavior, `data-jff-tier` row contract, the `done` status copy.
- Produces: real-browser proof that (1) a controlled choice widget is filled through the GATED BUTTON path with an observable state change, (2) a combobox auto-fill with no matching option fails, restores the control, and surfaces on its row, (3) the status line's `filled` is the page-accepted count — TODO 18's "neither count lies" clause, end-to-end.

Design constraints for the integrator:

1. **Fixture** — in `apply-frame.html`'s `<script>`, make the yes/no widget controlled (append after the existing combobox wiring):

```js
    // Ashby-like controlled choice: the hidden checkbox IGNORES direct clicks
    // (preventDefault cancels the checkbox activation behavior); only the
    // buttons drive state. This forces fillChoice through its gated step 2.
    const yn = document.querySelector('input[name="yn-uuid"]')
    yn.addEventListener('click', (e) => e.preventDefault())
    for (const b of document.querySelectorAll('._container_1svni_28 button')) {
      b.addEventListener('click', () => {
        for (const s of b.parentElement.querySelectorAll('button')) {
          s.setAttribute('aria-pressed', String(s === b))
        }
        yn.checked = b.textContent.trim() === 'Yes'
      })
    }
```

The buttons stay UNTYPED and the page still has NO `<form>` — gate (c)'s no-form-ancestor arm is what admits them, exactly the motivating page's shape.

2. **Scripted host** — in `election.spec.ts`'s resolve handler, the tier/value mapping becomes: `text` → auto `'ELECTED-FILL'`; `choice` → auto `'Yes'` (no longer bait — it must LAND via the button path); `combobox` → auto `'Atlantis'` (the new bait: no such option exists, the fill must FAIL and surface). Everything else stays `needs_input`. Update the comment accordingly.

3. **Assertions** — replace the old interim-guard assertion (`isChecked() === false`) with the choice-fill proof, and add the failure-surfacing block. After the existing `#nl-email` / `first-uuid` assertions:

```ts
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

    // The clipped autofill pane is junk (clipped ⇒ visible:false ⇒ unlabelled,
    // zero-scoring file input dropped by keepField): it renders no row and it
    // never receives a file — the upload-target trap, proven page-side.
    await expect(panel.locator('[data-jff-rows] li', { hasText: '(unlabelled field)' })).toHaveCount(0)
    expect(await appFrame.locator('input.visually-hidden[type="file"]')
      .evaluate((n) => (n as HTMLInputElement).files?.length ?? 0)).toBe(0)
```

The existing listbox-residue assertions (`[role="listbox"]` count 0, combobox value `''`) now ALSO prove B2's close-and-restore on the failed fill — keep them exactly where they are, AFTER the status-line wait so the fill has settled. If the counts in the status-line assertion drift because the fixture's field census changes, recount from the fixture — do NOT loosen to a regex. The census: SIX kept elected fields — first, last, choice, combobox, resume file, essay. The autofill-pane input is not among them (clipping makes it `visible:false`, and an unlabelled file input with no A8 score is junk-filtered), so `3 filled` (first, last, choice) + `3 need input` (combobox demoted after its failed fill, resume file, essay) accounts for all six.

4. **Pasted-job-text block**: the second scan re-runs the same fills. Its assertions are count-based (`resolveCalls.length`) and unaffected; verify the status line settles again before the final `consoleErrors` check.

5. **Do not touch** `foundation.spec.ts`, `panel-port.spec.ts`. `full-loop.spec.ts` (greenhouse fixture) has no choice widgets and its auto-fills all succeed, so its counts are unchanged — if it fails, the regression is real; fix the code.

- [ ] **Step 1: Edit the fixture** per constraint 1.
- [ ] **Step 2: Edit `election.spec.ts`** per constraints 2–4.
- [ ] **Step 3: Run to verify**

Run: `npm run smoke`
Expected: foundation, full-loop, panel-port and the extended election spec all green, zero console errors. If the choice assertion flakes, the bug is in fillChoice's verification timing — fix the code, never widen the assertion.

- [ ] **Step 4: Commit**

`git commit -am "test(e2e): controlled choice fills via the gated button path; failed combobox fill surfaces and never inflates the filled count"`

---

## Task 7: Slice verification + dist restore + spec TODO ticks

**Files:** none (verification only; fix regressions in place if any surface). Spec file ticks only.

- [ ] **Step 1: Full unit sweep** — Run: `npx vitest run` — all projects green (host + shared + extension).
- [ ] **Step 2: Full verify** — Run: `npm run verify` — typecheck + lint + unit + Playwright green. Known-sensitive assertions that must stay green by construction: `'toggles a checkbox by clicking, only when the state must change'` (plain-checkbox no-op rail), `'never clicks a submit control'` (BUTTON rail), plan 2's election/harvest describes, `save.test.ts` untouched-and-green.
- [ ] **Step 3: Restore the plain dist** — Run: `npm run build`.
- [ ] **Step 4: Tick spec TODOs** in `docs/specs/2026-07-28-scan-fill-correctness-design.md`: all 7 Slice-B items AND Slice-A TODO 18 (its "neither count lies" clause is now proven end-to-end; plan 2 deliberately left it unticked).
- [ ] **Step 5: Commit** — `git commit -am "chore: verify slice B green, tick spec Slice-B TODOs and TODO 18"`

---

## Verification (slice level)

Command set:

```
npx vitest run                 # host + shared + extension unit suites
npm run verify                 # typecheck + lint + unit + e2e (seam build, incl. the extended election.spec.ts)
npm run build                  # restore the plain dist afterward
```

Spec TODOs this slice ticks (quoted from the spec):

Slice A, TODO 18 (completion — plan 2 landed the separation and state shape, this slice lands the count source):
- "The status line separates `filled` (page-accepted fills, per B3 reports) from `already on page` (page-sourced values); neither count lies when a batch fill fails." — Tasks 4/5 (+ Task 6's status-line assertion end-to-end).

Slice B (all 7):
1. "A choice field whose hidden input accepts a real click (observable state change) is filled WITHOUT any button being clicked." — Task 2 (click-accepting checkbox and radio-backed tests, zero button clicks asserted).
2. "When the hidden-input click produces no observable change, `fillChoice` clicks the matching option button only when that button (a) is a descendant of the detected choice container holding the fid-stamped hidden input, (b) does not match the submit vocabulary /^(submit|apply|send|continue|next|enviar|candidatar)/i in its normalized text, and (c) has `type=\"button\"` or no `<form>` ancestor. Bypass criteria: an untyped button inside a `<form>` is never clicked; a submit-worded button is refused even on a page with no `<form>` at all; refusals return `choice-needs-user-click` and the row shows a 'select on the page' hint; `fillOne`'s general button rail behaves exactly as before outside the choice branch." — Tasks 2/5 (hint renders via plan 2's REASON_HINT once the reason arrives; rail pinned by the untouched `'never clicks a submit control'` test).
3. "A choice fill reports success only after an observable state change (hidden-input flip, aria state, or class/attribute delta on the clicked button); with no observable change it reports `fill.failed` with a reason." — Task 2 (`no-state-change` test) + Task 4 (the reason reaches `ScanOutcome.fill.failed`).
4. "Filling 'No' can never silently no-op: choice-kind fields route to `fillChoice` before BOTH the radio and checkbox branches (radio-backed choice fixture proves it); plain-checkbox uncheck of an already-unchecked box still reports ok (correct no-op)." — Task 2 (opaque-values radio fixture distinguishes the routing; the controlled 'No' test and the styled-checkbox no-op test pin both halves).
5. "`fillCombobox` interacts only with a listbox attributable to the target control (aria-owns/aria-controls, or one that appeared in response to our interaction). Bypass criterion: on a two-open-combobox fixture it never selects an option belonging to the other combobox." — Task 3 (TWO_OPEN_COMBOBOX bypass test).
6. "When the target option is not mounted, `fillCombobox` types the value natively to filter, selects only an exact normalized match, and verifies the committed value; no exact match → `fill.failed: no-matching-option` and the control is restored to its pre-fill value (prefix guessing removed)." — Task 3 (+ Task 6's Atlantis bait end-to-end).
7. "Scan-time batch fill consumes the JFF_FILL reports: the 'filled' count reflects page-accepted fills only, and per-row failures render in the panel with their reason." — Tasks 4/5 (+ Task 6 end-to-end).

## Plan decisions (interpretations an executor must not re-litigate)

1. **Step 1 clicks only an input that can NAME the requested option; index alignment is a LAST resort, not a step-1 candidate.** The spec's step 1 says "real `.click()` on the hidden input itself". Applied literally to a radio-backed choice it would always click the fid-stamped FIRST radio — selecting "Yes" when the value is "No", a misfill worse than the no-op the spec kills; and the spec's own radio-backed TODO ("radio-backed choice fixture proves it") is only satisfiable by member matching. So step 1 resolves the value to a specific input first: matching member radio (value attr → optionLabel), or the checkbox when the affirmative/negative vocabulary maps the value AND the click moves toward the desired state. Index alignment (member at the matching option's index) is a guess about the page's markup — parallel arrays — so it is tried ONLY after step 2's gate refuses, where the alternative is refusing the fill outright. An input click that cannot name the option falls through to step 2 — which is also the spec's own fallback for "no observable change".
2. **A checkbox already AT the desired state gets no silent ok.** `fillCheckbox`'s correct-no-op rule is right for plain checkboxes and is preserved for them; for a CHOICE, "unchecked" does not mean "answered No" (the Ashby ground fact), so `checked === want` proceeds to the button step instead of reporting ok. This is the direct reading of TODO "Filling 'No' can never silently no-op".
3. **`CollectedFill` is a panel-internal type, not a schema.** `FillReportSchema` and the `{ok, fill}` reply envelope already exist and already carry `filled`/`failed` per frame (verified in `shared/src/messages.ts` and `content/index.ts`); B3 aggregates them panel-side. The spec's enumerated-changes rule is satisfied with ZERO shared-schema edits.
4. **Failed-fill rows demote IN APP STATE (tier → `needs_input`, reason → fill reason).** This reuses every existing rail instead of adding a parallel one: needs-input styling and the tier badge flip automatically, `REASON_HINT` renders the hint, Generate/Fill give the user the recovery path, and Accept stays structurally impossible. Save semantics are unchanged: demotion preserves `resolution.value`, so `engine === final` still drops unedited rows, and a user-corrected row saves exactly like any needs-input row. The status counts run over the demoted array so they always describe the rows on screen.
5. **The `harvest.ts ⇄ fill.ts` import pair is accepted.** Plan 2 fixed `attributableListbox`'s home in `harvest.ts` and mandated B2 reuse it; `harvest` imports `setNativeValue` from `fill`. Both edges bind hoisted function declarations used at call time only — safe under Vite/Vitest ESM, and no import-cycle lint rule exists here. Moving the function would break plan 2's published interface for zero behavioral gain.
6. **Retro note (deliberately NOT fixed in v1): `no-matching-option` is overloaded.** B2 returns it both when the target option genuinely is not in the list and when the combobox could not be opened/attributed at all — two different user recoveries ("pick another value" vs "open this dropdown yourself") behind one string. A follow-up would add ONE reason, `combobox-not-openable`, for the unattributable/never-mounted case; the panel renders reasons verbatim and `REASON_HINT` is a plain map, so the change is a string plus a hint entry. Kept out of this slice on purpose: it widens the wire vocabulary for a distinction no current test or spec TODO asserts.
7. **`fillCombobox` closes (Escape + blur) on every failure path.** The spec mandates restore-on-failure; leaving the dropdown open after a failed batched fill would strand visible UI residue on the page (and break the election spec's no-residue assertions). The close recipe is harvest's own, applied to the failure paths only — on success the page's option-click handler owns the close, as it does for real users.
8. **The existing div-combobox happy-path test adapts, not loosens.** B2's committed-value verification is a spec requirement; an inert fixture that commits nothing can no longer represent a working combobox. The adapted test wires the commit the way every real widget does. The no-matching-option test is untouched.
9. **No blanket App.test stub migration.** The concern was that once `filled` counts page-accepted fills, a stub answering "accepted nothing" would demote every auto row. Verified against the suite: NO existing App test yields a `tier: 'auto'` resolution, so the scan-time auto-fill loop never runs there and `out.fill` stays empty — there is nothing to migrate. `fillRefused`/`fillReply` (App.test.tsx:449, 854) stay untouched: their `failed[]` payloads are the subject of the per-action refusal tests, which go through `fillOne`, not the batch path. If some test does regress, add the echoing `JFF_FILL` branch to THAT stub only (Task 5 Step 1a).

## Post-slice manual gate (spec's out-of-scope live validation)

After Task 7, reload the unpacked extension (`npm run build`, then chrome://extensions → Reload) and run a real scan on the TRM/Ashby page (`https://www.trmlabs.com/careers?ashby_jid=6edf242b-984d-41fb-8027-5f133a6353d4`).

RE-COUNT the `(unlabelled field)` rows on that live page: spec TODO 1's "17/17 dangling labels recovered" is only unit-proven on distilled fixtures, and the e2e fixture is a distillation too. Zero `(unlabelled field)` rows among the elected frame's real questions is the live confirmation; any that remain are a label-recovery gap to feed into the retro (and a follow-up spec), not a reason to widen a heuristic on the spot.

For each yes/no choice the scan auto-fills, RECORD WHICH fillChoice step fired (step 1 hidden-input click vs step 2 gated button click vs refusal) — observable from the row outcome plus the page state: input checked with no button highlight = step 1; button highlighted = step 2; `choice-needs-user-click` hint = refusal. This is the spec's deferred live validation of the click-behavior design; feed the result into the retro (and into a follow-up spec if the real page refuses both steps).

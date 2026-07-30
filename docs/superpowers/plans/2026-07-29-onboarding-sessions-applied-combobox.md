# Onboarding Gate + Per-Tab Sessions + Applied Jobs + Greenhouse Combobox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four items from the 2026-07-29 user review per the authoritative spec `docs/superpowers/specs/2026-07-29-onboarding-sessions-applied-combobox-design.md` (spec tip `563113b`): (1) a hard onboarding gate before any scanning, (2) per-tab application sessions that survive tab switching and multi-page wizards, (3) an applied-jobs record with revisit badge, detection prompt and list view, and (4) the Greenhouse react-select combobox fill fix proven by the C1 spike.

**Architecture:** Four slices, executed O → A → C → S (spec §Execution, binding). O (Tasks 1–3) composes existing profile blocks behind a tri-state completeness gate. A (Tasks 4–8) adds the host `applied_jobs` table + `applied.*` methods, then panel mark/detect/badge/list; the A slices deliberately land BEFORE sessions exist, carrying a small `startUrl` state that Task 14 folds into the Session shape. C (Tasks 9–10) implements the C1 spike recipe verbatim (pointer+mouse open gesture; committed-text fallback to the widget's visible value) plus a Greenhouse-shaped e2e fixture. S (Tasks 11–16) retires the clear-on-activate era in one test batch, builds the sessions + navigation-signal modules pure-first, then rewires App.tsx in three integrator slices ordered by risk surface: session lifecycle (S2/S5/S6), label-keyed answer carry (S4), concurrency + routing (S7). Task 17 is the e2e batch (all e2e adaptation to the onboarding/session era happens HERE, in one batch); Tasks 18–19 are the verify gate and the live manual gate on <https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002>.

**Tech Stack:** TypeScript workspaces (shared/host/extension), zod, vitest (baseline 626 tests / 43 files), Playwright e2e (baseline 13/13), React 18 MV3 side panel (vite 7 + @crxjs), better-sqlite3 host, `chrome.storage.session`, `chrome.webNavigation` (permission already granted — `extension/manifest.config.ts:22`).

## Worker preamble (read before every task)

- **Verify plan snippets against the tree before applying them.** Every line number and quoted snippet was checked against `main` at plan-authoring time (2026-07-29, spec tip `563113b`), but earlier tasks in this plan shift lines. Match on CONTENT (the quoted code), never on line number alone. If a quoted snippet does not exist in the file, STOP and report the mismatch — do not improvise around it.
- **Plan-authored tests are guilty until run — FIX AND REPORT, never weaken.** If a plan-authored test fails for a reason that looks like a plan defect (wrong selector, wrong fixture shape, a harness detail the plan got wrong), fix the TEST to express the plan's stated intent and report the deviation in your completion message. Never weaken an assertion to get green.
- **Blocked returns are successes.** If anything in your task is ambiguous FOR YOUR RUNG, stop and return `blocked: <the specific ambiguity>`.
- `@jff/shared` resolves to `shared/dist/index.js` at test time. After ANY edit under `shared/src`, run `npm run build -w @jff/shared` before running host/extension tests, or they exercise the stale build.
- Run tests from the repo root: `npx vitest run <path>` (the root config fans out to the host/extension projects).
- **Do NOT run the full Playwright suite in Tasks 3–16.** Task 3 makes the panel gate on onboarding, and the e2e specs that mount the panel against an empty host DB go red by design until Task 17 adapts them in one batch (standing rule: stale tests are a batch, not serial surprises). Within that range, per-task Verify commands are unit + typecheck + lint only — with ONE exception: Task 10 runs ONLY its scoped `npx playwright test e2e/foundation.spec.ts -g 'react-select'` filter (the rest of foundation.spec.ts's panel-mount tests are knowingly red until Task 17 seeds the onboarded persona). Task 17 then runs the full Playwright suite.

## Global Constraints

- TypeScript: never `any`. Typed test fakes included.
- **NEVER merge or push to main without explicit per-action user permission** (hook-enforced). Plain local commits on `main` are what this plan's commit steps do — that is allowed; landing/pushing is not.
- `npm run verify` and `npm run smoke` leave a SEAM dist behind; the final verify task must `npm run build` and prove `grep -rl 'JFF_TEST_SEAM' extension/dist | wc -l` == 0 (plain dist restored).
- `npm run verify` only on an IDLE machine. Known caveat: `e2e/foundation.spec.ts:128`/`:149` fail order-dependently (harness epoch-poisoning, see flake memory) — re-run the file ISOLATED before judging any failure there. Kill a stuck `legacyScreenSaver` first: `pkill -f legacyScreenSaver`.
- The general BUTTON rail in `extension/src/content/fill.ts` (`fillOne`'s hard rail: `if (el.tagName === 'BUTTON' || …) return { ok: false, reason: 'unsupported-widget' }`) stays **byte-identical**. Never auto-submit.
- Session-7 combobox invariants (B1a–B1d) are regression surface: the typeahead is always driven, unique-substring matching stays min-3-chars + two-poll-settled, committed-text verification stays exact normalized equality against the CLICKED option. Every existing fill.test.ts combobox test stays green through Task 9.
- Spec checkboxes (in the spec file) are ticked in Task 18/19; plan checkboxes are execution-tracking only.
- Measured baseline, re-confirmed by Task 0 at execution start (`edd492d`, 2026-07-30): unit **626 tests / 43 files**, e2e **13/13**, all green. No numeric perf budgets are set by this plan. (Plan authoring recorded 618/43; `563113b..edd492d` is docs-only, so 618 was a mis-transcription, not a regression — 626 is the authoritative baseline.)
- Reviews are NOT tasks: the fresh-context Opus plan review + codex cross-vendor review run BEFORE Task 1; the consolidated branch review runs after Task 18 — **at effort xhigh for the S-slice surface** (see closing section).
- New user-facing copy is fixed by this plan verbatim (onboarding copy, badge/prompt/button labels, empty states). Do not rewrite it at implementation time.

## Task → Model + effort routing (proposal — the orchestrator re-judges at dispatch)

| Task | What | Rung | Effort | Rationale |
|---|---|---|---|---|
| 0 | Baseline verify (full suite incl. e2e) | verifier-opus-low | low | Gate; raw evidence only |
| 1 | O1 `profileCompleteness` tri-state module | editor-opus-low | low | Complete code shipped |
| 2 | O2 `FactFields` extraction + `OnboardingView` | implementer-opus-medium | medium | Single-component feature; copy plan-fixed |
| 3 | O3 gate wiring in App + onboarded default persona sweep | implementer-opus-medium | medium | Fully specified incl. the harness sweep; escalate if the effect timing tests fight |
| 4 | A1 host `applied_jobs` + `canonicalUrl` + `applied.*` plumbing | implementer-opus-medium | medium | Multi-file but mechanical; full code shipped |
| 5 | A2 Mark applied + start-url capture | implementer-opus-medium | medium | App wiring, fully specified |
| 6 | A3 submission detection + prompt (`JFF_PAGETEXT`) | implementer-opus-medium | medium | New detector is pure; App wiring specified |
| 7 | A4 revisit badge + precedence | implementer-opus-medium | medium | Small App wiring |
| 8 | A5 three-view navigation + ApplicationsView | implementer-opus-medium | medium | Component + toggle; copy plan-fixed |
| 9 | C2 Greenhouse open gesture + committed-text fallback | implementer-opus-medium | medium | Spike recipe transcribed to exact code; Ashby arm regression-gated |
| 10 | C3 Greenhouse e2e fixture + regression spec | integrator-opus-high | high | Browser-timing judgment (session-6/7 precedent routes e2e to Opus) |
| 11 | S8 clear-on-activate era test retirement (ONE batch) | editor-opus-low | low | Pure deletion by enumerated list |
| 12 | S1/S5/S6 `sessions` + `sessionKey` + `site` modules; `normalizeQuestion` → shared | implementer-opus-medium | medium | Pure modules; the lock/mutate contract is fully test-pinned — escalate to integrator-opus-high on the FIRST honest failure |
| 13 | S3 `navSignals` module | implementer-opus-medium | medium | Pure module, full code shipped |
| 14 | S2/S5/S6 App session lifecycle integration | integrator-opus-high | high | Multi-file App.tsx state-machine rewrite; design judgment |
| 15 | S4 label-keyed answer carry + re-projection | integrator-opus-high | high | Silent-wrong-data surface #1 (merge keying) |
| 16 | S7 single-flight + per-session epochs + push routing | integrator-opus-high | high | Silent-wrong-data surfaces #2/#3; **escalate to debugger-opus-xhigh on the FIRST honest failure** |
| 17 | E2E batch: era adaptation + sessions/onboarding/wizard flows | integrator-opus-high | high | Cross-spec browser judgment; one batch by standing rule |
| 18 | Full verify + plain dist + A6 seed + spec ticks | orchestrator + verifier-opus-low | — | Gate, not implementation |
| 19 | Manual browser gate on the real Greenhouse page | orchestrator (+ agent-driven browser) + USER | — | DOM-behavior truth |

## Spec TODO → Task map (every unticked spec TODO is covered)

| Spec TODO | Task(s) |
|---|---|
| O1 tri-state completeness | 1 |
| O2 OnboardingView | 2 |
| O3 gate wiring | 3 |
| S1 sessions module | 12 (module), 14 (wired) |
| S2 tab switch swap, no scan on activation | 14 |
| S3 webNavigation signals | 13 (module), 14 (wired) |
| S4 label-keyed carry + re-projection | 15 |
| S5 cross-site parking + domain return | 12 (classifier), 14 (wired) |
| S6 rehydrate, prune, caps, quota | 12 (store), 14 (wired) |
| S7 concurrency | 16 |
| S8 test-era retirement | 11 |
| A1 host table + canonicalUrl + methods | 4 |
| A2 Mark applied button | 5 |
| A3 detection prompt | 6 |
| A4 revisit badge | 7 |
| A5 applications list + 3-view nav | 8 |
| A6 seed TRM/Ashby job | 18 |
| C2 fill.ts fix | 9 |
| C3 e2e fixture | 10 |
| Cross-cutting E2E | 17 |
| Manual browser gate | 19 |

---

### Task 0: Baseline verify (BEFORE any change)

**Model:** verifier-opus-low (dispatched by the orchestrator).

Standing rule: the baseline runs the plan's FULL verification suite — including every e2e spec — before Task 1. Stale-test findings become one batch fix before Task 1, not mid-execution surprises.

- [x] **Step 1:** `git status` — clean tree on `main`, tip is the spec commit or later.
- [x] **Step 2:** `npx vitest run` — expect **626 tests / 43 files**, all green. Record the exact numbers.
- [x] **Step 3:** `npm run verify` on an IDLE machine (`pkill -f legacyScreenSaver` first). Expect all components green; e2e **13/13**. If `foundation.spec.ts:128/:149` fail, re-run that file isolated before judging.
- [x] **Step 4:** `npm run build && grep -rl 'JFF_TEST_SEAM' extension/dist | wc -l` — restore the plain dist (verify leaves a seam dist), expect `0`.
- [x] **Step 5:** Report raw evidence. Any red is a batch fix BEFORE Task 1 (orchestrator decision), never a mid-plan interruption.

---

### Task 1: O1 — `profileCompleteness` tri-state module

**Files:**
- Create: `extension/src/panel/completeness.ts`
- Create: `extension/src/panel/completeness.test.ts`

**Interfaces:**
- Produces: `profileCompleteness(facts: Record<string, string>, hasResume: boolean, settled: boolean): 'complete' | 'incomplete' | 'unknown'`, `type Completeness`, `REQUIRED_FACTS` (the one exported, extensible required-key const).
- Consumed by: Task 2 (OnboardingView Finish gating), Task 3 (App gate decision).

**Model:** editor-opus-low — the complete code is below; zero decisions left.

**Verify:** `npx vitest run extension/src/panel/completeness.test.ts && npm run typecheck`

- [ ] **Step 1: Write the failing test** — create `extension/src/panel/completeness.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { profileCompleteness, REQUIRED_FACTS } from './completeness'

const FULL = { email: 'k@x.dev', phone: '+55 11 90000-0000', fullName: 'Kevin B' }

describe('profileCompleteness (O1)', () => {
  it('complete: resume + email + phone + fullName', () => {
    expect(profileCompleteness(FULL, true, true)).toBe('complete')
  })

  it('complete: firstName+lastName satisfies the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Kevin', lastName: 'B' }, true, true,
    )).toBe('complete')
  })

  it('incomplete: firstName WITHOUT lastName does not satisfy the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Kevin' }, true, true,
    )).toBe('incomplete')
  })

  it('incomplete: missing resume, even with every fact present', () => {
    expect(profileCompleteness(FULL, false, true)).toBe('incomplete')
  })

  it.each(['email', 'phone'] as const)('incomplete: missing %s', (k) => {
    expect(profileCompleteness({ ...FULL, [k]: '' }, true, true)).toBe('incomplete')
  })

  it('whitespace-only values do not count', () => {
    expect(profileCompleteness({ ...FULL, email: '   ' }, true, true)).toBe('incomplete')
  })

  it('unknown: an unsettled load can NEVER prove incompleteness', () => {
    expect(profileCompleteness({}, false, false)).toBe('unknown')
  })

  it('unknown outranks a fully-present facts record too (settled is the gate)', () => {
    expect(profileCompleteness(FULL, true, false)).toBe('unknown')
  })

  it('the required list is the one extensible const', () => {
    expect(REQUIRED_FACTS.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run extension/src/panel/completeness.test.ts` — FAILS (module does not exist).

- [ ] **Step 3: Create `extension/src/panel/completeness.ts`:**

```ts
import type { FieldKey } from '@jff/shared'

/**
 * O1: what onboarding demands before scanning unlocks. Outer level = AND (every
 * group must be satisfied); a group = OR of alternatives; an alternative = AND
 * of keys. "salary is now required too" is one added line: `[['salary']]`.
 */
export const REQUIRED_FACTS: ReadonlyArray<ReadonlyArray<ReadonlyArray<FieldKey>>> = [
  [['email']],
  [['phone']],
  [['fullName'], ['firstName', 'lastName']],
]

export type Completeness = 'complete' | 'incomplete' | 'unknown'

const has = (facts: Record<string, string>, key: FieldKey): boolean => (facts[key] ?? '').trim() !== ''

/**
 * O1: tri-state on purpose — facts arrive over the native port, which can die
 * or time out, and an existing user with a complete profile must NEVER be
 * walled into onboarding by a dead host (they would have no working Finish
 * either). `incomplete` requires a SETTLED, SUCCESSFUL load proving it; a load
 * failure or timeout is `unknown`, and the caller falls back to the normal
 * panel plus the host-error banner.
 */
export function profileCompleteness(
  facts: Record<string, string>,
  hasResume: boolean,
  settled: boolean,
): Completeness {
  if (!settled) return 'unknown'
  if (!hasResume) return 'incomplete'
  const groupOk = (group: ReadonlyArray<ReadonlyArray<FieldKey>>): boolean =>
    group.some((alt) => alt.every((k) => has(facts, k)))
  return REQUIRED_FACTS.every(groupOk) ? 'complete' : 'incomplete'
}
```

- [ ] **Step 4: Run to see it pass** — `npx vitest run extension/src/panel/completeness.test.ts && npm run typecheck` — PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/completeness.ts extension/src/panel/completeness.test.ts
git commit -m "feat(onboarding): profileCompleteness tri-state with extensible required-facts const (O1)"
```

---

### Task 2: O2 — shared `FactFields` + `OnboardingView`

**Files:**
- Modify: `extension/src/panel/ProfileEditor.tsx` (extract `FACT_LABELS` + `FactFields`; ProfileEditor renders through them — no behavior change)
- Create: `extension/src/panel/OnboardingView.tsx`
- Create: `extension/src/panel/OnboardingView.test.tsx`

**Interfaces:**
- Consumes: `profileCompleteness`, `REQUIRED_FACTS` (Task 1); `PROFILE_KEYS`, `ANSWER_BANK_KEYS` from `@jff/shared`.
- Produces:
  - `FactFields({ draft, onChange, required?, idPrefix? })` exported from `ProfileEditor.tsx` — the ONE fact-grid renderer both views share (spec: "the field rendering is shared, not duplicated"). `required: ReadonlySet<string> | null` renders the `*` marker; `idPrefix` keeps input ids unique across views (ProfileEditor keeps `'p'`).
  - `OnboardingView({ values, loaded, resumeName, onUpload, onExtract, onFinish })` with:
    - `onUpload: (file: File) => Promise<string | null>` — App-side `saveResume` + text reload; resolves the extracted CV text (null = non-PDF or failed extraction).
    - `onExtract: (cvText: string) => Promise<Record<string, string> | null>` — `facts.extract` round-trip; null on host failure (App surfaced the banner).
    - `onFinish: (profile: Record<string, string>, bank: Record<string, string>) => Promise<void>`.
- Consumed by: Task 3 (App renders it when `incomplete`).

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/panel/OnboardingView.test.tsx extension/src/panel/ProfileEditor.test.tsx && npm run typecheck && npm run lint`

**Boundaries:** No App.tsx changes (Task 3). ProfileEditor's observable behavior (labels, ids `p-<key>`, empty-only extract merge, collect-omits-unloaded-keys) is regression surface: `ProfileEditor.test.tsx` must pass UNCHANGED.

- [ ] **Step 1: Write the failing tests** — create `extension/src/panel/OnboardingView.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OnboardingView } from './OnboardingView'

type Props = Parameters<typeof OnboardingView>[0]

function mount(over: Partial<Props> = {}): Props {
  const props: Props = {
    values: {},
    loaded: true,
    resumeName: null,
    onUpload: vi.fn(async () => null),
    onExtract: vi.fn(async () => null),
    onFinish: vi.fn(async () => undefined),
    ...over,
  }
  render(<OnboardingView {...props} />)
  return props
}

const fileInput = (): HTMLInputElement => document.querySelector('input[type="file"]') as HTMLInputElement
const finishBtn = (): HTMLButtonElement => screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement

describe('OnboardingView (O2)', () => {
  it('Finish stays disabled until resume + core facts are present', async () => {
    mount({ resumeName: 'cv.pdf' })
    expect(finishBtn().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    await waitFor(() => expect(finishBtn().disabled).toBe(false))
  })

  it('without a resume, Finish stays disabled even with every fact typed', () => {
    mount({ resumeName: null })
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    expect(finishBtn().disabled).toBe(true)
  })

  it('a PDF upload auto-extracts and pre-fills EMPTY fields only', async () => {
    const props = mount({
      resumeName: null,
      onUpload: vi.fn(async () => 'CV TEXT'),
      onExtract: vi.fn(async () => ({ email: 'cv@x.dev', phone: '123' })),
    })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '999' } })
    fireEvent.change(fileInput(), { target: { files: [new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(props.onExtract).toHaveBeenCalledWith('CV TEXT'))
    await waitFor(() => expect((screen.getByLabelText(/^Email/) as HTMLInputElement).value).toBe('cv@x.dev'))
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).value).toBe('999')
  })

  it('a non-PDF upload stores the blob but never calls extract', async () => {
    const props = mount({ onUpload: vi.fn(async () => null) })
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'cv.docx')] } })
    await waitFor(() => expect(props.onUpload).toHaveBeenCalled())
    expect(props.onExtract).not.toHaveBeenCalled()
  })

  it('Finish splits profile and answer-bank keys', async () => {
    const props = mount({ resumeName: 'cv.pdf' })
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    fireEvent.change(screen.getByLabelText(/^Salary expectation/), { target: { value: '100k' } })
    await waitFor(() => expect(finishBtn().disabled).toBe(false))
    fireEvent.click(finishBtn())
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'k@x.dev', phone: '1', fullName: 'Kevin B' }),
      expect.objectContaining({ salary: '100k' }),
    ))
  })

  it('required keys wear the marker; optional keys do not', () => {
    mount({})
    const labelFor = (id: string): string =>
      document.querySelector(`label[for="ob-${id}"]`)?.textContent ?? ''
    for (const k of ['email', 'phone', 'fullName', 'firstName', 'lastName']) {
      expect(labelFor(k)).toContain('*')
    }
    expect(labelFor('salary')).not.toContain('*')
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run extension/src/panel/OnboardingView.test.tsx` — FAILS (no module).

- [ ] **Step 3: Refactor `ProfileEditor.tsx`** — rename the private `LABELS` const to `FACT_LABELS` (same content, STILL module-private — only `FactFields` is exported; no other module needs the label map), and extract the field-rendering `.map` (currently lines 74–79) into:

```tsx
/** O2: the one fact-grid renderer OnboardingView and ProfileEditor share.
 *  `required` renders the * marker; `idPrefix` keeps ids unique across views. */
export function FactFields({ draft, onChange, required = null, idPrefix = 'p' }: {
  draft: Record<string, string>
  onChange: (key: string, value: string) => void
  required?: ReadonlySet<string> | null
  idPrefix?: string
}) {
  return (
    <>
      {[...PROFILE_KEYS, ...ANSWER_BANK_KEYS].map((k) => (
        <div className="mb-2 grid gap-0.5" key={k}>
          <label className={`text-[12px] ${MUTED}`} htmlFor={`${idPrefix}-${k}`}>
            {FACT_LABELS[k] ?? k}
            {required?.has(k) === true && <span aria-hidden="true"> *</span>}
          </label>
          <input id={`${idPrefix}-${k}`} className={INPUT} value={draft[k] ?? ''} onChange={(e) => onChange(k, e.target.value)} />
        </div>
      ))}
    </>
  )
}
```

ProfileEditor's body replaces its inline `.map` with `<FactFields draft={draft} onChange={set} />`. Nothing else in ProfileEditor changes.

- [ ] **Step 4: Create `extension/src/panel/OnboardingView.tsx`:**

```tsx
import { useState, type ChangeEvent } from 'react'
import { ANSWER_BANK_KEYS, PROFILE_KEYS } from '@jff/shared'
import { profileCompleteness, REQUIRED_FACTS } from './completeness'
import { FactFields } from './ProfileEditor'
import { BTN_PRIMARY, MUTED } from './ui'

/** Every key any REQUIRED_FACTS alternative mentions gets the * marker. */
const REQUIRED_MARKED: ReadonlySet<string> = new Set(REQUIRED_FACTS.flat(2))

/**
 * O2: the hard gate's front door. Upload CV → auto-extract pre-fills EMPTY
 * fields (non-PDF stores the blob, user types) → review all 18 keys with the
 * core ones marked → Finish persists and unlocks scanning. ProfileEditor stays
 * the post-onboarding edit path; the rendering is shared via FactFields.
 */
export function OnboardingView({ values, loaded, resumeName, onUpload, onExtract, onFinish }: {
  values: Record<string, string>
  loaded: boolean
  resumeName: string | null
  onUpload: (file: File) => Promise<string | null>
  onExtract: (cvText: string) => Promise<Record<string, string> | null>
  onFinish: (profile: Record<string, string>, bank: Record<string, string>) => Promise<void>
}) {
  const [draft, setDraft] = useState<Record<string, string>>(values)
  const [busy, setBusy] = useState<'upload' | 'finish' | null>(null)
  const complete = profileCompleteness(draft, resumeName !== null, loaded) === 'complete'

  const set = (k: string, v: string): void => setDraft((d) => ({ ...d, [k]: v }))

  const pick = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined || busy !== null) return
    setBusy('upload')
    try {
      const cvText = await onUpload(file)
      // O2: a non-PDF stores the blob but skips auto-extract — the user types.
      if (cvText === null) return
      const facts = await onExtract(cvText)
      if (facts === null) return
      // Pre-fill EMPTY fields only; typed values always win (same rule as
      // ProfileEditor's "Generate from CV", spec D5).
      setDraft((d) => {
        const next = { ...d }
        for (const [k, v] of Object.entries(facts)) {
          if ((next[k] ?? '').trim() === '') next[k] = v
        }
        return next
      })
    } finally {
      setBusy(null)
    }
  }

  const collect = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = draft[k] ?? ''
      // Same rule as ProfileEditor: a key never loaded is omitted, so finishing
      // a partially-loaded editor can never wipe a stored fact.
      if (v !== '' || k in values) out[k] = v
    }
    return out
  }

  const finish = async (): Promise<void> => {
    if (!complete || busy !== null) return
    setBusy('finish')
    try { await onFinish(collect(PROFILE_KEYS), collect(ANSWER_BANK_KEYS)) } finally { setBusy(null) }
  }

  return (
    <section className="mt-3" data-jff-onboarding="1">
      <h2 className="mb-0.5 text-[13px] font-semibold">Welcome — set up your profile</h2>
      <p className={`mb-2.5 ${MUTED}`}>
        Scanning stays locked until the basics every application needs are stored: your resume, name, email and phone.
      </p>
      <label className={`my-2 block ${MUTED}`} data-jff-ob-resume="1">
        Resume {resumeName === null ? '(none stored) *' : `(${resumeName})`}
        <input
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf"
          onChange={(e) => { void pick(e) }}
          className="mt-1 block w-full text-[12px] file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-[12px] file:text-inherit dark:file:border-neutral-600"
        />
      </label>
      {busy === 'upload' && <p className={MUTED}>Reading your CV…</p>}
      <FactFields draft={draft} onChange={set} required={REQUIRED_MARKED} idPrefix="ob" />
      <p className={`mb-1.5 text-[12px] ${MUTED}`}>* required to finish setup</p>
      <button
        type="button" className={BTN_PRIMARY} data-jff-ob-finish="1"
        disabled={!complete || busy !== null || !loaded}
        onClick={() => { void finish() }}
      >
        {busy === 'finish' ? 'Saving…' : 'Finish setup'}
      </button>
      {!complete && <p className={`mt-1.5 text-[12px] ${MUTED}`}>Add a resume, your name, email and phone to finish.</p>}
    </section>
  )
}
```

- [ ] **Step 5: Run to see it pass** — `npx vitest run extension/src/panel/OnboardingView.test.tsx extension/src/panel/ProfileEditor.test.tsx && npm run typecheck && npm run lint` — PASS / clean. ProfileEditor tests must pass WITHOUT edits.

- [ ] **Step 6: Commit**

```bash
git add extension/src/panel/OnboardingView.tsx extension/src/panel/OnboardingView.test.tsx extension/src/panel/ProfileEditor.tsx
git commit -m "feat(onboarding): OnboardingView over shared FactFields; CV upload auto-extract prefill (O2)"
```

---

### Task 3: O3 — gate wiring in App + the onboarded default persona

**Files:**
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/port.ts` (canned fake persona)
- Modify: `extension/src/panel/App.test.tsx` (harness: onboarded persona + new gate tests)

**Interfaces:**
- Consumes: `profileCompleteness`/`Completeness` (Task 1), `OnboardingView` (Task 2), existing `saveResume`/`loadResumeText`, `facts.extract`, `profile.set`/`answerBank.set`.
- Produces: App renders `OnboardingView` INSTEAD of the scan UI when the completeness decision is `incomplete`; the auto-scan effect additionally requires a settled decision. `unknown` = normal panel + host banner, scan proceeds.
- Consumed by: Task 7 (precedence: onboarding gate > host gate > applied badge > scan), Task 17 (e2e gate flow).

**Model:** implementer-opus-medium (escalate to integrator-opus-high only if the effect-ordering tests fight after a FIX-AND-REPORT attempt).

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

**Boundaries:** Do not touch `onScan`'s internals (only its trigger effect). Do not run Playwright (Task 17 owns e2e adaptation). `showEditor` stays as-is (Task 8 generalizes it).

- [ ] **Step 1: Update the canned fake persona in `port.ts`.** In `createFakeHostPort` the canned map has `'profile.get': {},`. Replace with:

```ts
        // O3: the canned persona is ONBOARDED — a complete profile — so the
        // seam-built panel (e2e foundation, dev clicking around) lands on the
        // normal flow, not the onboarding gate. Gate tests install their own
        // __jffHostBridge with an empty profile.
        'profile.get': { email: 'fake@example.com', phone: '+1 555 0100', fullName: 'Fake User' },
```

- [ ] **Step 2: Make the App.test harness persona onboarded.**
  - At module scope (near `SELF_CHECK`) add:

```ts
/** O3: the default test persona is ONBOARDED. Gate tests opt out explicitly. */
const ONBOARDED = { email: 'fake@example.com', phone: '+1 555 0100', fullName: 'Fake User' }
```

  - Change `installHostBridge` (line ~11) to answer `profile.get` with it:

```ts
function installHostBridge(answer: (method: string) => Promise<unknown>): void {
  window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> =>
    ({ requestId, ok: true, result: method === 'profile.get' ? ONBOARDED : await answer(method) })
}
```

  - Make the global `beforeEach` async and append at its end (App.test already imports `saveResume`/`clearResume`):

```ts
  // O3: a stored resume is half of the completeness gate; the default persona
  // has one. Gate tests call clearResume() explicitly.
  await saveResume(new File(['stub resume'], 'cv.txt', { type: 'text/plain' }))
```

  and add `await clearResume()` in the `afterEach`.
  - **Mechanical sweep:** `grep -n '__jffHostBridge = async' extension/src/panel/App.test.tsx` — for EVERY inline bridge found EXCEPT the one inside `installHostBridge` (already rewritten above — do not edit it twice), insert as the FIRST statement of its body:

```ts
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
```

  (every inline bridge destructures at least `requestId` and `method`). If a specific test's bridge already answers `profile.get` deliberately (none known at plan time), leave it and report.

- [ ] **Step 3: Write the failing gate tests** — append to `App.test.tsx`:

```tsx
describe('App — onboarding gate (O1/O3)', () => {
  const scanCount = (): number => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    return send.mock.calls.filter((c) => (c[0] as { message?: { type?: string } })?.message?.type === 'JFF_SCAN').length
  }
  const emptyProfileBridge = (): void => {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      return { requestId, ok: true, result: {} }
    }
  }

  it('a fresh install renders OnboardingView and fires NO scan', async () => {
    await clearResume()
    emptyProfileBridge()
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    expect(document.querySelector('[data-jff-onboarding]')).not.toBeNull()
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    expect(scanCount()).toBe(0)
  })

  it('a dead host is unknown: normal panel + banner, never the onboarding wall', async () => {
    await clearResume()
    window.__jffHostBridge = async ({ requestId }): Promise<HostResponse> =>
      ({ requestId, ok: false, error: { kind: 'unreachable', message: 'down' } })
    render(<App />)
    await waitFor(() => expect(scanCount()).toBeGreaterThan(0), { timeout: 5000 })
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('an onboarded profile never sees the gate', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('an open host gate cannot race a scan past an unsettled completeness decision', async () => {
    // profile.get never resolves: the decision stays pending, and no scan may
    // fire even though selfCheck answered (gateOpen latched true).
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.get' || method === 'answerBank.get') return new Promise<HostResponse>(() => {})
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('connecting'))
    await new Promise((r) => setTimeout(r, 150))
    expect(scanCount()).toBe(0)
  })

  it('a never-settling facts load times out to unknown and scans anyway', async () => {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.get' || method === 'answerBank.get') return new Promise<HostResponse>(() => {})
      return { requestId, ok: true, result: {} }
    }
    render(<App hostWaitMs={60} />)
    await waitFor(() => expect(scanCount()).toBeGreaterThan(0), { timeout: 5000 })
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('Finish persists the facts and unlocks exactly one scan', async () => {
    await clearResume()
    const calls: string[] = []
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      calls.push(method)
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    fireEvent.change(document.querySelector('[data-jff-ob-resume] input[type="file"]')!,
      { target: { files: [new File(['cv'], 'cv.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/cv\.txt/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    const finish = screen.getByRole('button', { name: 'Finish setup' })
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(finish)
    await waitFor(() => expect(calls).toContain('profile.set'))
    await waitFor(() => expect(document.querySelector('[data-jff-onboarding]')).toBeNull())
    await waitFor(() => expect(scanCount()).toBe(1))
  })

  it('a failed profile.set keeps the gate closed — nothing unlocks on a lie', async () => {
    await clearResume()
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.set') return { requestId, ok: false, error: { kind: 'db', message: 'disk full' } }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    fireEvent.change(document.querySelector('[data-jff-ob-resume] input[type="file"]')!,
      { target: { files: [new File(['cv'], 'cv.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/cv\.txt/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    const finish = screen.getByRole('button', { name: 'Finish setup' })
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(finish)
    // The failure surfaced; the gate stays; no scan ever fires.
    await new Promise((r) => setTimeout(r, 100))
    expect(document.querySelector('[data-jff-onboarding]')).not.toBeNull()
    expect(scanCount()).toBe(0)
  })
})
```

- [ ] **Step 4: Run to see the new tests fail** — `npx vitest run extension/src/panel/App.test.tsx -t 'onboarding gate'` — the fresh-install, race, timeout and Finish tests FAIL (no gate exists yet).

- [ ] **Step 5: Implement the gate in `App.tsx`.**
  - Imports: add `OnboardingView` and `import { profileCompleteness, type Completeness } from './completeness'`.
  - New state (below `gateOpen`):

```ts
  const [factsOk, setFactsOk] = useState<boolean | null>(null)     // null = load pending
  const [resumeOk, setResumeOk] = useState<boolean | null>(null)
  const [completeness, setCompleteness] = useState<'pending' | Completeness>('pending')
```

  - Facts effect (currently sets `setFactsLoaded(true)`): additionally record success:

```ts
      setFacts({ ...(p.ok ? p.result : {}), ...(b.ok ? b.result : {}) })
      setFactsLoaded(true)
      setFactsOk(p.ok && b.ok)
```

  - Resume effect (currently two bare `void load…then` lines) becomes settled-aware:

```ts
  useEffect(() => {
    void Promise.all([loadResume(), loadResumeText()])
      .then(([r, text]) => { setResumeName(r?.name ?? null); setCvText(text); setResumeOk(true) })
      .catch(() => { setResumeName(null); setCvText(null); setResumeOk(false) })
  }, [])
```

  - Deciding effects (place after the `gateOpen` effect). The deadline is anchored ONCE at mount — an effect keyed on the settle states would RESTART the clock on every partial settle (facts landing at t=9s with a hanging resume load would stretch the wait to 19s):

```ts
  // O3 deadline, anchored ONCE at mount: a port that never answers must not
  // pin a fresh panel on 'pending' forever, and a PARTIAL settle must not
  // restart the clock. Past the deadline an unsettled decision becomes
  // 'unknown' (normal panel + banner) — the gate can ONLY ever be shown by a
  // successful load proving incompleteness.
  useEffect(() => {
    const timer = setTimeout(() => setCompleteness((c) => (c === 'pending' ? 'unknown' : c)), hostWaitMs)
    return () => clearTimeout(timer)
  }, [])

  // O3: the completeness decision LATCHES on its first settled verdict — a
  // facts load limping in after the deadline must not flip a working panel
  // into (or out of) onboarding mid-session. Only Finish moves it afterwards.
  useEffect(() => {
    if (completeness !== 'pending') return
    if (factsOk !== null && resumeOk !== null) {
      setCompleteness(profileCompleteness(facts, resumeName !== null, factsOk && resumeOk))
    }
  }, [factsOk, resumeOk, completeness])
```

  - Auto-scan effect (currently `if (!gateOpen) { setScanStatus({ kind: 'connecting' }); return } void onScan()` keyed `[tabId, scanNonce, gateOpen]`) becomes:

```ts
  useEffect(() => {
    if (tabId === null) return
    if (!gateOpen || completeness === 'pending') { setScanStatus({ kind: 'connecting' }); return }
    // O3: a profile PROVEN incomplete renders OnboardingView instead of scan UI
    // — no scan may fire. 'unknown' scans anyway: a dead host must never brick
    // an existing user (they see the normal panel plus the host banner).
    if (completeness === 'incomplete') return
    void onScan()
  }, [tabId, scanNonce, gateOpen, completeness])
```

  - Handlers (place near `onSaveFacts`):

```ts
  const onOnboardingUpload = async (file: File): Promise<string | null> => {
    await saveResume(file)
    const text = await loadResumeText()
    setCvText(text)
    setResumeName(file.name)
    return text
  }

  const onOnboardingExtract = async (cv: string): Promise<Record<string, string> | null> => {
    const port = portRef.current
    if (port === null) return null
    const r = await port.request<Record<string, string>>('facts.extract', { cvText: cv })
    if (!r.ok) { setHostError(ERROR_COPY[r.error.kind]); return null }
    return r.result
  }

  const onOnboardingFinish = async (profile: Record<string, string>, bank: Record<string, string>): Promise<void> => {
    const port = portRef.current
    if (port === null) return
    // A failed write must NOT unlock scanning: nothing was persisted, and a
    // 'complete' verdict here would be a lie the next panel open disproves.
    // Surface the banner and stay in onboarding — Finish is retryable.
    const p = await port.request('profile.set', { values: profile })
    if (!p.ok) { setHostError(ERROR_COPY[p.error.kind]); return }
    const b = await port.request('answerBank.set', { values: bank })
    if (!b.ok) { setHostError(ERROR_COPY[b.error.kind]); return }
    setFacts((f) => ({ ...f, ...profile, ...bank }))
    // The gate's one sanctioned exit; the nonce re-fires the (blocked) auto-scan
    // effect exactly once.
    setCompleteness('complete')
    setScanNonce((n) => n + 1)
  }
```

  - Render: wrap everything BELOW `<SelfCheckBanner …/>` (from the captcha banner through the Save answers row) in:

```tsx
      {completeness === 'incomplete'
        ? (
            <OnboardingView
              key={factsLoaded ? 'loaded' : 'pending'}
              values={facts} loaded={factsLoaded} resumeName={resumeName}
              onUpload={onOnboardingUpload} onExtract={onOnboardingExtract} onFinish={onOnboardingFinish}
            />
          )
        : (
            <>
              {/* …the existing markup, unchanged… */}
            </>
          )}
```

- [ ] **Step 6: Run the panel suite** — `npx vitest run extension/src/panel` — ALL PASS. Sweep fallout rule: any pre-existing test failing on the persona change (e.g. one asserting `(none stored)` resume copy) gets `await clearResume()` at its start — FIX-AND-REPORT each.

- [ ] **Step 7: Typecheck + lint** — `npm run typecheck && npm run lint` — clean.

- [ ] **Step 8: Commit**

```bash
git add extension/src/panel/App.tsx extension/src/panel/App.test.tsx extension/src/panel/port.ts
git commit -m "feat(onboarding): hard gate wired — settled tri-state decision gates auto-scan; unknown never bricks (O3)"
```

---

### Task 4: A1 — host `applied_jobs` table, `canonicalUrl`, `applied.*` methods

**Files:**
- Create: `host/src/canonicalUrl.ts`, `host/src/canonicalUrl.test.ts`
- Modify: `host/src/db/schema.ts` (new CREATE TABLE — `migrate()` is `CREATE TABLE IF NOT EXISTS`, safe no-op migration)
- Modify: `host/src/db/repos.ts` (three repo functions + `AppliedJob`)
- Modify: `shared/src/messages.ts` (three `HostRequestSchema` union entries)
- Modify: `host/src/handlers.ts` (three `compute()` arms + imports)
- Modify: `extension/src/panel/port.ts` (canned-fake entries for the three new methods — every seam-built panel and every unit test without an explicit bridge hits the canned map, and a MISSING entry answers `{}`, which downstream code must never have to defend against)
- Modify: `shared/src/messages.test.ts`, `host/src/handlers.test.ts`

**Interfaces:**
- Produces:
  - `canonicalUrl(raw: string): string` — canonical form is `host/path?params`, NO scheme, NO leading `www.`: lowercase host, strip fragment + trailing slash, drop tracking params (`utm_*`, `gh_src`, `ref`, `source`), keep every other param (identity params `ashby_jid`/`gh_jid`/`jobId` are thereby kept) sorted for stability. Unparseable input passes through trimmed.
  - `AppliedJob { id, url, canonicalUrl, company: string | null, jobTitle: string | null, markedAt: string }`.
  - `markApplied(db, { url, company, jobTitle }): AppliedJob` — upsert by canonical_url; **`marked_at` is NOT in the update set** (re-marking keeps the ORIGINAL date).
  - `checkApplied(db, url): AppliedJob | null`, `listApplied(db): AppliedJob[]` (newest first).
  - Host methods `applied.mark { url, company, jobTitle }` → `AppliedJob`; `applied.check { url }` → `{ applied: AppliedJob | null }`; `applied.list {}` → `{ jobs: AppliedJob[] }`.
- Consumed by: Tasks 5, 7, 8, 17, 18.

**Model:** implementer-opus-medium.

**Verify:** `npm run build -w @jff/shared && npx vitest run host shared && npm run typecheck && npm run lint`

**Boundaries:** The existing `applications` save-log table is UNTOUCHED (different semantics — one insert per save event). Column is `marked_at`, never `applied_at`.

- [ ] **Step 1: Write the failing canonicalUrl tests** — create `host/src/canonicalUrl.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canonicalUrl } from './canonicalUrl.js'

describe('canonicalUrl (A1)', () => {
  it('ashby: the identity param survives; tracking params, scheme and www. drop; host lowercases', () => {
    expect(canonicalUrl('https://www.TRMLabs.com/careers/?ashby_jid=6edf242b&utm_source=x&gh_src=abc'))
      .toBe('trmlabs.com/careers?ashby_jid=6edf242b')
  })

  it('greenhouse: path identity survives; gh_src/ref/source and the fragment drop', () => {
    expect(canonicalUrl('https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002?gh_src=abc&ref=li&source=tw#app'))
      .toBe('job-boards.greenhouse.io/deliveryassociates/jobs/8517393002')
  })

  it('keeps jobId and unknown params, sorted for stability', () => {
    expect(canonicalUrl('https://x.com/a?z=1&jobId=9&a=2')).toBe('x.com/a?a=2&jobId=9&z=1')
  })

  it('scheme, www., trailing slash, fragment and param order all collide on ONE canonical form', () => {
    expect(canonicalUrl('https://X.com/jobs/1/?utm_campaign=a#top')).toBe(canonicalUrl('http://www.x.com/jobs/1'))
  })

  it('path case is preserved (only the host lowercases); a bare root path drops', () => {
    expect(canonicalUrl('https://Jobs.Acme.COM/Apply/')).toBe('jobs.acme.com/Apply')
    expect(canonicalUrl('https://acme.com/')).toBe('acme.com')
  })

  it('an unparseable url passes through trimmed', () => {
    expect(canonicalUrl('  not a url ')).toBe('not a url')
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run host/src/canonicalUrl.test.ts` — FAILS (no module).

- [ ] **Step 3: Create `host/src/canonicalUrl.ts`:**

```ts
/**
 * A1: one job posting, one row. Raw URLs disagree between ATSes — the Ashby
 * job's identity IS its query param (?ashby_jid=…) while Greenhouse's is the
 * path with gh_src/utm_* as tracking noise. The canonical form is
 * `host/path?params` — NO scheme (http vs https is transport, not identity)
 * and NO leading `www.` (the same posting is shared both ways). Policy on
 * params: drop the KNOWN tracking set, keep everything else (identity params
 * like ashby_jid/gh_jid/jobId are thereby kept; an unknown param kept means
 * at worst a missed badge on revisit — safer than merging two different jobs
 * by over-dropping), sorted so param order can never split one job into two.
 */
const isTracking = (key: string): boolean => {
  const k = key.toLowerCase()
  return k.startsWith('utm_') || k === 'gh_src' || k === 'ref' || k === 'source'
}

export function canonicalUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return raw.trim() }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  let path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : u.pathname
  if (path === '/') path = ''
  const kept = [...u.searchParams].filter(([k]) => !isTracking(k))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = kept.length === 0
    ? ''
    : `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
  return `${host}${path}${query}`
}
```

- [ ] **Step 4: Run to see it pass** — `npx vitest run host/src/canonicalUrl.test.ts` — PASS.

- [ ] **Step 5: Schema.** In `host/src/db/schema.ts`, append to `SCHEMA_SQL` (before the closing backtick, after the `request_log` block):

```sql
-- A1: one row per job actually SUBMITTED (the applications table above is a
-- save-event log — different semantics, no UNIQUE). marked_at, not applied_at.
CREATE TABLE IF NOT EXISTS applied_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  company       TEXT,
  job_title     TEXT,
  marked_at     TEXT NOT NULL
);
```

- [ ] **Step 6: Repos.** In `host/src/db/repos.ts` add `import { canonicalUrl } from '../canonicalUrl.js'` and append:

```ts
/* ------------------------------------------------------------- applied (A1) */

export interface AppliedJob {
  id: number
  url: string
  canonicalUrl: string
  company: string | null
  jobTitle: string | null
  markedAt: string
}

interface RawApplied {
  id: number; url: string; canonical_url: string
  company: string | null; job_title: string | null; marked_at: string
}

const toApplied = (r: RawApplied): AppliedJob => ({
  id: r.id, url: r.url, canonicalUrl: r.canonical_url,
  company: r.company, jobTitle: r.job_title, markedAt: r.marked_at,
})

/** Upsert by canonical_url. `marked_at` is NOT in the update set: re-marking
 *  after a "Scan anyway" re-apply keeps the ORIGINAL date (spec A1). */
export function markApplied(
  db: Database.Database,
  row: { url: string; company: string | null; jobTitle: string | null },
): AppliedJob {
  const canonical = canonicalUrl(row.url)
  db.prepare(
    `INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(canonical_url) DO UPDATE SET
       url = excluded.url, company = excluded.company, job_title = excluded.job_title`,
  ).run(row.url, canonical, row.company, row.jobTitle, new Date().toISOString())
  const got = db.prepare(`SELECT * FROM applied_jobs WHERE canonical_url = ?`).get(canonical) as RawApplied
  return toApplied(got)
}

export function checkApplied(db: Database.Database, url: string): AppliedJob | null {
  const row = db.prepare(`SELECT * FROM applied_jobs WHERE canonical_url = ?`)
    .get(canonicalUrl(url)) as RawApplied | undefined
  return row === undefined ? null : toApplied(row)
}

export function listApplied(db: Database.Database): AppliedJob[] {
  return (db.prepare(`SELECT * FROM applied_jobs ORDER BY marked_at DESC, id DESC`).all() as RawApplied[]).map(toApplied)
}
```

- [ ] **Step 7: Protocol.** In `shared/src/messages.ts`, append to the `HostRequestSchema` `discriminatedUnion('method', …)` entries (after the `qa.list` entry):

```ts
  z.object({
    requestId: z.string().min(1), method: z.literal('applied.mark'),
    // A2: url is the session's captured START url; jobTitle from tab.title, nullable.
    params: z.object({ url: z.string().min(1), company: z.string().nullable(), jobTitle: z.string().nullable() }),
  }),
  z.object({ requestId: z.string().min(1), method: z.literal('applied.check'), params: z.object({ url: z.string().min(1) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('applied.list'), params: z.object({}).passthrough() }),
```

Append to `shared/src/messages.test.ts` (inside/beside the existing HostRequestSchema describe, matching its style):

```ts
describe('HostRequestSchema — applied.* (A1)', () => {
  it('accepts the three applied methods', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'applied.mark', params: { url: 'https://x.com/j/1', company: null, jobTitle: null } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r2', method: 'applied.check', params: { url: 'https://x.com/j/1' } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r3', method: 'applied.list', params: {} }).success).toBe(true)
  })
  it('rejects applied.mark without a url', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r4', method: 'applied.mark', params: { company: null, jobTitle: null } }).success).toBe(false)
  })
})
```

- [ ] **Step 8: Handlers.** In `host/src/handlers.ts`, extend the repos import with `checkApplied, listApplied, markApplied` and add arms to `compute()`'s switch (before the `facts.extract` case):

```ts
      case 'applied.mark':
        return ok(req.requestId, markApplied(db, {
          url: req.params.url, company: req.params.company, jobTitle: req.params.jobTitle,
        }))

      case 'applied.check':
        return ok(req.requestId, { applied: checkApplied(db, req.params.url) })

      case 'applied.list':
        return ok(req.requestId, { jobs: listApplied(db) })
```

- [ ] **Step 8b: Canned fake entries.** In `extension/src/panel/port.ts`, add to `createFakeHostPort`'s canned map (beside the Task-3 `profile.get` persona entry):

```ts
        // A1: the canned persona has applied to NOTHING — the revisit badge
        // (Task 7) reads `applied` off this shape, so the miss must be an
        // explicit null, never a missing key answering {}.
        'applied.check': { applied: null },
        'applied.list': { jobs: [] },
        'applied.mark': { id: 0, url: '', canonicalUrl: '', company: null, jobTitle: null, markedAt: new Date(0).toISOString() },
```

- [ ] **Step 9: Handler tests.** Append to `host/src/handlers.test.ts`. That file has NO deps factory — it uses a module-scope `let deps: HandlerDeps` assigned in `beforeEach` (fresh in-memory db per test); the snippets below use `deps` directly. Use a DISTINCT requestId per call — the idempotency ledger replays repeats. (If the file's harness shape differs from this description, adapt and FIX-AND-REPORT.)

```ts
describe('applied.* (A1)', () => {
  it('mark → check round-trips through the canonical url', async () => {
    const marked = await handleRequest(deps, { requestId: 'am-1', method: 'applied.mark', params: { url: 'https://x.com/j/1?utm_source=a', company: 'Acme', jobTitle: 'Eng' } })
    expect(marked.ok).toBe(true)
    const checked = await handleRequest(deps, { requestId: 'am-2', method: 'applied.check', params: { url: 'https://x.com/j/1?utm_medium=b' } })
    expect(checked).toMatchObject({ ok: true, result: { applied: { company: 'Acme', jobTitle: 'Eng', canonicalUrl: 'x.com/j/1' } } })
  })

  it('re-marking preserves the ORIGINAL marked_at and updates the rest', async () => {
    const first = await handleRequest(deps, { requestId: 'am-3', method: 'applied.mark', params: { url: 'https://x.com/j/2', company: null, jobTitle: null } })
    const firstAt = (first as { result: { markedAt: string } }).result.markedAt
    const again = await handleRequest(deps, { requestId: 'am-4', method: 'applied.mark', params: { url: 'https://x.com/j/2/?utm_source=x', company: 'Acme', jobTitle: 'Eng II' } })
    expect((again as { result: { markedAt: string } }).result.markedAt).toBe(firstAt)
    expect(again).toMatchObject({ ok: true, result: { company: 'Acme', jobTitle: 'Eng II' } })
  })

  it('check misses on a different job', async () => {
    const r = await handleRequest(deps, { requestId: 'am-5', method: 'applied.check', params: { url: 'https://x.com/j/999' } })
    expect(r).toMatchObject({ ok: true, result: { applied: null } })
  })

  it('list returns newest-first', async () => {
    await handleRequest(deps, { requestId: 'am-6', method: 'applied.mark', params: { url: 'https://x.com/j/a', company: null, jobTitle: 'A' } })
    await handleRequest(deps, { requestId: 'am-7', method: 'applied.mark', params: { url: 'https://x.com/j/b', company: null, jobTitle: 'B' } })
    const r = await handleRequest(deps, { requestId: 'am-8', method: 'applied.list', params: {} })
    const jobs = (r as { result: { jobs: { jobTitle: string }[] } }).result.jobs
    expect(jobs.map((j) => j.jobTitle)).toEqual(['B', 'A'])
  })
})
```

(If `marked_at DESC` ties within the same millisecond, the `id DESC` tiebreaker keeps `['B','A']` deterministic.)

- [ ] **Step 10: Run everything** — `npm run build -w @jff/shared && npx vitest run host shared && npm run typecheck && npm run lint` — PASS / clean.

- [ ] **Step 11: Commit**

```bash
git add host/src shared/src extension/src/panel/port.ts
git commit -m "feat(host): applied_jobs table, canonicalUrl, applied.mark/check/list plumbing + canned fake entries (A1)"
```

---

### Task 5: A2 — "Mark applied" button + start-url capture

**Files:**
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `applied.mark` (Task 4).
- Produces: `startUrl` state (the FIRST scanned page of the current application — pre-sessions approximation; Task 14 folds it into `Session.startUrl`), `appliedHit` state + badge line, `onMarkApplied()`. "Ends the session" is, pre-S, the same clearing `resetScanState` does; Task 14 upgrades it to session deletion.
- Consumed by: Task 6 (prompt's Mark applied), Task 7 (badge + Scan anyway), Task 14 (migration into Session).

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/panel/App.test.tsx && npm run typecheck && npm run lint`

**Boundaries:** No applied.check yet (Task 7). Do not touch `onScan`'s scan pipeline beyond the two capture lines specified.

- [ ] **Step 1: Write the failing tests** — append to `App.test.tsx`:

```tsx
describe('App — mark applied (A2)', () => {
  function markingBridge(behind: { params: unknown[] }, fail = false): void {
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'applied.mark') {
        behind.params.push(params)
        if (fail) return { requestId, ok: false, error: { kind: 'db', message: 'nope' } }
        return { requestId, ok: true, result: { id: 1, url: (params as { url: string }).url, canonicalUrl: 'c', company: null, jobTitle: null, markedAt: '2026-07-29T00:00:00.000Z' } }
      }
      if (method === 'resolve') {
        return { requestId, ok: true, result: { epoch: 1, resolutions: [], llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('records the START url, tab title and company, then ends the session', async () => {
    const seen = { params: [] as unknown[] }
    markingBridge(seen)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.change(document.querySelector('[data-jff-company] input')!, { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => expect(seen.params.length).toBe(1))
    expect(seen.params[0]).toEqual({ url: 'https://jobs.acme.com/apply', company: 'Acme', jobTitle: 'Engineer at Acme' })
    // Session ended: rows gone, badge line up.
    await waitFor(() => expect(document.querySelector('[data-jff-rows]')).toBeNull())
    expect(document.querySelector('[data-jff-applied]')).not.toBeNull()
  })

  it('a failed mark keeps the session (retryable) and surfaces the host banner', async () => {
    const seen = { params: [] as unknown[] }
    markingBridge(seen, true)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => expect(seen.params.length).toBe(1))
    expect(document.querySelector('[data-jff-rows]')).not.toBeNull()
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })

  it('the button is disabled before any scan captured a start url', async () => {
    markingBridge({ params: [] })
    render(<App />)
    // Before the auto-scan settles the button must not be actionable.
    expect((screen.getByRole('button', { name: 'Mark applied' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run extension/src/panel/App.test.tsx -t 'mark applied'` — FAILS (no button).

- [ ] **Step 3: Implement in `App.tsx`.**
  - State (near the other useStates):

```ts
  // A2: the FIRST scanned page of this application — the posting URL applied.mark
  // records (wizard step 2's URL is not the posting). Task 14 moves this into
  // the per-tab Session; until then it survives `navigated` resets only.
  const [startUrl, setStartUrl] = useState<string | null>(null)
  const [appliedHit, setAppliedHit] = useState<{ markedAt: string } | null>(null)
  const [marking, setMarking] = useState(false)
```

  - In `resetScanState`, after the `companyGuessedRef` block:

```ts
    // A2: a navigation within the same tab is (pre-sessions) still the same
    // application — the start url survives it. A tab switch or close is not.
    if (reason !== 'navigated') { setStartUrl(null); setAppliedHit(null) }
```

  - In `onScan`, right after the `if (tab === null) …return` line:

```ts
      // A2: first settled trigger on this application captures the posting URL.
      if (resetGenRef.current === gen) setStartUrl((s) => s ?? (tab.url ?? null))
```

  - Handler (near `onSaveAnswers`):

```ts
  /** A2: record the application under the session's START url, then end the
   *  session. A failed mark keeps the session — it is retryable (spec, Error
   *  handling). Task 14 replaces the manual clearing with session deletion. */
  const onMarkApplied = async (): Promise<void> => {
    const port = portRef.current
    if (port === null || startUrl === null || marking) return
    setMarking(true)
    try {
      const tab = await getTab()
      const title = (tab?.title ?? '').trim()
      const r = await port.request<{ markedAt: string }>('applied.mark', {
        url: startUrl,
        company: companyOrNull,
        jobTitle: title === '' ? null : title,
      })
      if (!r.ok) { setHostError(ERROR_COPY[r.error.kind]); return }
      setAppliedHit({ markedAt: r.result.markedAt })
      // End the session (pre-S: clear like a tab-scope reset, keep the badge).
      resetGenRef.current++
      lastOutcomeRef.current = null
      setFields([]); setResolutions([]); setElection(null); setEdits({}); setFilledRefs([]); setGeneratedRefs([])
      setSnapshot({}); setUnreachable(0); setActiveCaptcha(false); setJobText(''); setSaveMsg(null)
      setReuseOverrides({}); setScanStatus(null); setFrameReports([]); setStartUrl(null)
    } finally {
      setMarking(false)
    }
  }
```

  - Button, appended inside the existing actions row `div[data-jff-actions]` after the facts-editor button:

```tsx
        <button
          type="button" className={BTN} data-jff-mark-applied="1"
          disabled={tabId === null || marking || startUrl === null}
          onClick={() => { void onMarkApplied() }}
        >
          {busyLabel(marking, 'Mark applied', 'Marking…')}
        </button>
```

  - Badge line (directly below the `<ScanStatus …/>` element; Task 7 adds the pre-scan check + Scan anyway around this same state):

```tsx
      {appliedHit !== null && (
        <div className={BANNER_BASE} role="status" data-jff-applied="1">
          Already applied on {new Date(appliedHit.markedAt).toLocaleDateString()}.
        </div>
      )}
```

  (`BANNER_BASE` is already imported in App.tsx.)

- [ ] **Step 4: Run to see them pass** — `npx vitest run extension/src/panel/App.test.tsx && npm run typecheck && npm run lint` — PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/App.tsx extension/src/panel/App.test.tsx
git commit -m "feat(applied): Mark applied button records the start url and ends the session (A2)"
```

---

### Task 6: A3 — submission detection prompt (never a silent write)

**Files:**
- Create: `extension/src/panel/submission.ts`, `extension/src/panel/submission.test.ts`
- Modify: `shared/src/messages.ts` (`JFF_PAGETEXT` ContentMessage)
- Modify: `extension/src/content/index.ts` (JFF_PAGETEXT handler)
- Modify: `extension/src/panel/App.tsx`, `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `onMarkApplied` (Task 5).
- Produces:
  - `detectSubmission({ prevFields, newFields, pageText }): boolean` — true when fillable fields went >0 → 0, OR the page text matches the spec's bilingual confirmation patterns.
  - ContentMessage `{ type: 'JFF_PAGETEXT', epoch }` → reply `{ ok: true, pageText: string }` (whitespace-normalized `document.body.innerText`, capped at 4000 chars).
  - The non-blocking prompt: `Looks like this application was submitted. Mark as applied?` with `Mark applied` / `Dismiss` buttons; dismissing never re-prompts for the same page load (= the same reset generation).
- Consumed by: Task 17 (e2e), Task 19 (manual gate).

**Model:** implementer-opus-medium.

**Verify:** `npm run build -w @jff/shared && npx vitest run extension/src/panel shared && npm run typecheck && npm run lint`

**Boundaries:** Detection NEVER writes — it only shows the prompt; `Mark applied` inside it calls the Task-5 handler. Pre-sessions, "same-site navigation" is approximated as "same hostname as the previous scan" — Task 14 upgrades the trigger to registrable-domain classification (approximation noted in a code comment).

- [ ] **Step 1: Write the failing detector tests** — create `extension/src/panel/submission.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { detectSubmission } from './submission'

describe('detectSubmission (A3)', () => {
  it('fires when fillable fields went >0 to 0', () => {
    expect(detectSubmission({ prevFields: 4, newFields: 0, pageText: '' })).toBe(true)
  })

  it('does NOT fire on a fresh page that never had fields', () => {
    expect(detectSubmission({ prevFields: 0, newFields: 0, pageText: 'anything' })).toBe(false)
  })

  it.each([
    ['en', 'Thank you for applying to Acme!'],
    ['en', 'Your application submitted successfully.'],
    ['en', 'Application received — we will be in touch.'],
    ['pt', 'Obrigado por se candidatar!'],
    ['pt', 'Candidatura enviada com sucesso.'],
    ['pt', 'Recebemos sua candidatura.'],
  ])('fires on the %s confirmation text regardless of field counts', (_lang, text) => {
    expect(detectSubmission({ prevFields: 3, newFields: 3, pageText: `header nav ${text} footer` })).toBe(true)
  })

  it('never fires on an ordinary wizard step page', () => {
    expect(detectSubmission({ prevFields: 3, newFields: 5, pageText: 'Tell us more about your experience. Voluntary self-identification.' })).toBe(false)
  })

  it('survives whitespace and case noise in the page text', () => {
    expect(detectSubmission({ prevFields: 1, newFields: 1, pageText: 'THANK  YOU\n FOR   APPLYING' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run extension/src/panel/submission.test.ts` — FAILS (no module).

- [ ] **Step 3: Create `extension/src/panel/submission.ts`:**

```ts
/** A3: bilingual confirmation-page vocabulary (spec-fixed, en + pt). Matched
 *  against whitespace-collapsed page text, case-insensitively. */
const CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /thank you for applying/i,
  /application submitted/i,
  /application received/i,
  /obrigado por se candidatar/i,
  /candidatura enviada/i,
  /recebemos sua candidatura/i,
]

/**
 * A3: a submission is SUSPECTED — never recorded silently — when a wizard-step
 * re-scan lost every fillable field, or the new page reads like a confirmation
 * page. The caller turns a true verdict into a dismissible prompt, nothing else.
 */
export function detectSubmission(input: { prevFields: number; newFields: number; pageText: string }): boolean {
  if (input.prevFields > 0 && input.newFields === 0) return true
  const text = input.pageText.replace(/\s+/g, ' ')
  return CONFIRMATION_PATTERNS.some((re) => re.test(text))
}
```

- [ ] **Step 4: Run to see it pass** — `npx vitest run extension/src/panel/submission.test.ts` — PASS.

- [ ] **Step 5: Protocol + content handler.**
  - In `shared/src/messages.ts`, append to `ContentMessageSchema`:

```ts
  // A3: the panel's submission-detection needs the page's VISIBLE text after a
  // wizard-step re-scan; jobText heuristics answer a different question.
  z.object({ type: z.literal('JFF_PAGETEXT'), epoch: z.number().int().nonnegative() }),
```

  - In `extension/src/content/index.ts`, add beside the `JFF_JOBTEXT` handler (mirroring its epoch handling exactly — same gate, same reply envelope shape):

```ts
  if (msg.type === 'JFF_PAGETEXT') {
    return { ok: true, pageText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000) }
  }
```

  - `npm run build -w @jff/shared`.

- [ ] **Step 6: Write the failing App tests** — append to `App.test.tsx`:

```tsx
describe('App — submission detection prompt (A3)', () => {
  /** Scan 1: one field. After the simulated navigation, scan 2: zero fields and
   *  a confirmation body. The harness flips on a mutable switch. */
  function installWizardEnd(state: { done: boolean }): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN' && state.done) {
        return {
          ok: true,
          replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply/done', payload: { ok: true, scan: { epoch: 2, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_PAGETEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, pageText: state.done ? 'Thank you for applying to Acme' : 'form page' } }], failures: [] }
      }
      return base(msg)
    })
  }
  const navigate = (): void => {
    const onUpdated = (globalThis as unknown as { chrome: { tabs: { onUpdated: { addListener: ReturnType<typeof vi.fn> } } } })
      .chrome.tabs.onUpdated.addListener.mock.calls[0]![0] as (id: number, change: { status?: string }) => void
    act(() => onUpdated(7, { status: 'loading' }))
  }

  it('a same-site navigation re-scan to zero fields prompts — and never writes on its own', async () => {
    const state = { done: false }
    installWizardEnd(state)
    const marks: unknown[] = []
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'applied.mark') { marks.push(params); return { requestId, ok: true, result: { markedAt: '2026-07-29T00:00:00.000Z' } } }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    state.done = true
    // The wizard advanced: the TAB now sits on the confirmation url, so the
    // start-vs-current assertion below is distinguishable, not vacuous.
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockResolvedValue({ id: 7, url: 'https://jobs.acme.com/apply/done', title: 'Engineer at Acme' })
    navigate()
    await waitFor(() => expect(document.querySelector('[data-jff-submit-prompt]')).not.toBeNull())
    expect(screen.getByText(/Mark as applied\?/)).toBeTruthy()
    expect(marks.length).toBe(0) // never a silent write
    // data hook, not getByRole: the actions row has its own 'Mark applied'
    // button (Task 5), and two buttons sharing the accessible name would make
    // getByRole throw "Found multiple elements".
    fireEvent.click(document.querySelector('[data-jff-prompt-mark]')!)
    await waitFor(() => expect(marks.length).toBe(1))
    // Wizard flow: the RECORDED url is the START page, not the confirmation step.
    expect(marks[0]).toMatchObject({ url: 'https://jobs.acme.com/apply' })
  })

  it('dismissing never re-prompts for the same page load', async () => {
    const state = { done: false }
    installWizardEnd(state)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    state.done = true
    navigate()
    await waitFor(() => expect(document.querySelector('[data-jff-submit-prompt]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-jff-prompt-dismiss]')!)
    expect(document.querySelector('[data-jff-submit-prompt]')).toBeNull()
    // A manual re-scan of the SAME page load must not resurrect the prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('empty'))
    expect(document.querySelector('[data-jff-submit-prompt]')).toBeNull()
  })
})
```

- [ ] **Step 7: Run to see them fail** — `npx vitest run extension/src/panel/App.test.tsx -t 'submission detection'` — FAILS.

- [ ] **Step 8: Implement the App wiring.**
  - Refs/state:

```ts
  const [submitPrompt, setSubmitPrompt] = useState(false)
  // A3: "same page load" = same reset generation; a dismissal is remembered
  // against it, so only a NEW navigation can re-arm the prompt.
  const promptDismissedGenRef = useRef(-1)
  // Event-closure-safe mirrors (resetScanState runs from listeners that closed
  // over the first render).
  const fieldsCountRef = useRef(0)
  const lastScanHostRef = useRef<string | null>(null)
  const navRescanRef = useRef<{ prevFields: number } | null>(null)
```

  - Keep `fieldsCountRef` true everywhere `setFields` is called: in `resetScanState` (`fieldsCountRef.current = 0` beside `setFields([])`), in `onScan`'s success block (`fieldsCountRef.current = out.fields.length`), and in `onMarkApplied`'s clearing block (`fieldsCountRef.current = 0`).
  - In `resetScanState`, for the `navigated` reason record the handoff BEFORE clearing (first line of the function):

```ts
    // A3: remember what the dying page had — the re-scan's detection compares
    // against it. Only a navigation hands off; switches/closes detect nothing.
    if (reason === 'navigated') navRescanRef.current = { prevFields: fieldsCountRef.current }
    else navRescanRef.current = null
```

  and clear the prompt in every reset: `setSubmitPrompt(false)` beside the other setters.
  - In `onScan`, after the `hostname` const is computed, consume the pending handoff:

```ts
      // A3 trigger: this scan replays a NAVIGATION and stays on the same site.
      // Pre-sessions approximation: same hostname (Task 14 upgrades this to
      // registrable-domain classification).
      const pendingNav = navRescanRef.current
      navRescanRef.current = null
      const sameSiteNav = pendingNav !== null && lastScanHostRef.current !== null && hostname === lastScanHostRef.current
      lastScanHostRef.current = hostname
```

  - In `onScan`'s success block, after `setOutcome(...)`:

```ts
      // A3: detection is only ever a PROMPT. Best-effort page text; a dead
      // relay just means the field-count heuristic decides alone.
      if (sameSiteNav && promptDismissedGenRef.current !== gen && appliedHit === null) {
        let pageText = ''
        try {
          const { replies } = await sendToTab(0, { type: 'JFF_PAGETEXT', epoch: epochRef.current })
          const p = replies[0]?.payload as { ok?: boolean; pageText?: string } | undefined
          if (p?.ok === true) pageText = p.pageText ?? ''
        } catch { /* best-effort */ }
        if (resetGenRef.current !== gen) return
        if (detectSubmission({ prevFields: pendingNav!.prevFields, newFields: out.fields.length, pageText })) {
          setSubmitPrompt(true)
        }
      }
```

  - Prompt markup (below the Task-5 badge block):

```tsx
      {submitPrompt && (
        <div className={BANNER_BASE} role="status" data-jff-submit-prompt="1">
          Looks like this application was submitted. Mark as applied?
          <span className="ml-2 inline-flex gap-2">
            {/* data hooks: the actions row already owns a 'Mark applied'
                accessible name (Task 5); tests target these, not roles. */}
            <button type="button" className={BTN} data-jff-prompt-mark="1" onClick={() => { setSubmitPrompt(false); void onMarkApplied() }}>Mark applied</button>
            <button type="button" className={BTN} data-jff-prompt-dismiss="1" onClick={() => { setSubmitPrompt(false); promptDismissedGenRef.current = resetGenRef.current }}>Dismiss</button>
          </span>
        </div>
      )}
```

  - Import `detectSubmission` in App.tsx.

- [ ] **Step 9: Run everything** — `npm run build -w @jff/shared && npx vitest run extension/src/panel shared && npm run typecheck && npm run lint` — PASS / clean.

- [ ] **Step 10: Commit**

```bash
git add shared/src extension/src/content/index.ts extension/src/panel
git commit -m "feat(applied): submission detection prompt — fields-vanished + bilingual confirmation text, dismiss-once (A3)"
```

---

### Task 7: A4 — revisit badge with "Scan anyway"

**Files:**
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `applied.check` (Task 4), the canned-fake applied entries (Task 4 Step 8b — this task's code relies on `applied: null` misses being explicit), `appliedHit` badge state (Task 5).
- Produces: pre-scan `applied.check` inside `onScan`; a hit renders `Already applied on <date>.` + `Scan anyway` INSTEAD of scanning. Precedence: onboarding gate (Task 3 blocks `onScan` entirely) > host gate (`gateOpen` — the check IS a host call, so it necessarily runs behind it) > applied badge (this check, first thing a scan does) > scan. A check FAILURE proceeds as not-applied.
- Consumed by: Task 17 (e2e), Task 19 (manual gate).

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/panel/App.test.tsx && npm run typecheck && npm run lint`

- [ ] **Step 1: Write the failing tests** — append to `App.test.tsx`:

```tsx
describe('App — revisit badge (A4)', () => {
  const HIT = { id: 1, url: 'https://jobs.acme.com/apply', canonicalUrl: 'c', company: 'Acme', jobTitle: 'Eng', markedAt: '2026-07-01T00:00:00.000Z' }
  const scanCount = (): number => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    return send.mock.calls.filter((c) => (c[0] as { message?: { type?: string } })?.message?.type === 'JFF_SCAN').length
  }
  function checkBridge(applied: unknown, checkFails = false): void {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'applied.check') {
        if (checkFails) return { requestId, ok: false, error: { kind: 'db', message: 'nope' } }
        return { requestId, ok: true, result: { applied } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('a previously applied page renders the badge INSTEAD of scanning', async () => {
    checkBridge(HIT)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-applied]')).not.toBeNull())
    expect(screen.getByText(/Already applied on/)).toBeTruthy()
    expect(scanCount()).toBe(0)
  })

  it('Scan anyway overrides the badge and scans exactly once', async () => {
    checkBridge(HIT)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-applied]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Scan anyway' }))
    await waitFor(() => expect(scanCount()).toBe(1))
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })

  it('a failed applied.check proceeds as not-applied', async () => {
    checkBridge(null, true)
    render(<App />)
    await waitFor(() => expect(scanCount()).toBe(1))
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run extension/src/panel/App.test.tsx -t 'revisit badge'` — the first two FAIL (scan runs today); the third may already pass and must STAY green.

- [ ] **Step 3: Implement.**
  - Ref: `const appliedOverrideRef = useRef(false)` — reset to `false` in `resetScanState` on EVERY reason (a new page load re-arms the badge; "Scan anyway" is exactly one page's escape hatch). Add `appliedOverrideRef.current = false` beside the other reset lines.
  - In `onScan`, immediately after the Task-5 start-url capture line:

```ts
      // A4: the applied badge outranks the scan itself — but never the user's
      // explicit override, and a check FAILURE proceeds as not-applied (spec,
      // Error handling). Precedence: onboarding gate (the auto-scan effect
      // never calls us while incomplete) > host gate (gateOpen — this check IS
      // a host call, so it necessarily runs after it) > this badge > scan.
      // `?? null` is load-bearing: the canned fake answers unknown methods {},
      // and an `undefined` here must read as a MISS, never as a hit.
      if (!appliedOverrideRef.current) {
        const chk = await port.request<{ applied: { markedAt: string } | null }>('applied.check', { url: tab.url ?? '' })
        if (resetGenRef.current !== gen) return
        const hit = chk.ok ? (chk.result.applied ?? null) : null
        if (hit !== null) {
          setAppliedHit({ markedAt: hit.markedAt })
          setScanStatus(null)
          return
        }
      }
```

  (The early `return` runs through `onScan`'s `finally`, releasing the scan latch and replaying any pending trigger — that behavior is load-bearing, keep the `return` inside the `try`.)
  - Extend the Task-5 badge block with the escape hatch:

```tsx
      {appliedHit !== null && (
        <div className={BANNER_BASE} role="status" data-jff-applied="1">
          Already applied on {new Date(appliedHit.markedAt).toLocaleDateString()}.
          <button
            type="button" className={`${BTN} ml-2`}
            onClick={() => { appliedOverrideRef.current = true; setAppliedHit(null); setScanNonce((n) => n + 1) }}
          >
            Scan anyway
          </button>
        </div>
      )}
```

- [ ] **Step 4: Run everything** — `npx vitest run extension/src/panel && npm run typecheck && npm run lint` — PASS / clean. (Task 5/6 tests must stay green: their bridges answer `applied.check` via the `result: {}` fallback → `applied` is `undefined` → the Step-3 `?? null` guard reads that as a MISS and the scan proceeds. If any still break on the check call, fix the FIXTURE to answer `applied.check` with `{ applied: null }` and report.)

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/App.tsx extension/src/panel/App.test.tsx
git commit -m "feat(applied): revisit badge checks applied.check before scanning; Scan anyway escape hatch (A4)"
```

---

### Task 8: A5 — Applications list + three-view navigation

**Files:**
- Create: `extension/src/panel/ApplicationsView.tsx`, `extension/src/panel/ApplicationsView.test.tsx`
- Modify: `extension/src/panel/App.tsx`, `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `applied.list` (Task 4).
- Produces: `view: 'session' | 'editor' | 'applications'` replaces `showEditor` — three mutually exclusive views, toggled from the actions row (`div[data-jff-actions]`, App.tsx:714–721; that is where the existing facts-editor toggle lives, not the `<header>`). `ApplicationsView({ load })` — read-only v1: date, company, title, link out.
- Consumed by: Task 14 (view is PANEL-GLOBAL state per the partition table), Task 19.

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

- [ ] **Step 1: Write the failing view tests** — create `extension/src/panel/ApplicationsView.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ApplicationsView, type AppliedJobRow } from './ApplicationsView'

const JOB: AppliedJobRow = {
  id: 1, url: 'https://x.com/j/1', canonicalUrl: 'https://x.com/j/1',
  company: 'Acme', jobTitle: 'Engineer', markedAt: '2026-07-01T12:00:00.000Z',
}

describe('ApplicationsView (A5)', () => {
  it('renders date, company, title and a link out', async () => {
    render(<ApplicationsView load={async () => [JOB]} />)
    await screen.findByText('Engineer')
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText(new Date(JOB.markedAt).toLocaleDateString())).toBeTruthy()
    const a = screen.getByRole('link', { name: 'Open posting' }) as HTMLAnchorElement
    expect(a.href).toBe('https://x.com/j/1')
    expect(a.target).toBe('_blank')
  })

  it('renders the empty state', async () => {
    render(<ApplicationsView load={async () => []} />)
    await screen.findByText('Nothing marked applied yet.')
  })

  it('renders the failure state when load resolves null', async () => {
    render(<ApplicationsView load={async () => null} />)
    await screen.findByText('Could not load your applications.')
  })

  it('falls back to the company, then the url, when the title is null', async () => {
    render(<ApplicationsView load={async () => [{ ...JOB, jobTitle: null }]} />)
    await waitFor(() => expect(screen.getAllByText('Acme').length).toBeGreaterThan(0))
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run extension/src/panel/ApplicationsView.test.tsx` — FAILS (no module).

- [ ] **Step 3: Create `extension/src/panel/ApplicationsView.tsx`:**

```tsx
import { useEffect, useState } from 'react'
import { MUTED, ROW_BASE } from './ui'

export interface AppliedJobRow {
  id: number
  url: string
  canonicalUrl: string
  company: string | null
  jobTitle: string | null
  markedAt: string
}

/** A5: read-only v1. `load` resolves null on a host failure (App owns the banner). */
export function ApplicationsView({ load }: { load: () => Promise<AppliedJobRow[] | null> }) {
  const [jobs, setJobs] = useState<AppliedJobRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void load().then((rows) => { if (rows === null) setFailed(true); else setJobs(rows) })
  }, [])
  if (failed) return <p className={`mt-3 ${MUTED}`} data-jff-apps="error">Could not load your applications.</p>
  if (jobs === null) return <p className={`mt-3 ${MUTED}`} data-jff-apps="loading">Loading…</p>
  return (
    <section className="mt-3" data-jff-apps="1">
      <h2 className="mb-1 text-[13px] font-semibold">Applied jobs ({jobs.length})</h2>
      {jobs.length === 0 && <p className={MUTED}>Nothing marked applied yet.</p>}
      <ul className="m-0 grid list-none gap-2 p-0">
        {jobs.map((j) => (
          <li className={`${ROW_BASE} border-l-neutral-300 dark:border-l-neutral-600`} key={j.id}>
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold">{j.jobTitle ?? j.company ?? j.url}</span>
              <span className={`${MUTED} tabular-nums`}>{new Date(j.markedAt).toLocaleDateString()}</span>
            </div>
            {j.company !== null && <div className={`mt-0.5 ${MUTED}`}>{j.company}</div>}
            <a className="text-[12px] text-blue-700 underline dark:text-blue-300" href={j.url} target="_blank" rel="noreferrer">Open posting</a>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 4: Wire the three-view model in `App.tsx`.**
  - Replace `const [showEditor, setShowEditor] = useState(false)` with `const [view, setView] = useState<'session' | 'editor' | 'applications'>('session')`.
  - Replace every `setShowEditor(false)` with `setView('session')` and the actions-row toggle (inside `div[data-jff-actions]`) with:

```tsx
        <button type="button" className={BTN} onClick={() => setView((v) => (v === 'editor' ? 'session' : 'editor'))}>
          {view === 'editor' ? 'Back to fields' : 'Edit your facts'}
        </button>
        <button type="button" className={BTN} data-jff-nav-apps="1" onClick={() => setView((v) => (v === 'applications' ? 'session' : 'applications'))}>
          {view === 'applications' ? 'Back to fields' : 'Applications'}
        </button>
```

  - Loader:

```ts
  const loadApplications = async (): Promise<AppliedJobRow[] | null> => {
    const port = portRef.current
    if (port === null) return null
    const r = await port.request<{ jobs: AppliedJobRow[] }>('applied.list', {})
    if (!r.ok) { setHostError(ERROR_COPY[r.error.kind]); return null }
    // `?? []`: a fake/stale host answering {} must render the empty state,
    // never crash the view on `jobs.map`.
    return r.result.jobs ?? []
  }
```

  - Render: the `{showEditor ? <ProfileEditor…> : (<>…rows…</>)}` ternary becomes a three-way switch — `view === 'editor'` → ProfileEditor, `view === 'applications'` → `<ApplicationsView load={loadApplications} />`, else the session markup. The Save-answers row and save-preview stay inside the SESSION arm only (they describe session state).
  - Add a `data-jff-view={view}` attribute on the root `<main>`.

- [ ] **Step 5: Write + run the mutual-exclusion test** — append to `App.test.tsx`:

```tsx
describe('App — three-view navigation (A5)', () => {
  it('session, facts editor and applications are mutually exclusive', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Applications' }))
    await waitFor(() => expect(document.querySelector('[data-jff-apps]')).not.toBeNull())
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    expect(document.querySelector('[data-jff-editor]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => expect(document.querySelector('[data-jff-editor]')).not.toBeNull())
    expect(document.querySelector('[data-jff-apps]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to fields' }))
    await waitFor(() => expect(document.querySelector('[data-jff-rows]')).not.toBeNull())
  })
})
```

Run: `npx vitest run extension/src/panel` — ALL PASS (pre-existing `showEditor` tests: any referencing the old toggle get the mechanical rename — FIX-AND-REPORT).

- [ ] **Step 6:** `npm run typecheck && npm run lint` — clean.

- [ ] **Step 7: Commit**

```bash
git add extension/src/panel
git commit -m "feat(applied): applications list view + three-view header navigation (A5)"
```

---

### Task 9: C2 — Greenhouse react-select: pointer open gesture + committed-text fallback

**Files:**
- Modify: `extension/src/content/fill.ts` (open step + verification tail of `fillCombobox`, two new helpers — locate by content)
- Modify: `extension/src/content/fill.test.ts`

**Interfaces:**
- Consumes: the C1 spike's proven recipe (spec §Design C — binding): (1) react-select opens ONLY on the full synthetic sequence `pointerdown → mousedown → pointerup → mouseup → click` (el.click(), lone mousedown, ArrowDown, input-while-closed are all no-ops); `aria-controls` exists only while open, after which `attributableListbox` works as-is. (2) A successful commit CLEARS the input; the committed text lives in the widget's visible value container.
- Produces: `dispatchOpenGesture(el)` (replaces the bare open click); `commitScopeLeaves(input)` + `visibleCommittedText(input, optionTextNorm, preTexts)` (structural walk, NEVER react-select class names; listbox content excluded; hardened per plan review: only a VISIBLE node whose text CHANGED INTO the option's across the commit click counts — a pre-click snapshot of the scope's leaf texts feeds the comparison); and the amended verification: an EMPTY `input.value` post-commit consults the fallback before the verdict.
- Consumed by: Task 10 (e2e fixture), Task 19 (Degree dropdown on the real page).

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/content/fill.test.ts && npx vitest run && npm run typecheck && npm run lint`

**Boundaries:** B1a–B1d invariants untouched: typeahead always driven, unique-substring min-3-chars + two-poll settling, exact-equality verification against the CLICKED option, fail-closed restore order. Every EXISTING fill.test.ts test stays green (the gesture ends with a `click` event, so click-opened Ashby fixtures see exactly what they saw before). `fillChoice`, `fillSelect`, the BUTTON rail: byte-identical. Harvest's own open recipe is OUT of scope (harvest already degrades; the panel hints cover it).

- [ ] **Step 1: Write the failing tests** — append to `extension/src/content/fill.test.ts` (module scope already imports `fillOne`, `setNativeValue`):

```ts
describe('fillCombobox — Greenhouse react-select shape (C2)', () => {
  /** The C1-proven widget: opens ONLY once the full pointer+mouse gesture has
   *  arrived, filters on input, and on commit CLEARS the input while rendering
   *  the committed text in a sibling value container. A permanently-mounted
   *  hidden decoy listbox (the intl-tel-input country list) sits elsewhere. */
  function mountReactSelect(
    options: string[],
    { updateHolder = true, prefixFilter = false, hiddenHolder = false, staleText = null as string | null } = {},
  ): { input: HTMLInputElement } {
    document.body.innerHTML = `
      <ul role="listbox" id="decoy" style="display:none">
        ${options.map((o) => `<li role="option">${o}</li>`).join('')}
      </ul>
      <div id="control">
        ${staleText === null ? '' : `<span id="stale">${staleText}</span>`}
        <div id="value-holder"${hiddenHolder ? ' style="display:none"' : ''}></div>
        <input id="c" role="combobox" aria-haspopup="true">
      </div>`
    const input = document.getElementById('c') as HTMLInputElement
    const control = document.getElementById('control')!
    const seen = new Set<string>()
    let open = false
    const renderMenu = (): void => {
      document.getElementById('menu')?.remove()
      if (!open) { input.removeAttribute('aria-controls'); return }
      input.setAttribute('aria-controls', 'menu')
      const lb = document.createElement('ul')
      lb.id = 'menu'
      lb.setAttribute('role', 'listbox')
      const filter = input.value.trim().toLowerCase()
      // prefixFilter mirrors widgets whose own filtering is startsWith — the
      // page can then disambiguate what our substring ladder cannot.
      const match = (o: string): boolean =>
        prefixFilter ? o.toLowerCase().startsWith(filter) : o.toLowerCase().includes(filter)
      for (const t of options.filter(match)) {
        const li = document.createElement('li')
        li.setAttribute('role', 'option')
        li.textContent = t
        li.addEventListener('click', () => {
          // react-select commit: input CLEARED, value container updated, menu closed.
          input.value = ''
          if (updateHolder) document.getElementById('value-holder')!.textContent = t
          open = false
          renderMenu()
        })
        lb.appendChild(li)
      }
      control.appendChild(lb)
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      control.addEventListener(type, () => {
        seen.add(type)
        // Opens ONLY once the full gesture arrived (C1: el.click() alone and a
        // lone mousedown are both no-ops on the real widget).
        if (!open && ['pointerdown', 'mousedown', 'mouseup', 'click'].every((t) => seen.has(t))) {
          open = true
          renderMenu()
        }
      })
    }
    input.addEventListener('input', () => { if (open) renderMenu() })
    return { input }
  }

  it('opens via the pointer gesture, matches "oth" → "Other", and verifies through the value container', async () => {
    const { input } = mountReactSelect(['Associate', 'Bachelor', 'Master', 'Other'])
    await expect(fillOne(input, 'oth')).resolves.toEqual({ ok: true, committed: 'Other' })
    expect(document.getElementById('value-holder')!.textContent).toBe('Other')
    expect(input.value).toBe('')
  }, 10_000)

  it('drives the typeahead when the mounted list is ambiguous: page-side prefix filtering disambiguates', async () => {
    // 'oth' is a substring of BOTH Other and Another, so the open-click poll
    // fails on ambiguity; typing lets the widget's own (prefix) filter shrink
    // the list to exactly Other — the B1a leg through the new open gesture.
    const { input } = mountReactSelect(['Another', 'Other'], { prefixFilter: true })
    await expect(fillOne(input, 'oth')).resolves.toEqual({ ok: true, committed: 'Other' })
    expect(document.getElementById('value-holder')!.textContent).toBe('Other')
  }, 10_000)

  it('never reads committed text out of a listbox (the decoy stays excluded)', async () => {
    // Sabotaged commit: the input clears but the value container never updates —
    // the only 'Other' text left on the page lives inside listboxes. The fill
    // must fail closed, not false-verify off the decoy.
    const { input } = mountReactSelect(['Associate', 'Bachelor', 'Master', 'Other'], { updateHolder: false })
    await expect(fillOne(input, 'oth')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(input.value).toBe('')
  }, 10_000)

  it('pre-existing text that merely MATCHES the option never verifies a commit', async () => {
    // A '<span>Other</span>' sat in the walk scope from the start; the commit
    // clears the input but updates nothing. Text that did not CHANGE INTO the
    // option is not evidence the widget committed anything.
    const { input } = mountReactSelect(['Associate', 'Bachelor', 'Master', 'Other'], { updateHolder: false, staleText: 'Other' })
    await expect(fillOne(input, 'oth')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
  }, 10_000)

  it('a HIDDEN value container never verifies a commit', async () => {
    // The holder receives the committed text but is display:none — invisible
    // text is not the page-visible commit the verification promises.
    const { input } = mountReactSelect(['Associate', 'Bachelor', 'Master', 'Other'], { hiddenHolder: true })
    await expect(fillOne(input, 'oth')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
  }, 10_000)
})
```

(A "non-empty input.value stays authoritative" test is deliberately NOT added: the existing session-7 test `'selects a UNIQUE substring match and reports the committed canonical text'` already pins exactly that path — the commit writes the input back and the verdict reads it. It must stay green through this task; a near-identical duplicate would be pure noise.)

- [ ] **Step 2: Run to see the RED** — `npx vitest run extension/src/content/fill.test.ts -t 'react-select'` — all five FAIL today (the widget never opens on the click-only gesture → `combobox-no-listbox`; the stale-text and hidden-holder tests additionally pin rules a naive fallback would get wrong once the gesture lands).

- [ ] **Step 3: Implement in `fill.ts`.**
  - Add the helpers directly ABOVE `fillCombobox`:

```ts
/**
 * C2: react-select (Greenhouse) opens its menu ONLY on a real pointer gesture —
 * el.click() alone, a lone synthetic mousedown, ArrowDown and a native-setter
 * input while closed are all no-ops (C1 spike, proven live on the real Degree
 * widget). The full bubbling pointer+mouse sequence is what a trusted user
 * press produces; widgets that open on a plain click (Ashby) see their click
 * at the end of the sequence, so the old behavior is a strict subset.
 * PointerEvent falls back to MouseEvent where the environment lacks it (jsdom)
 * — listeners dispatch by TYPE, so the constructor difference is inert.
 */
function dispatchOpenGesture(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true } as const
  const pointer = (type: string): Event =>
    typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, opts)
  el.dispatchEvent(pointer('pointerdown'))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(pointer('pointerup'))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
}

/** The candidate leaves the commit fallback may read: every childless element
 *  within ≤5 ancestor levels of the input, excluding the input itself and
 *  anything inside ANY listbox (menu remnants and the page's permanently-
 *  mounted intl-tel-input decoy included). */
function commitScopeLeaves(input: HTMLInputElement): HTMLElement[] {
  // A Set: each ancestor's querySelectorAll re-visits the levels below it, and
  // without dedupe every leaf would be collected (and style-walked) up to 5×.
  const out = new Set<HTMLElement>()
  let scope: Element | null = input.parentElement
  for (let depth = 0; scope !== null && depth < 5; depth++, scope = scope.parentElement) {
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
      if (node === input || node.closest('[role="listbox"]') !== null) continue
      if (node.children.length === 0) out.add(node)
    }
  }
  return [...out]
}

/** Computed-style walk, NOT offsetParent/rects: jsdom renders no layout (every
 *  rect is zero), and display:none / visibility:hidden — plus the `hidden`
 *  attribute and aria-hidden — are exactly what the decoy and closed-menu
 *  remnants wear in both environments. */
const isDisplayHidden = (node: HTMLElement): boolean => {
  for (let el: HTMLElement | null = node; el !== null; el = el.parentElement) {
    if (el.hidden === true || el.getAttribute('aria-hidden') === 'true') return true
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return true
  }
  return false
}

/**
 * C2: react-select commits by CLEARING its input and rendering the committed
 * text in a sibling value container (.select__single-value on the real page —
 * but the walk is STRUCTURAL, never class-named). Hardened two ways (plan
 * review): the node must be VISIBLE, and its text must have CHANGED INTO the
 * option's across the commit click — pre-existing page text that merely
 * matches ('Other', 'Yes', …) is not evidence the widget committed anything.
 * A node absent from the pre-click snapshot is a fresh value render and counts.
 */
function visibleCommittedText(
  input: HTMLInputElement,
  optionTextNorm: string,
  preTexts: WeakMap<HTMLElement, string>,
): string | null {
  for (const node of commitScopeLeaves(input)) {
    if (isDisplayHidden(node)) continue
    const text = node.textContent ?? ''
    if (norm(text) !== optionTextNorm) continue
    const before = preTexts.get(node)
    if (before !== undefined && norm(before) === optionTextNorm) continue
    return text.trim()
  }
  return null
}
```

  - In `fillCombobox`, replace the open click line

```ts
  ;(el as HTMLElement).click()
```

  with

```ts
  // C2: the full pointer+mouse open gesture, dispatched on the control itself
  // (bubbling from the input reaches the react-select control wrapper).
  if (el instanceof HTMLElement) dispatchOpenGesture(el)
```

  - Replace the commit-and-verify tail (the block starting `const optionText = norm(hit.textContent ?? '')` through the final `return`) with:

```ts
  const optionText = norm(hit.textContent ?? '')
  // C2 hardening: snapshot the candidate leaves' texts BEFORE the commit
  // click, so the fallback can demand a CHANGE into the option text.
  const preTexts = new WeakMap<HTMLElement, string>()
  if (input !== null) {
    for (const node of commitScopeLeaves(input)) preTexts.set(node, node.textContent ?? '')
  }
  hit.click()
  await nextFrame()
  let committed = input !== null ? input.value : (el.textContent ?? '').trim()
  // C2 (Greenhouse): a successful react-select commit leaves input.value EMPTY
  // — the committed text lives in the widget's visible value container. Only
  // an EMPTY input consults the structural fallback; a non-empty input.value
  // stays authoritative, so the Ashby arm's verification is untouched (B1c).
  if (input !== null && committed === '') {
    committed = visibleCommittedText(input, optionText, preTexts) ?? ''
  }
  if (norm(committed) !== optionText) return failClosed('no-matching-option')
  return { ok: true, committed: committed === value ? null : committed }
```

- [ ] **Step 4: Run the fill tests, then the whole suite** — `npx vitest run extension/src/content/fill.test.ts && npx vitest run` — ALL PASS, including every session-7 combobox test.

- [ ] **Step 5: Verify the BUTTON rail is byte-identical** — `git diff -U0 extension/src/content/fill.ts | grep '^[+-].*unsupported-widget'` — EMPTY output.

- [ ] **Step 6:** `npm run typecheck && npm run lint` — clean.

- [ ] **Step 7: Commit**

```bash
git add extension/src/content/fill.ts extension/src/content/fill.test.ts
git commit -m "fix(fill): react-select open gesture + committed-text fallback to the visible value container (C2)"
```

---

### Task 10: C3 — Greenhouse-shaped e2e fixture + regression spec

**Files:**
- Create: `e2e/fixtures/greenhouse-apply/react-select-form.html`
- Modify: `e2e/foundation.spec.ts` (one appended test, following that file's inject/JFF_SCAN/JFF_FILL harness — see the `a fill carrying a stale epoch is rejected` test at `e2e/foundation.spec.ts:114` for the driving pattern)

**Interfaces:**
- Consumes: Task 9's fill behavior; the existing `startFixtureServer` (pass `'fixtures/greenhouse-apply'` root — the new file lands beside `fixture-form.html`), `launchWithExtension`, the extension-origin relay-driving pattern.
- Produces: an in-browser regression proving the C2 recipe end-to-end: gesture-gated open, typeahead filter, commit-clears-input, value-container verification, decoy exclusion.

**Model:** integrator-opus-high — browser/timing judgment; the fixture below is binding, the spec-test plumbing may be adapted to the harness (FIX-AND-REPORT any deviation).

**Verify:** `JFF_TEST_SEAM=1 npm run build && npx playwright test e2e/foundation.spec.ts -g 'react-select'` — the SCOPED filter only. After Task 3 the seam-built panel gates on onboarding (no stored resume exists in the extension-origin IndexedDB until Task 17's `seedResume`), so foundation's panel-mount tests (`:164-207`) render OnboardingView and are knowingly red until Task 17 — the full file CANNOT go green here. Then `npm run build` (plain dist back).

- [ ] **Step 1: Create the fixture** — `e2e/fixtures/greenhouse-apply/react-select-form.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>react-select degree fixture</title>
<body>
<form>
  <label for="degree-input">Degree</label>
  <div id="degree-control">
    <div id="degree-value"></div>
    <div><input id="degree-input" role="combobox" aria-haspopup="true" aria-expanded="false" autocomplete="off"></div>
  </div>
</form>
<!-- Permanently-mounted decoy: the intl-tel-input country listbox (244 options). -->
<ul role="listbox" id="country-decoy" style="display:none"></ul>
<script>
  // 'Another' + 'Other' + prefix filtering mirror the unit suite's typeahead-leg
  // case: 'oth' is ambiguous on the mounted list, so the fill must TYPE and let
  // the widget's own filter disambiguate (plan review N2).
  const OPTIONS = ['Another', 'Associate', 'Bachelor', 'Doctorate', 'Master', 'Other']
  const decoy = document.getElementById('country-decoy')
  for (let i = 0; i < 244; i++) {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.textContent = i === 0 ? 'Other' : 'Country ' + i
    decoy.appendChild(li)
  }
  const input = document.getElementById('degree-input')
  const control = document.getElementById('degree-control')
  const seen = new Set()
  let open = false
  function renderMenu() {
    const old = document.getElementById('degree-menu')
    if (old) old.remove()
    if (!open) { input.removeAttribute('aria-controls'); input.setAttribute('aria-expanded', 'false'); return }
    input.setAttribute('aria-controls', 'degree-menu')
    input.setAttribute('aria-expanded', 'true')
    const lb = document.createElement('ul')
    lb.id = 'degree-menu'
    lb.setAttribute('role', 'listbox')
    const filter = input.value.trim().toLowerCase()
    for (const t of OPTIONS.filter((o) => o.toLowerCase().startsWith(filter))) {
      const li = document.createElement('li')
      li.setAttribute('role', 'option')
      li.textContent = t
      li.addEventListener('click', () => {
        input.value = ''
        document.getElementById('degree-value').textContent = t
        open = false
        renderMenu()
      })
      lb.appendChild(li)
    }
    // Portal-style: the menu mounts at document.body, like real react-select.
    document.body.appendChild(lb)
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    control.addEventListener(type, () => {
      seen.add(type)
      if (!open && ['pointerdown', 'mousedown', 'mouseup', 'click'].every((t) => seen.has(t))) {
        open = true
        renderMenu()
      }
    })
  }
  input.addEventListener('input', () => { if (open) renderMenu() })
</script>
</body>
```

- [ ] **Step 2: Write the failing spec test** — append to `e2e/foundation.spec.ts`, following the file's existing launch + fixture-server + extension-origin relay pattern. Parameterize the file's fixture-opening helper as `openFixtureTab(file = 'fixture-form.html')` — thread the parameter through both the `goto` and the `chrome.tabs.query` URL glob — so the five existing callers stay unchanged and this test opens `react-select-form.html` through the same path:

```ts
test('the Greenhouse react-select shape fills through the gesture + value-container recipe (C2/C3)', async () => {
  // Drive JFF_SCAN then JFF_FILL('oth') at the react-select fixture through the
  // relay (the stale-epoch test above is the pattern). Assert:
  //  1. the fill reply's `filled` entry carries committed: 'Other';
  //  2. on the PAGE, #degree-value reads 'Other' and #degree-input is empty;
  //  3. the decoy listbox is untouched (still 244 options, still hidden);
  //  4. no console errors.
})
```

(The body is the integrator's to write against the real harness; the four assertions are binding.)

- [ ] **Step 3: Prove the fixture catches the ORIGINAL bug (RED-proof).** Task 9's fix is already committed, so the new spec cannot demonstrate RED against the current tree — without this step it never proves it would have caught the C1 bug. Temporarily restore the pre-Task-9 `fill.ts`:
  1. `git log --oneline -- extension/src/content/fill.ts` — identify Task 9's commit (message `fix(fill): react-select open gesture…`); call its sha `<task9>`.
  2. `git show <task9>^:extension/src/content/fill.ts > extension/src/content/fill.ts`
  3. `JFF_TEST_SEAM=1 npm run build && npx playwright test e2e/foundation.spec.ts -g 'react-select'` — expected: **FAIL** (the widget never opens on the old click-only gesture; the fill reports `combobox-no-listbox` — the fixture catches the original bug).
  4. `git checkout HEAD -- extension/src/content/fill.ts` — `git status` must show `fill.ts` clean again.

- [ ] **Step 4: Run GREEN, scoped** — `JFF_TEST_SEAM=1 npm run build && npx playwright test e2e/foundation.spec.ts -g 'react-select'` — expected: **PASS**. Do NOT run the unfiltered file: its panel-mount tests are knowingly red until Task 17 (see Verify above); an unrelated failure there is not this task's signal.

- [ ] **Step 5: Restore the plain dist** — `npm run build && grep -rl 'JFF_TEST_SEAM' extension/dist | wc -l` → `0`.

- [ ] **Step 6: Commit**

```bash
git add e2e/fixtures/greenhouse-apply/react-select-form.html e2e/foundation.spec.ts
git commit -m "test(e2e): Greenhouse react-select fixture — gesture-gated open, commit-clears-input, decoy listbox (C3)"
```

---

### Task 11: S8 — retire the clear-on-activate era tests (ONE batch)

**Files:**
- Delete: `extension/src/panel/tabScope.test.ts`
- Modify: `extension/src/panel/App.test.tsx` (two test deletions)

**Interfaces:** none produced. This batch removes tests whose ASSERTED BEHAVIOR the S slices invert, so Tasks 14–16 never trip over era tests mid-slice (standing rule: stale tests are a pre-slice batch). The session-aware replacements are Task 14–16's plan-authored acceptance tests; the `data-jff-resets` hook has NO e2e consumer (verified at plan time: only `App.tsx` renders it; `App.test.tsx:440` asserts `data-jff-scans` only, which SURVIVES) and dies with `resetCount` in Task 14.

**Model:** editor-opus-low — pure deletion by enumerated list.

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

- [ ] **Step 1:** `git rm extension/src/panel/tabScope.test.ts` — the module it tests is deleted in Task 14; its behavior contract (clear on activate/navigate/remove) is the exact behavior S2/S4/S5 replace.
- [ ] **Step 2:** In `App.test.tsx`, DELETE these two tests (locate by title, remove the full `it(...)` blocks):
  - `'leaves the status line blank after a tab switch mid-scan, never superseded'` — asserts the activated-tab CLEAR (its comment: "'activated' never replays a scan (the tab that scanned is not the one that…"); Task 14/16 replace it with session-swap + settling-write routing tests.
  - `'clears a GUESSED company on navigation so the next employer is guessed fresh'` — S4 inverts this: within a session, a same-site wizard step KEEPS the company; cross-site parking (not clearing) handles the employer boundary. Task 15's acceptance suite covers the replacement.
- [ ] **Step 3:** Do NOT touch: `'keeps a company the user typed across a navigation'`, `'never lets a dead scan company guess name the live page employer'`, `'replays a navigation trigger the scan guard swallowed'`, `'drops the results of a scan whose page navigated away mid-flight'`, and every other generation-discipline test — those assert invariants that survive into the session era (Tasks 14–16 adapt their harnesses if needed, FIX-AND-REPORT).
- [ ] **Step 4:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint` — green (fewer tests, zero failures). Record the new test count.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(panel): retire clear-on-activate era tests in one batch before the session slices (S8)"
```

---

### Task 12: S1/S5/S6 — the `sessions` module family (pure, App-free)

**Files:**
- Modify: `shared/src/norm.ts` (gains `normalizeQuestion` — folded into the EXISTING normalization module, no new file), `host/src/resolve/normalize.ts`
- Create: `extension/src/sessionKey.ts`, `extension/src/sessionKey.test.ts`
- Create: `extension/src/panel/site.ts`, `extension/src/panel/site.test.ts`
- Create: `extension/src/panel/sessions.ts`, `extension/src/panel/sessions.test.ts`

**Interfaces:**
- Produces (all consumed by Tasks 14–16):
  - `normalizeQuestion` moves to `@jff/shared` (S4 keys panel-side answers with it). `host/src/resolve/normalize.ts` becomes `export { normalizeQuestion } from '@jff/shared'` plus the UNCHANGED `detectLanguage` (now importing `normalizeQuestion` from `@jff/shared`) — every host import site (`./resolve/normalize.js`) keeps working, every host normalize test stays green UNCHANGED.
  - `sessionKey(tabId): string` = `jff:session:<tabId>`, `SESSION_KEY_RE` — exported beside `snapshotKey.ts`, provably disjoint from `SNAPSHOT_KEY_RE`.
  - `registrableDomain(url): string`, `sameSite(a, b): boolean` — minimal suffix heuristic (full PSL out of scope by spec).
  - `Session` (version 1) — the EXHAUSTIVE per-session persisted partition (spec table, binding):

```ts
export const SESSION_VERSION = 1
export const MAX_PERSISTED_OPTIONS = 100
export type AnswerProvenance = 'user' | 'generated'
export interface SessionAnswer { value: string; provenance: AnswerProvenance; fieldKey: FieldKey | null }

export interface Session {
  version: 1
  tabId: number
  /** registrableDomain(startUrl); '' until the first settled scan. */
  site: string
  /** The FIRST scanned page — applied.mark's url (A2). '' until captured. */
  startUrl: string
  parked: boolean
  createdAt: number
  /** Per-session epoch counter (S7). Clock-seeded like App's old epochRef. */
  epoch: number
  fields: EnumField[]
  resolutions: Resolution[]
  edits: Record<string, string>
  /** S4: normalizeQuestion(label) → answer. The ref-INDEPENDENT carry. */
  answers: Record<string, SessionAnswer>
  company: string
  companyGuessed: boolean
  jobText: string
  snapshot: Record<string, string>
  reuseOverrides: Record<string, 'reusable' | 'company_specific'>
  filledRefs: string[]
  generatedRefs: string[]
  unreachable: number
  activeCaptcha: boolean
  election: ElectionOutcome | null
  frameReports: FrameReport[]
  lastOutcome: ScanUiState | null
  appliedHit: { markedAt: string } | null
}
```

  - `newSession(tabId: number, startUrl = ''): Session` — the default `''` is the LAZILY-created case (a tab with no scan yet: `site: ''` until the first settled scan captures both); an explicit url is the "already scanned" case. `capForStorage(s): Session` (every `fields[].options` sliced to `MAX_PERSISTED_OPTIONS`), `parseStoredSession(raw): Session | null` (version-mismatch or structurally corrupt → null, never throws), `answerKey(label) = normalizeQuestion(label)`.
  - `SESSION_SAVE_DEBOUNCE_MS = 500` — EXPORTED as the default debounce (not prose-only); `createSessionStore(area?, debounceMs?, opts?: { onWarn?: () => void; getDisplayedTabId?: () => number | null })` → `SessionStore`:

```ts
export interface SessionStore {
  /** Pending-first read-your-writes — and it runs on the STORE LOCK (below),
   *  so a load issued during an in-flight mutate observes the mutated row. */
  load(tabId: number): Promise<Session | null>
  /** Only rows whose key matches SESSION_KEY_RE — the storage area is shared
   *  with jff:snap:* rows, which are not ours to read (or prune). */
  loadAll(): Promise<Session[]>
  /** Debounced latest-wins per tab. Rows pass capForStorage at ENTRY, so the
   *  pending map and storage always agree on shape. A save against a
   *  TOMBSTONED tab is silently dropped (see below). */
  save(session: Session): void
  /**
   * THE way concurrent/settling writers touch a session they do not display
   * (Task 16). ONE link on the store lock: read pending-first, apply fn, drop
   * the tab's pending entry, write through capForStorage — with NO await
   * between the read and the pending-drop. Returns the row actually WRITTEN
   * (a caller that turns out to be displaying this tab re-projects the display
   * from it — the swap-race repair), or null when fn dropped. A mutate against
   * a TOMBSTONED tab resolves null without running fn. Quota failure inside
   * mutate follows the same policy as save: evict-and-retry once, else the
   * merged row parks in pending + onWarn.
   */
  mutate(tabId: number, fn: (s: Session | null) => Session | null): Promise<Session | null>
  /** Fires after EVERY successful storage write (save-flush or mutate), with
   *  the written row. Subscribers are notified AFTER the lock link releases,
   *  are NEVER awaited, and each runs in its own try/catch — a throwing
   *  subscriber cannot reject the chain, and a subscriber that calls back
   *  into the store enqueues a FRESH link (no deadlock; reentrancy test).
   *  Task 16 subscribes: a write for the currently-displayed tabId re-projects
   *  the display. Returns an unsubscribe. */
  onWrite(cb: (tabId: number, s: Session) => void): () => void
  /** Resolves only when every pending row is written AND every already-queued
   *  lock link has settled — a flush cannot outrun an in-flight mutate. */
  flush(): Promise<void>
  /** Drops the tab's PENDING row, deletes the stored row, and TOMBSTONES the
   *  tabId — all on the store lock, so a remove issued during an in-flight
   *  mutate or flush wins (no resurrection). */
  remove(tabId: number): Promise<void>
  /** Per-key delete on the store lock; deleted tabs are tombstoned and their
   *  pending rows dropped; keys not matching SESSION_KEY_RE are untouched. */
  prune(liveTabIds: ReadonlySet<number>): Promise<void>
}
```

    **ONE global FIFO storage-operation lock** (adjudicated simplification — this REPLACES the earlier per-tab lock): every storage-touching operation — `load`, `loadAll`, the save-flush write, `mutate`, `remove`, `prune`'s deletes, and the quota-eviction sequence (candidate selection + delete + retry, as ONE link) — enqueues on a single internal promise chain. The per-tab pending map stays, but only for debouncing. Rationale (recorded per adjudication): strictly more conservative than per-tab locking — no concurrency that matters is lost (every operation is a sub-millisecond storage call plus pure functions, and there is one human user), it is trivially deadlock-free, and the cross-tab eviction and two-tab interleaving problems vanish as a CLASS instead of needing per-case lock ordering. This is what makes "remove during an in-flight mutate/flush wins", "flush never clobbers a superseding mutate", "a mutate during a flush reads the flushed row", and "load observes the in-flight mutate's result" true — the Step-5 tests pin all of them.
    **Tombstones:** `remove()` and `prune`'s deletes add the tabId to a permanent in-store `Set<number>`; a later `save()` for that tab is DROPPED (no pending re-creation) and a later `mutate()` resolves null without running `fn` — a stale displayed-state save landing after the tab closed must never resurrect the dead row. The set is never cleared, deliberately: Chrome does not reuse tab ids within a browser session, and the store dies with the panel.
    Quota/`set` failure policy (S6): evict the oldest PARKED stored session (by `createdAt`) — EXCLUDING the session being written AND the currently-displayed session per `opts.getDisplayedTabId` — and retry ONCE; an eviction also calls `onWarn` (it is the one data-loss path, and the user must see it). With NO eviction candidate, KEEP the row in the in-memory pending map (the next flush retries it) and call `onWarn` — the write is deferred, never silently discarded. Storage growth is per-tab-visited (the mount auto-scan creates sessions lazily); that is accepted, and this quota policy is what absorbs it.

**Model:** implementer-opus-medium.

**Verify:** `npm run build -w @jff/shared && npx vitest run extension/src shared host && npm run typecheck && npm run lint`

**Boundaries:** NO App.tsx changes (Task 14 wires). NO chrome globals inside `sessions.ts` except the default parameter (`area = chrome.storage.session`) — every function takes its dependencies, tests pass a fake area.

- [ ] **Step 1: Move `normalizeQuestion` to shared.** Append to `shared/src/norm.ts` the EXACT block currently at `host/src/resolve/normalize.ts:1-21` (`MAX_NORMALIZED` + `normalizeQuestion`, comments included) — `norm.ts` is the existing one-normalization-module and is already `export * from './norm.js'`-ed by `shared/src/index.ts`, so no index change. Rewrite `host/src/resolve/normalize.ts` to:

```ts
import { normalizeQuestion } from '@jff/shared'

export { normalizeQuestion } from '@jff/shared'

// Matched against normalizeQuestion() output, which is ACCENT-STRIPPED: every hint
// must be written unaccented or it can never match ("vocês" would be dead code).
const PT_HINTS = /\b(voce|voces|qual|quais|sua|seu|suas|seus|por que|porque|experiencia|salario|pretensao|trabalh\w*|empresa|cargo|nome|sobrenome|telefone|endereco|disponibilidade|contratacao)\b/

/** Deliberately dumb: two languages, stopword hit or fall back to English. */
export function detectLanguage(s: string): 'en' | 'pt' {
  const n = normalizeQuestion(s)
  if (n.length === 0) return 'en'
  return PT_HINTS.test(n) ? 'pt' : 'en'
}
```

Run `npm run build -w @jff/shared && npx vitest run host` — every existing host test green, UNCHANGED.

- [ ] **Step 2: Write the failing key/site tests.**

`extension/src/sessionKey.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sessionKey, SESSION_KEY_RE } from './sessionKey'
import { snapshotKey, SNAPSHOT_KEY_RE } from './snapshotKey'

describe('sessionKey (S1)', () => {
  it('round-trips the tabId', () => {
    expect(SESSION_KEY_RE.exec(sessionKey(12))![1]).toBe('12')
  })
  it('session keys and snapshot keys are DISJOINT — no code path can mistake one row for the other', () => {
    expect(SNAPSHOT_KEY_RE.test(sessionKey(7))).toBe(false)
    expect(SESSION_KEY_RE.test(snapshotKey(7, 0))).toBe(false)
  })
})
```

`extension/src/panel/site.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { registrableDomain, sameSite } from './site'

describe('registrableDomain / sameSite (S5)', () => {
  it.each([
    ['https://jobs.acme.com/apply', 'acme.com'],
    ['https://careers.acme.com/x', 'acme.com'],
    ['https://acme.com/', 'acme.com'],
    ['https://www.trmlabs.com/careers?ashby_jid=1', 'trmlabs.com'],
    ['https://job-boards.greenhouse.io/x/jobs/1', 'greenhouse.io'],
    ['https://foo.bar.co.uk/x', 'bar.co.uk'],
    ['https://empresa.com.br/vagas', 'empresa.com.br'],
    ['not a url', ''],
  ])('%s → %s', (url, domain) => {
    expect(registrableDomain(url)).toBe(domain)
  })

  it('sameSite: subdomains of one registrable domain match; unparseable never matches', () => {
    expect(sameSite('https://jobs.acme.com/a', 'https://careers.acme.com/b')).toBe(true)
    expect(sameSite('https://acme.com', 'https://acme.io')).toBe(false)
    expect(sameSite('', '')).toBe(false)
  })
})
```

Run both — FAIL (no modules).

- [ ] **Step 3: Create `extension/src/sessionKey.ts`:**

```ts
/** storage.session key for the per-tab application session (S1). Lives beside
 *  snapshotKey.ts on purpose: the two regexes partition the jff:* namespace,
 *  and the disjointness is TESTED — no code path may treat an unrecognized row
 *  as a snapshot (or a session). */
export const sessionKey = (tabId: number): string => `jff:session:${tabId}`
export const SESSION_KEY_RE = /^jff:session:(\d+)$/
```

- [ ] **Step 4: Create `extension/src/panel/site.ts`:**

```ts
/** Country-code second-level labels under which the registrable domain is one
 *  label deeper (minimal suffix heuristic — full PSL is out of scope, spec S5). */
const SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

/** S5: "same site" = same registrable domain. jobs.acme.com and careers.acme.com
 *  are one application (SSO hops within a company stay same-site); acme.com and
 *  okta.com are a detour worth PARKING for, not destroying. */
export function registrableDomain(url: string): string {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return '' }
  const parts = host.split('.').filter((p) => p !== '')
  if (parts.length <= 2) return parts.join('.')
  const tld = parts[parts.length - 1]!
  const sld = parts[parts.length - 2]!
  const take = SECOND_LEVEL.has(sld) && tld.length === 2 ? 3 : 2
  return parts.slice(-take).join('.')
}

export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a)
  return da !== '' && da === registrableDomain(b)
}
```

Run Step-2 tests — PASS.

- [ ] **Step 5: Write the failing sessions tests** — create `extension/src/panel/sessions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnumField } from '@jff/shared'
import { sessionKey } from '../sessionKey'
import {
  answerKey, capForStorage, createSessionStore, MAX_PERSISTED_OPTIONS,
  newSession, parseStoredSession, SESSION_VERSION, type Session,
} from './sessions'

interface Hold { on: boolean; release: () => void }

/** Deferrable fake area: `holdNextGet`/`holdNextSet` park the NEXT get/set on a
 *  promise until `release()` — how the lock tests interleave a second store
 *  call mid-flight. Tests `await drain()` after starting the in-flight op so
 *  the hold is actually armed before releasing. */
function fakeArea(): {
  rows: Record<string, unknown>
  area: Parameters<typeof createSessionStore>[0]
  failNextSet: { on: boolean }
  holdNextGet: Hold
  holdNextSet: Hold
} {
  const rows: Record<string, unknown> = {}
  const failNextSet = { on: false }
  const holdNextGet: Hold = { on: false, release: () => {} }
  const holdNextSet: Hold = { on: false, release: () => {} }
  const gate = async (h: Hold): Promise<void> => {
    if (!h.on) return
    h.on = false
    await new Promise<void>((r) => { h.release = r })
  }
  const area = {
    get: vi.fn(async (q: string | string[] | null) => {
      await gate(holdNextGet)
      if (q === null) return { ...rows }
      const keys = Array.isArray(q) ? q : [q]
      return Object.fromEntries(keys.filter((k) => k in rows).map((k) => [k, rows[k]]))
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await gate(holdNextSet)
      if (failNextSet.on) { failNextSet.on = false; throw new Error('QUOTA_BYTES quota exceeded') }
      Object.assign(rows, items)
    }),
    remove: vi.fn(async (keys: string | string[]) => { for (const k of [keys].flat()) delete rows[k] }),
  } as unknown as Parameters<typeof createSessionStore>[0]
  return { rows, area, failNextSet, holdNextGet, holdNextSet }
}

/** Two microtask turns — enough for an in-flight store call to reach its held
 *  get/set before the test releases it. */
const drain = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

const field = (fid: number, options: string[] = []): EnumField => ({
  frameId: 0, fid, epoch: 1, label: `F${fid}`, name: null, idAttr: null, kind: 'combobox',
  options, required: false, visible: true, currentValue: null, demographic: false,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('sessions module (S1/S6)', () => {
  it('save is debounced latest-wins; flush writes NOW', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    const s = newSession(7, 'https://jobs.acme.com/apply')
    store.save({ ...s, company: 'v1' })
    store.save({ ...s, company: 'v2' })
    expect(rows[sessionKey(7)]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(500)
    expect((rows[sessionKey(7)] as Session).company).toBe('v2')
    store.save({ ...s, company: 'v3' })
    await store.flush()
    expect((rows[sessionKey(7)] as Session).company).toBe('v3')
  })

  it('load round-trips; a version-mismatched row is dropped; corrupt rows never throw', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    const s = newSession(7, 'https://jobs.acme.com/apply')
    store.save(s)
    await store.flush()
    expect(await store.load(7)).toMatchObject({ tabId: 7, site: 'acme.com', version: SESSION_VERSION })
    rows[sessionKey(8)] = { ...s, tabId: 8, version: 99 }
    expect(await store.load(8)).toBeNull()
    rows[sessionKey(9)] = 'garbage'
    expect(await store.load(9)).toBeNull()
    expect((await store.loadAll()).map((x) => x.tabId)).toEqual([7])
  })

  it('remove cancels the pending debounced write', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save(newSession(7, 'https://a.com'))
    await store.remove(7)
    await vi.advanceTimersByTimeAsync(1000)
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('prune drops sessions whose tab is gone', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(1, 'https://a.com')); store.save(newSession(2, 'https://b.com'))
    await store.flush()
    await store.prune(new Set([2]))
    expect(Object.keys(rows)).toEqual([sessionKey(2)])
  })

  it('persisted options are capped at 100 per field; the in-memory session is untouched', () => {
    const big = newSession(7, 'https://a.com')
    big.fields = [field(0, Array.from({ length: 250 }, (_, i) => `o${i}`))]
    const capped = capForStorage(big)
    expect(capped.fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
    expect(big.fields[0]!.options.length).toBe(250)
  })

  it('the cap applies through save AND mutate — pending and stored rows always agree', async () => {
    // A background scan settle (Task 16) writes via mutate; without capping at
    // BOTH entries, a pending-first load could surface an uncapped row.
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await store.mutate(7, (s) => (s === null ? null : {
      ...s, fields: [field(0, Array.from({ length: 250 }, (_, i) => `o${i}`))],
    }))
    expect((rows[sessionKey(7)] as Session).fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
    expect((await store.load(7))!.fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
  })

  it('quota failure evicts the oldest PARKED session (warning the user) and retries; never the one being written', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const warn = vi.fn()
    const store = createSessionStore(area, 0, { onWarn: warn })
    const oldParked = { ...newSession(1, 'https://old.com'), parked: true, createdAt: 100 }
    const newerParked = { ...newSession(2, 'https://newer.com'), parked: true, createdAt: 200 }
    store.save(oldParked); store.save(newerParked)
    await store.flush()
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await store.flush()
    expect(rows[sessionKey(1)]).toBeUndefined()      // oldest parked evicted
    expect(rows[sessionKey(2)]).toBeDefined()
    expect(rows[sessionKey(7)]).toBeDefined()        // the write landed on retry
    expect(warn).toHaveBeenCalled()                  // eviction is data loss: never silent
  })

  it('eviction never targets the DISPLAYED session, even when parked', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const store = createSessionStore(area, 0, { getDisplayedTabId: () => 1 })
    store.save({ ...newSession(1, 'https://old.com'), parked: true, createdAt: 100 })
    store.save({ ...newSession(2, 'https://newer.com'), parked: true, createdAt: 200 })
    await store.flush()
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await store.flush()
    expect(rows[sessionKey(1)]).toBeDefined()        // displayed: protected
    expect(rows[sessionKey(2)]).toBeUndefined()      // next-oldest parked evicted instead
    expect(rows[sessionKey(7)]).toBeDefined()
  })

  it('quota failure with NO parked candidate warns, keeps the row PENDING, and the next flush retries it', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const warn = vi.fn()
    const store = createSessionStore(area, 0, { onWarn: warn })
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await expect(store.flush()).resolves.toBeUndefined() // never throws
    expect(rows[sessionKey(7)]).toBeUndefined()          // deferred, not stored yet…
    expect(warn).toHaveBeenCalledTimes(1)                // …and VISIBLY so
    await store.flush()                                  // area recovered: retry lands
    expect(rows[sessionKey(7)]).toBeDefined()
  })

  it('load during a pending debounced write sees the pending value (read-your-writes)', async () => {
    const { area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'pending-co' })
    expect((await store.load(7))!.company).toBe('pending-co')
  })

  it('two concurrent mutates for one tab both land (serialized, never last-writer-wins)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await Promise.all([
      store.mutate(7, (s) => (s === null ? null : { ...s, filledRefs: [...s.filledRefs, 'a'] })),
      store.mutate(7, (s) => (s === null ? null : { ...s, generatedRefs: [...s.generatedRefs, 'b'] })),
    ])
    const row = rows[sessionKey(7)] as Session
    expect(row.filledRefs).toContain('a')
    expect(row.generatedRefs).toContain('b')
  })

  it('mutate reads the PENDING row, writes through, and supersedes the stale debounce', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'from-display' })   // debounced, unflushed
    await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('from-display')  // the mutate SAW the pending row
    expect(row.jobText).toBe('from-settle')   // …and wrote through immediately
    await vi.advanceTimersByTimeAsync(1000)   // the old debounce must not clobber it
    expect((rows[sessionKey(7)] as Session).jobText).toBe('from-settle')
  })

  it('mutate on a missing session with fn returning null writes nothing and resolves null (the drop arm)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    await expect(store.mutate(42, (s) => s)).resolves.toBeNull()  // s === null → null → no write
    expect(rows[sessionKey(42)]).toBeUndefined()
  })

  it('mutate notifies onWrite with the written row (the display re-projection hook)', async () => {
    const { area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    const writes: [number, Session][] = []
    const off = store.onWrite((tabId, s) => writes.push([tabId, s]))
    const written = await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'x' }))
    expect(written!.jobText).toBe('x')
    expect(writes.some(([t, s]) => t === 7 && s.jobText === 'x')).toBe(true)
    off()
  })

  it('remove during an in-flight mutate wins — the row is never resurrected', async () => {
    const { rows, area, holdNextGet } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    holdNextGet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'late' }))
    await drain()
    const r = store.remove(7)   // enqueues BEHIND the in-flight mutate on the store lock
    holdNextGet.release()
    await Promise.all([m, r])
    expect(rows[sessionKey(7)]).toBeUndefined()  // the remove ran last: no resurrection
    // …and the tab is TOMBSTONED: even a later mutate that tries to rebuild the
    // session from scratch is refused.
    await expect(store.mutate(7, (s) => s ?? newSession(7))).resolves.toBeNull()
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('save after remove is dropped — a dead tab is never resurrected (tombstone)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await store.remove(7)
    store.save(newSession(7, 'https://a.com'))   // a stale displayed-state save after the tab closed
    await store.flush()
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('flush during an in-flight mutate does not clobber it', async () => {
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'old' })   // pending, unflushed
    holdNextSet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    await drain()
    const f = store.flush()     // must serialize behind the mutate's held write
    holdNextSet.release()
    await Promise.all([m, f])
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('old')             // the pending content the mutate consumed…
    expect(row.jobText).toBe('from-settle')     // …never clobbered back by the flush
  })

  it('load issued during an in-flight mutate observes the mutated row', async () => {
    const { area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    holdNextSet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'mutated' }))
    await drain()
    const l = store.load(7)     // enqueued on the same lock: sees the result
    holdNextSet.release()
    const [, row] = await Promise.all([m, l])
    expect(row!.jobText).toBe('mutated')
  })

  it('the INVERSE interleaving: a mutate arriving during an in-flight flush reads the flushed row and wins', async () => {
    // The mutate-first case above is not enough — a naive implementation that
    // only serializes mutates passes it. Here the stale-looking write is the
    // FLUSH, already in flight when the mutate arrives.
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'from-display' })  // pending
    holdNextSet.on = true
    const f = store.flush()     // the save-flush write is now in flight (held)
    await drain()
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    holdNextSet.release()
    await Promise.all([f, m])
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('from-display')  // the mutate read the FLUSHED row…
    expect(row.jobText).toBe('from-settle')   // …and the mutate's result is what stands
  })

  it('remove during an in-flight flush wins — the row is deleted, not resurrected', async () => {
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save(newSession(7, 'https://a.com'))
    holdNextSet.on = true
    const f = store.flush()
    await drain()
    const r = store.remove(7)   // queues behind the held write on the store lock
    holdNextSet.release()
    await Promise.all([f, r])
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('one flush lands every pending tab independently', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(1, 'https://a.com'), company: 'one' })
    store.save({ ...newSession(2, 'https://b.com'), company: 'two' })
    await store.flush()
    expect((rows[sessionKey(1)] as Session).company).toBe('one')
    expect((rows[sessionKey(2)] as Session).company).toBe('two')
  })

  it('an onWrite subscriber may call back into the store without deadlock (fresh link)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    let reentered: Promise<Session | null> | null = null
    const off = store.onWrite((tabId, s) => {
      if (tabId === 7 && s.jobText === 'first' && reentered === null) {
        // Same-tab reentrancy: this enqueues a FRESH lock link — notification
        // happens after the first link released, so this must not deadlock.
        reentered = store.mutate(7, (x) => (x === null ? null : { ...x, company: 'second' }))
      }
    })
    await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'first' }))
    await drain()
    await reentered
    expect((rows[sessionKey(7)] as Session).company).toBe('second')
    off()
  })

  it('loadAll and prune ignore foreign jff:snap rows sharing the storage area', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    rows['jff:snap:7:0'] = { epoch: 1, values: { 0: 'x' } }
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    expect((await store.loadAll()).map((s) => s.tabId)).toEqual([7])
    await store.prune(new Set<number>())
    expect(rows['jff:snap:7:0']).toBeDefined()   // snapshot rows are not ours to prune
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('answerKey is normalizeQuestion — accent/hyphen/case insensitive', () => {
    expect(answerKey('E-mail')).toBe(answerKey('email'))
    expect(answerKey('Por quê?')).toBe(answerKey('por que'))
  })
})
```

Run — FAIL (no module).

- [ ] **Step 6: Create `extension/src/panel/sessions.ts`** implementing the Interfaces contract above verbatim (types and the `SessionStore` interface as quoted, `newSession`'s `startUrl` defaulting to `''`; `answerKey` delegates to `normalizeQuestion` from `@jff/shared`; store internals — pending `Map<number, Session>`, one shared debounce timer, the single global FIFO storage-operation lock that `load`/`loadAll`/save-flush/`mutate`/`remove`/`prune`/eviction all enqueue on, the tombstone `Set<number>`, the `onWrite` subscriber list, the quota-eviction/deferral path — are the implementer's local choices as long as every Step-5 test passes; `newSession` seeds `epoch: Date.now()` and `createdAt: Date.now()`, both for the reason App's old `epochRef` was clock-seeded).

- [ ] **Step 7: Run everything** — `npm run build -w @jff/shared && npx vitest run extension/src shared host && npm run typecheck && npm run lint` — PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add shared/src host/src/resolve/normalize.ts extension/src/sessionKey.ts extension/src/sessionKey.test.ts extension/src/panel/site.ts extension/src/panel/site.test.ts extension/src/panel/sessions.ts extension/src/panel/sessions.test.ts
git commit -m "feat(sessions): Session v1 shape, debounced+flushable store, key-namespace disjointness, site heuristic; normalizeQuestion moves to shared (S1/S5/S6)"
```

---

### Task 13: S3 — `navSignals` module

**Files:**
- Create: `extension/src/panel/navSignals.ts`, `extension/src/panel/navSignals.test.ts`

**Interfaces:**
- Produces:

```ts
export const NAV_FALLBACK_DEDUPE_MS = 1500
export type NavEvent =
  | { type: 'navigated'; tabId: number; frameId: number; url: string }
  | { type: 'activated'; tabId: number }
  | { type: 'removed'; tabId: number }
export function createNavSignals(windowId: number, onEvent: (e: NavEvent) => void): () => void
```

- Consumed by: Task 14 (replaces `createTabScope`).

**Model:** implementer-opus-medium.

**Verify:** `npx vitest run extension/src/panel/navSignals.test.ts && npm run typecheck && npm run lint`

**Boundaries:** No App changes; `tabScope.ts` still exists until Task 14. The module reports RAW events for ALL tabs (the panel routes them to sessions); only `activated` is window-filtered here — a tab lives in exactly one window, so tabId-keyed state keeps a single writer.

- [ ] **Step 1: Write the failing tests** — create `extension/src/panel/navSignals.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNavSignals, NAV_FALLBACK_DEDUPE_MS, type NavEvent } from './navSignals'

type Listener = (...args: never[]) => void
interface FakeEvent { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
const ev = (): FakeEvent => ({ addListener: vi.fn(), removeListener: vi.fn() })

function installChrome(): Record<'committed' | 'history' | 'updated' | 'activated' | 'removed', FakeEvent> {
  const events = { committed: ev(), history: ev(), updated: ev(), activated: ev(), removed: ev() }
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    webNavigation: { onCommitted: events.committed, onHistoryStateUpdated: events.history },
    tabs: { onUpdated: events.updated, onActivated: events.activated, onRemoved: events.removed },
  }
  return events
}
const listenerOf = (e: FakeEvent): Listener => e.addListener.mock.calls[0]![0] as Listener

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createNavSignals (S3)', () => {
  it('forwards onCommitted with frameId + the EVENT url (never chrome.tabs.Tab)', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 3, url: 'https://a.com/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 3, url: 'https://a.com/step2' }])
  })

  it('forwards onHistoryStateUpdated (SPA wizard steps count)', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.history) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com/#/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 0, url: 'https://a.com/#/step2' }])
  })

  it('tabs.onUpdated loading is a FALLBACK: deduped after a recent webNavigation event, forwarded otherwise', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com' })
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'loading', url: 'https://a.com/x' })
    expect(seen.length).toBe(1) // deduped
    vi.advanceTimersByTime(NAV_FALLBACK_DEDUPE_MS + 1)
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'loading', url: 'https://b.com' })
    expect(seen[1]).toEqual({ type: 'navigated', tabId: 7, frameId: 0, url: 'https://b.com' })
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'complete' })
    expect(seen.length).toBe(2) // non-loading updates are noise
  })

  it('a loading tick WITHOUT a url emits NOTHING — Chrome omits url unless it changed, and an empty url would misread as a cross-site move', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    vi.advanceTimersByTime(NAV_FALLBACK_DEDUPE_MS + 1) // no recent webNav — dedupe is NOT what drops it
    ;(listenerOf(events.updated) as (id: number, c: { status?: string }) => void)(7, { status: 'loading' })
    expect(seen.length).toBe(0)
  })

  it('activation is filtered to the panel window; removal always forwards', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.activated) as (info: { tabId: number; windowId: number }) => void)({ tabId: 9, windowId: 2 })
    expect(seen.length).toBe(0)
    ;(listenerOf(events.activated) as (info: { tabId: number; windowId: number }) => void)({ tabId: 9, windowId: 1 })
    expect(seen).toEqual([{ type: 'activated', tabId: 9 }])
    ;(listenerOf(events.removed) as (id: number) => void)(9)
    expect(seen[1]).toEqual({ type: 'removed', tabId: 9 })
  })

  it('the disposer removes every listener', () => {
    const events = installChrome()
    const stop = createNavSignals(1, () => {})
    stop()
    for (const e of Object.values(events)) expect(e.removeListener).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run RED**, then **Step 3: create `extension/src/panel/navSignals.ts`:**

```ts
/** How long after a webNavigation-sourced event a tabs.onUpdated 'loading' for
 *  the same tab counts as the SAME navigation (fallback dedupe). */
export const NAV_FALLBACK_DEDUPE_MS = 1500

export type NavEvent =
  | { type: 'navigated'; tabId: number; frameId: number; url: string }
  | { type: 'activated'; tabId: number }
  | { type: 'removed'; tabId: number }

/**
 * S3: navigation truth comes from webNavigation, carrying frameId + the EVENT
 * url — the TRM/Ashby reference job submits inside a cross-origin IFRAME and
 * Workday wizards are History-API SPAs; `tabs.onUpdated` sees neither, so it
 * stays only as a deduped fallback. `chrome.tabs.Tab.url` may still hold the
 * pre-nav url, which is why the event's url is the one forwarded. Activation
 * is filtered to the panel's own window (multi-window rule); removal always
 * forwards. The module reports raw events for ALL tabs — routing them to
 * sessions is the panel's job.
 */
export function createNavSignals(windowId: number, onEvent: (e: NavEvent) => void): () => void {
  const lastWebNav = new Map<number, number>()
  const navigated = (d: { tabId: number; frameId: number; url: string }): void => {
    lastWebNav.set(d.tabId, Date.now())
    onEvent({ type: 'navigated', tabId: d.tabId, frameId: d.frameId, url: d.url })
  }
  const onCommitted = (d: { tabId: number; frameId: number; url: string }): void => navigated(d)
  const onHistory = (d: { tabId: number; frameId: number; url: string }): void => navigated(d)
  const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo): void => {
    if (change.status !== 'loading') return
    // Chrome omits `url` unless it CHANGED. A URL-less loading tick carries
    // nothing webNavigation doesn't already provide — and forwarding '' would
    // classify as a cross-site move and PARK a live session mid-wizard.
    if (change.url === undefined) return
    const t = lastWebNav.get(id)
    if (t !== undefined && Date.now() - t < NAV_FALLBACK_DEDUPE_MS) return
    onEvent({ type: 'navigated', tabId: id, frameId: 0, url: change.url })
  }
  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (info.windowId !== windowId) return
    onEvent({ type: 'activated', tabId: info.tabId })
  }
  const onRemoved = (id: number): void => onEvent({ type: 'removed', tabId: id })

  chrome.webNavigation.onCommitted.addListener(onCommitted)
  chrome.webNavigation.onHistoryStateUpdated.addListener(onHistory)
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onActivated.addListener(onActivated)
  chrome.tabs.onRemoved.addListener(onRemoved)
  return () => {
    chrome.webNavigation.onCommitted.removeListener(onCommitted)
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistory)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onActivated.removeListener(onActivated)
    chrome.tabs.onRemoved.removeListener(onRemoved)
  }
}
```

(If the chrome typings reject the narrowed webNavigation listener params, widen to the official callback detail types and read only `tabId`/`frameId`/`url` — FIX-AND-REPORT.)

- [ ] **Step 4: Run GREEN** — `npx vitest run extension/src/panel/navSignals.test.ts && npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/navSignals.ts extension/src/panel/navSignals.test.ts
git commit -m "feat(sessions): webNavigation-first navigation signals with window-filtered activation and deduped fallback (S3)"
```

---

### Task 14: S2/S5/S6 — App session lifecycle integration

**Files:**
- Modify: `extension/src/panel/App.tsx` (the core rewrite)
- Delete: `extension/src/panel/tabScope.ts`
- Modify: `extension/src/panel/App.test.tsx` (harness upgrade + plan-authored acceptance suite; harness adaptations to pre-existing tests are FIX-AND-REPORT)

**Interfaces:**
- Consumes: `sessions` store + `Session` (Task 12), `createNavSignals` (Task 13), `sameSite`/`registrableDomain` (Task 12).
- Produces: the per-tab session era — App holds ONE displayed `Session` plus panel-global state; storage holds the rest. `data-jff-session` attribute (displayed session's tabId, `'none'` when empty state). `data-jff-resets`/`resetCount` are DELETED (`data-jff-scans` stays — the replay counter survives).
- Consumed by: Tasks 15–17.

**Model:** integrator-opus-high — the Work section is intent + binding constraints; the state-shape and effect-structure decisions inside App are yours. If you hit irreducible concurrency ambiguity, return `blocked:` (deep-reasoner is the next rung), don't improvise.

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

#### Work (design intent + binding constraints)

1. **The partition table is EXHAUSTIVE and BINDING** (spec §S Design). Per-session persisted: the `Session` shape from Task 12 (note `companyGuessedRef` is now `session.companyGuessed` — per-session BY NAME in the spec: tab B's guess must never overwrite tab A's user-typed company). Per-session in-flight, NOT persisted: scanning-latch participation, `generatingRefs`, `generateAll`, `acting`, `saving`, `picking`, `saveMsg`, pending-rescan, **`scanStatus`** (a background session's scan progress must never paint the visible panel — the panel-global reading would contradict constraint 6 and Task 16's routing), **`appliedOverrideRef`** (Task 7 — reset on THAT session's navigation; a panel-global would let Scan-anyway on tab 7 suppress tab 8's badge), **`submitPrompt` + `promptDismissedGenRef`** (Task 6), and **`marking`** (Task 5). Panel-global: `check`, `hostError`, `gateOpen`, active `tabId`, `windowId`, `facts`/`factsLoaded`/`factsOk`, `resumeName`, `cvText`, `resumeOk`, `completeness`, `view`, **`scanning` + `scanNonce`** (`scanning` mirrors the GLOBAL single-flight latch; `scanNonce` triggers the DISPLAYED session's auto-scan), `storageWarning` (constraint 7), and `markedMsg: { markedAt: string } | null` — the TRANSIENT post-mark confirmation (see the Mark-applied rule below), cleared on tab switch, navigation, AND at `onScan` entry. Task 5's `startUrl`/`appliedHit` states dissolve INTO the session (`session.startUrl`, `session.appliedHit` — the latter serves the PRE-delete revisit badge, A4); Task 6's refs (`fieldsCountRef`, `lastScanHostRef`, `navRescanRef`, `promptDismissedGenRef`) become per-session-scoped equivalents (in-flight). **Mark-applied rule (plan review B8):** Mark applied DELETES the session, so nothing session-borne can render afterwards — the post-mark UI is the empty state plus the panel-global `markedMsg`, rendered with the SAME `data-jff-applied="1"` badge markup and the copy `Marked as applied on {date}.` (no "Scan anyway" button — there is nothing to override). The DURABLE badge on a later revisit comes from `applied.check` as designed. **At most ONE `data-jff-applied` node ever renders**: `markedMsg` wins while set, and clearing it at `onScan` entry closes the overlap window (post-mark → Scan → check-hit would otherwise render both). The Mark-applied button's disabled predicate becomes `session === null || session.startUrl === ''` — `startUrl` is now a `''`-sentinel string, and marking with an empty url would record garbage into `applied_jobs`.
2. **Lifecycle table (binding):** panel mount → rehydrate all + `prune` against `chrome.tabs.query({})`, display the active tab's session (or empty state), then the existing gate chain (onboarding → host gate → applied badge) decides whether the auto-scan fires. Tab switch → existing session: flush the outgoing session, display the incoming one, NO scan. Tab switch → no session: empty state, NO scan, session created lazily on Scan click or navigation. Same-site nav (top frame OR elected frame; other subframes ignored; url from the EVENT): session survives, re-scan fires. Cross-site nav: session PARKED (`parked: true`, flushed); returning to `session.site` unparks, restores, re-scans. Tab close / Mark applied / explicit Discard: session DELETED (`store.remove`). Precedence: onboarding gate > host gate > applied badge > scan. Two ordering rules inside this table: (a) **swaps carry a monotonic counter** — each tab switch increments it, only the LATEST swap's async work may commit to the display, and the same guard covers an `activated` racing an `onRemoved` for the tab being displayed; (b) **`onScan` on a session-less tab creates the session BEFORE the `applied.check`** — a badge hit must have a session row to land in (`session.appliedHit`), or A4's primary fresh-tab scenario writes the badge into a nonexistent session and never renders it.
3. **Window binding:** `chrome.windows.getCurrent()` at mount supplies `windowId` to `createNavSignals`. **In `?tabId=` override mode (the e2e/test harness), `activated` events are IGNORED entirely** — the harness pins the panel to one tab; navigation/removal events still apply to the bound tab. (Plan decision; keeps the e2e panel-as-page pattern sound.)
4. **Navigation classification:** for a `navigated` event on tab T with frame F and url U, the event is a wizard step iff `F === 0` or `F === session.election?.frameId`. Same-site iff `sameSite(U, session.startUrl)` — with the empty-start exception: a session that never scanned (`site === ''`) treats the nav as same-site and lets the next scan capture `startUrl`. Belt-and-braces over Task 13's url guard: **a `navigated` event whose url is empty is NEVER a site change** — it must not park, unpark, or rewrite `site` (treat as same-site). Task 6's same-hostname approximation is REPLACED by this (update its code comment).
5. **Parked display:** when the displayed session is parked, render (in place of the rows):
   `Session parked — return to {session.site} to continue. Scanning is paused on this page.` (`data-jff-parked="1"`), with the Scan button DISABLED and a `Discard session` button (`data-jff-discard="1"`) that deletes the session and shows the empty state. The Discard button also renders in the normal session view (small, beside Save answers) — spec S5 names explicit discard as a deletion path.
6. **Empty state copy:** `No application session on this tab yet. Click Scan to start.` (`data-jff-empty-session="1"`).
7. **Durability:** every displayed-session mutation goes through the store's debounced `save`; `flush()` on: tab switch (before swap), `visibilitychange` → hidden, `pagehide` (add both listeners in a mount effect), Mark applied, Discard, tab close. Un-debounced (direct `save`+`flush`) on session-ending events. Be honest about what each layer buys: the `pagehide` flush is BEST-EFFORT ONLY — MV3 cannot keep a closing document alive for async completion, so that write may not finish. Real durability comes from the continuous debounced persistence (at most `SESSION_SAVE_DEBOUNCE_MS` behind) plus the `visibilitychange:'hidden'` flush, which fires EARLIER in every close/switch sequence; `pagehide` is a last-chance attempt, never a guarantee. **Swap ordering (binding):** the switch handler calls `store.save(current)` with the SAME session object it last handed to `setSession` (kept on a ref — never derived from a `useEffect` keyed on `session`, which lags a render), then `await flush()`, THEN swaps the display. The store is created with `{ onWarn, getDisplayedTabId }`: `getDisplayedTabId` returns the displayed session's tabId (eviction protection, Task 12/S14); `onWarn` sets a SEPARATE panel-global `storageWarning` rendered as its OWN banner with `data-jff-storage-warn="1"` — copy: `Session storage is full — recent changes may not survive closing the panel.` It must NOT flow through `hostError`: that state feeds `SelfCheckBanner` AND the `hostAnswered`→`gateOpen` latch, and a storage warning is not a host answer (category error). Known, accepted residue: a background settle still inside its mutate READ phase when the panel closes is lost — which is exactly why `mutate` writes through immediately instead of debouncing; only the read window is exposed, not the write.
8. **Mid-flight invalidation survives:** the resetGen/generation-guard INVARIANTS from the old code still hold — a scan/generate/fill settling after its page died must not write into the wrong display. In this task the guard may remain display-scoped (settles for non-displayed sessions may be DROPPED); Task 16 upgrades drops to routed writes. The kept invariant tests (`'drops the results of a scan whose page navigated away mid-flight'`, the dead-draft/dead-fill/dead-company tests, `'replays a navigation trigger the scan guard swallowed'`, `'keeps a company the user typed across a navigation'`, `'never lets a dead scan company guess name the live page employer'`) MUST pass — adapt their harnesses to the new chrome fakes (FIX-AND-REPORT each adaptation), never their assertions.
9. **Harness upgrade (global `beforeEach` in App.test.tsx):** the unit harness already binds WITHOUT any `?tabId=` override — `?jffFakeHost=1` plus the mocked `chrome.tabs.query` answering tab 7 (App.test.tsx:47-52) — so `activated` events work in unit tests as-is; the `?tabId=` override is e2e-only (constraint 3 applies there). Add to the existing chrome fake: `chrome.windows = { getCurrent: vi.fn(async () => ({ id: 1 })) }`; `chrome.webNavigation = { onCommitted: {addListener: vi.fn(), removeListener: vi.fn()}, onHistoryStateUpdated: {addListener: vi.fn(), removeListener: vi.fn()} }`; and make `chrome.storage.session` STATEFUL — get/set/remove over a per-test `rows` object (the current fake at App.test.tsx:78 answers `get` with `{}` and has NO `set` at all).
10. **The two `SNAPSHOT_KEY_RE` call sites** (`onScan` stale-key sweep, `onSaveAnswers` stored merge) keep filtering by `SNAPSHOT_KEY_RE` — session rows now share the storage area, and the disjointness invariant (Task 12's test) is what keeps them correct. Do not "generalize" them. One honesty fix at the `onSaveAnswers` site: widen the `App.tsx:660` cast from `Record<string, StoredSnapshot>` to `Record<string, unknown>` — the area now demonstrably holds non-snapshot rows, and the stale assertion would mislead the next reader (the RE filter inside `mergeStoredSnapshots` is what actually guarantees the shape).

#### Acceptance suite (plan-authored, RED until the integration lands — append to App.test.tsx; plumbing may be adapted FIX-AND-REPORT, assertions may not)

```tsx
describe('App — per-tab sessions (S2/S5/S6)', () => {
  // Helpers the integrator implements against the upgraded harness:
  //   mountPanel()            — render <App/>; the harness already binds via the
  //                             mocked chrome.tabs.query (active tab 7, window 1)
  //   activate(tabId)         — fire the captured tabs.onActivated listener with { tabId, windowId: 1 }
  //   commit(tabId, url)      — fire the captured webNavigation.onCommitted listener with { tabId, frameId: 0, url }
  //   storageRows()           — the stateful chrome.storage.session backing object

  it('a tab switch saves the session and displays the activated tab: empty state, NO scan', async () => {
    // scan settles on tab 7 (one field, edit typed into it), then activate(8) —
    // tab 8 has no session:
    //  - expect data-jff-session === 'none', the empty-state copy, zero rows
    //  - NO JFF_SCAN was sent for tab 8 (scan count unchanged)
    //  - storageRows() contains jff:session:7 with the edit persisted
  })

  it('switching back restores the first session with its work intact', async () => {
    // …continue: activate(7) → the field row renders again with the typed edit,
    // data-jff-session === '7'
  })

  it('an activation from another window is ignored', async () => {
    // activate with windowId 2 → displayed session unchanged
  })

  it('cross-site navigation PARKS; returning to the domain restores', async () => {
    // scan settles on tab 7 (startUrl https://jobs.acme.com/apply), then
    // commit(7, 'https://okta-sso.com/login') →
    //   parked banner, Scan disabled, rows gone, storage row has parked: true
    // commit(7, 'https://careers.acme.com/apply/step2') →
    //   session restored (unparked) and a re-scan fired (scan count +1)
  })

  it('panel reopen rehydrates from storage and prunes dead tabs', async () => {
    // Pre-seed storageRows() with capForStorage(newSession(7,…)) carrying a field
    // + an edit, plus a row for tab 99; chrome.tabs.query({}) answers only tab 7.
    // Mount → the tab-7 session renders (its edit visible), jff:session:99 is gone.
  })

  it('tab close deletes the session', async () => {
    // scan settles on 7; fire the captured tabs.onRemoved listener with 7 →
    // storage row gone, empty state shown
  })

  it('Mark applied deletes the session instead of hand-clearing state', async () => {
    // scan settles; click Mark applied →
    //  - the storage row for 7 is GONE and the empty state renders
    //  - the TRANSIENT confirmation shows: [data-jff-applied] with
    //    'Marked as applied on <date>.' (panel-global markedMsg — the session
    //    it would have ridden on no longer exists; B8)
    //  - activate(8) then back: the confirmation is gone (cleared on switch)
    //  - S5 overlap guard: click Scan (the check now HITS the just-marked url) →
    //    document.querySelectorAll('[data-jff-applied]').length === 1 at every
    //    point — markedMsg wins while set, and onScan entry clears it
  })

  it('Discard deletes the session', async () => {
    // scan settles; click 'Discard session' → empty state, storage row gone, NO applied.mark call
  })
})
```

Each `it` body above is a behavioral contract: the integrator writes the plumbing, the COMMENTED assertions are the required expectations (translate every comment line into an `expect`).

#### Steps

- [ ] **Step 1:** Upgrade the App.test harness (constraint 9) — commit nothing yet; run the suite to catalog what breaks (expect: nothing yet, the harness is additive).
- [ ] **Step 2:** Write the acceptance suite above; run it — RED.
- [ ] **Step 3:** Implement the integration in App.tsx (delete `tabScope.ts`; `git rm extension/src/panel/tabScope.ts`).
- [ ] **Step 4:** `npx vitest run extension/src/panel` — acceptance suite green AND every kept invariant test green (harness adaptations reported).
- [ ] **Step 5:** `npm run typecheck && npm run lint` — clean.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sessions): per-tab sessions replace tab-scope clearing — swap on switch, park cross-site, rehydrate+prune, delete on close/applied/discard (S2/S5/S6)"
```

---

### Task 15: S4 — label-keyed answer carry + re-projection

**Files:**
- Modify: `extension/src/panel/sessions.ts` (adds the exported pure `projectAnswers`; unit-testable there if the integrator wants module-level coverage beyond the App acceptance suite)
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: `session.answers` + `answerKey` (Task 12), the Task-14 session lifecycle.
- Produces: the ref-INDEPENDENT carry — kept answers/drafts live in `session.answers` keyed `answerKey(label)`, holding `{ value, provenance, fieldKey }`; after a re-scan's resolve they re-project onto matching new refs. ALL ref-keyed DOM assertions (`filledRefs`, `generatedRefs`, `snapshot`, `reuseOverrides`, `election`, old `edits`) are DROPPED on re-scan. The projection itself is ONE exported PURE function in `sessions.ts`: `projectAnswers(session: Session, newFields: EnumField[], newResolutions: Resolution[], committedEdits: Record<string, string>): Session` — returns the post-scan session (new fields/resolutions in, ref-keyed state dropped, `edits` seeded per the rules below). App's displayed-path scan settle calls it; **Task 16's background mutate `fn` calls the SAME function** — it is never re-implemented.
- Consumed by: Task 16 (background scan settles call `projectAnswers` inside `store.mutate`), Task 17 (wizard e2e).

**Model:** integrator-opus-high.

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

#### Work (design intent + binding constraints)

1. **Writes into the map** (all scoped to the owning session): `onEdit` → `{ value, provenance: 'user', fieldKey: resolution.key ?? null }`; a settled generate draft → `{ value: draft, provenance: 'generated', fieldKey }`; a successful Accept/Fill → provenance `'user'` with the value that went to the page (committed text wins). Fields with an empty/null label NEVER enter the map (no key, no carry — by design; `save.ts` has the same rule). **Duplicate-label rule (never-guess, same as the fieldKey fallback):** when the CURRENT page's resolve produced two or more fields sharing one `answerKey(label)`, NONE of them writes into `answers` — the carry cannot know which twin a value belonged to, and attributing it to both (or either) on the next page is a silent-wrong-data write. The same key is likewise skipped on projection.
2. **Projection** runs after EVERY resolve that lands in a session which already carried answers: for each new field with label L and resolution R — primary hit `answers[answerKey(L)]`; secondary hit (only when primary missed and `R.key !== null`): the SINGLE map entry whose `fieldKey === R.key` (two or more candidates = no hit — never guess). A hit seeds `edits[newRef] = value`; provenance `'generated'` additionally re-enters `generatedRefs` (the draft badge survives the wizard step). NO hit → NOTHING is attached (the spec's acceptance test). **Collision rule:** `committedEdits` — the batch fill's page-canonical seeds (B1c) — is authoritative for any ref the batch fill touched; label-projection seeds ONLY refs absent from `committedEdits`. The row must keep speaking the page's language.
3. **The epoch invariant holds:** refs are meaningless across re-scans (`fid` restarts at 0 — `enumerate.ts:153`); nothing ref-keyed may survive one. `mergeStoredSnapshots`' epoch rejection and `buildSaveItems`' rules are untouched.
4. Same-site navigation within a session KEEPS `company`/`companyGuessed`/`jobText` (they ride the session); cross-site parking already handles the employer boundary (Task 14). The S8-deleted "clears a GUESSED company on navigation" behavior is intentionally inverted — the replacement assertion lives in this task's suite.

#### Acceptance suite (append; comments = required assertions)

```tsx
describe('App — label-keyed answer carry (S4)', () => {
  // Harness: scan 1 returns fields
  //   [{ fid: 0, label: 'Why do you want to work here?' }, { fid: 1, label: 'Salary expectation' }]
  // scan 2 (armed by a mutable switch, triggered via commit(7, same-site url)) returns
  //   [{ fid: 0, label: 'Anything else?' }, { fid: 1, label: 'Why do you want to work here?' }]
  // — different count/order: the spec's acceptance shape.

  it('wizard step 2 re-projects the draft onto the matching label and attaches NOTHING to a new label', async () => {
    // type 'Because reasons' into the fid-0 row, navigate, wait for scan 2:
    //   expect the 'Why do you want to work here?' row (NOW ref 0:1) to show 'Because reasons'
    //   expect the 'Anything else?' row to be EMPTY — a label absent from step 1
    //   gets NO answer (silent-wrong-data surface #1)
  })

  it('a generated draft survives the step with its badge; filled badges and snapshot do NOT', async () => {
    // generate on a row (bridge returns a draft), fill another row, seed snapshot
    // via a snapshotPush; navigate; after scan 2:
    //   the draft text re-appears on the label-matched row AND its generated badge renders
    //   filledRefs is empty (no 'on the page' badge anywhere), the save preview
    //   reflects an empty snapshot
    //   a row scan 2's BATCH FILL committed keeps its committedEdits value —
    //   the label-projection never overwrites it (S6 collision rule)
  })

  it('the fieldKey fallback rescues a relabelled field only when it is UNAMBIGUOUS', async () => {
    // step 1 label 'E-mail' resolving with key 'email'; user edits it; step 2 label
    // 'Email address' resolving with key 'email' → the edit re-projects.
    // A second map entry with fieldKey 'email' (planted directly) would make it
    // ambiguous → nothing projects. Both halves asserted.
  })

  it('company and jobText ride the session across the step; a user-typed company still beats a later guess', async () => {
    // type company 'Acme', navigate same-site → company still 'Acme' after scan 2
  })

  it('duplicate labels on ONE page: none write into answers, none project (never-guess)', async () => {
    // step 1 has TWO fields labelled 'Phone'; type into one of them; navigate;
    // step 2 has ONE field labelled 'Phone':
    //   expect the step-2 'Phone' row EMPTY — the carry cannot know which twin
    //   the value belonged to, so it must attach to neither (S2 rule)
    //   expect session.answers to hold NO entry under answerKey('Phone')
  })
})
```

#### Steps

- [ ] **Step 1:** Write the acceptance suite — RED (`npx vitest run extension/src/panel/App.test.tsx -t 'label-keyed'`).
- [ ] **Step 2:** Implement per the constraints.
- [ ] **Step 3:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint` — green/clean.
- [ ] **Step 4: Commit**

```bash
git add extension/src/panel
git commit -m "feat(sessions): label-keyed answer carry re-projects drafts across wizard steps; ref-keyed assertions die with the page (S4)"
```

---

### Task 16: S7 — global single-flight, per-session epochs, routed settling writes

**Files:**
- Modify: `extension/src/panel/App.tsx`
- Modify: `extension/src/panel/App.test.tsx`

**Interfaces:**
- Consumes: Tasks 12–15 — in particular `SessionStore.mutate`/`onWrite` (Task 12) and the pure `projectAnswers` (Task 15).
- Produces: the concurrency contract — at most one `resolve` in flight ACROSS ALL sessions; per-session epochs/generations; ONE `applyToSession` choke point for every post-await session write; `snapshotPush` routed by `m.tabId` to the MATCHING session; settling work writes to ITS session (storage when backgrounded) or is dropped when the session died. **Target-bound relay (B4, this task names a REAL gap):** `ScanDeps.tabId` (scan.ts:42) is declared but NEVER referenced — every send goes through `deps.sendToTab`, which App builds over the panel-global `tabId`, so a queued background re-scan would inject/scan/FILL the DISPLAYED tab. `onScan(targetTabId)` must build a target-bound `sendToTab`/`getTab`/`inject` triple closed over `targetTabId` and pass those into `runScan`; `ScanDeps.tabId` is then either actually used by that triple or DELETED from the interface. Binding rule, general: every async operation takes its target tabId as an explicit parameter at dispatch time and never reads a live ref/state at call time.
- Consumed by: Task 17.

**Model:** integrator-opus-high. **On the FIRST honest failure of the routing tests, STOP and return `blocked:` — the orchestrator re-dispatches to debugger-opus-xhigh.** No second attempt at this rung: this is the plan's flagged irreducible-concurrency candidate, and a rework loop here costs more than the escalation.

**Verify:** `npx vitest run extension/src/panel && npm run typecheck && npm run lint`

#### Work (design intent + binding constraints)

1. **Scan latch stays GLOBAL single-flight** (`scanningRef` semantics): tab switching must never multiply paid `claude -p` resolves. A due re-scan for a session that cannot run now (latch busy, or its tab is backgrounded) queues in a per-session pending-rescan; when the latch frees, pending re-scans drain FIFO. A pending re-scan whose session died **or got PARKED** is dropped, not run — a paid resolve against an SSO detour page, settling into a disabled session, is money spent on garbage.
2. **Epochs are per-session:** `epochRef` dies; `runScan`'s `nextEpoch` bumps THE OWNING SESSION's `epoch`. Generation counters (the resetGen concept) are per-session too — a session swap does NOT invalidate the outgoing session's in-flight work; only that session's OWN navigation/death does. **Parking BUMPS the session's generation** — a scan started before the cross-site detour must not settle its dead page's results into the parked row.
3. **Routed settling writes — ONE choke point, no enumeration:** no async continuation may touch session state directly. Every write that lands after an `await` goes through ONE helper — `applyToSession(tabId: number, epochOrGen: number, fn: (s: Session) => Session): Promise<void>` — which routes: target is the DISPLAYED session → a FUNCTIONAL setState whose updater re-checks `prev !== null && prev.tabId === tabId` and the epoch/generation against `prev` itself; **a mismatch does NOT silently no-op — it falls through to `store.mutate(tabId, …)`** (the display swapped between the route decision and the updater running; the write still belongs to its session). Target is a BACKGROUND session → `store.mutate(tabId, fn-with-null-drop)` — NEVER load+save (B6: read-your-writes over the pending debounce, serialized on the store's global FIFO lock). Session null or epoch/generation mismatch inside the mutate fn → return null (the drop arm). This choke point exists precisely because an enumeration keeps missing writers — the previously-missed MID-SCAN writes are the proof: the company guess (App.tsx:287-290 — which after Task 7 sits behind `getTab` + the `applied.check` round-trip, a hundreds-of-ms race window), `setFrameReports([])` at :291 (`frameReports` IS in the persisted Session shape), and `lastOutcome`. A tab switch inside that window must land tab 7's company guess in tab 7's storage — never on tab 8's screen. Background scan settles re-project via the SAME exported `projectAnswers` (Task 15) inside the mutate fn — never a re-implementation. **The repair path back to the screen (B1):** App subscribes `store.onWrite` once at mount; a write for the currently-displayed tabId re-projects the display from the written row — without this, a background→foreground swap racing a mutate leaves screen and storage silently divergent.
4. **`snapshotPush` routing:** the runtime-message listener compares `m.tabId` against sessions, not against the active tab: active-session push → epoch-check against THAT session's epoch → merge to state; background push → `store.mutate(m.tabId, fn)` with the epoch-check against the row `fn` receives (stored-or-pending) → merge, or null-drop on mismatch/missing. The service worker's storage fallback (`jff:snap:*`) is UNTOUCHED.
5. **`onSaveAnswers`** merges stored snapshots with the SESSION's `tabId` + `epoch` (not panel-globals).
6. **Background same-site nav:** marks the session's pending-rescan (per constraint 1). Its eventual scan targets the background tab via the existing relay (`tabId` parameter), and its outcome routes per constraint 3 — the visible panel never flickers.

#### Acceptance suite (append; comments = required assertions)

```tsx
describe('App — session concurrency (S7)', () => {
  it('snapshotPush routes to the MATCHING background session, never the visible one', async () => {
    // Stored session for tab 9 with epoch E and one field; displayed session on tab 7.
    // Dispatch the captured runtime.onMessage listener with
    //   { kind: 'snapshotPush', tabId: 9, frameId: 0, snap: { epoch: E, values: { 2: 'from-9' } } }
    // → storageRows()['jff:session:9'].snapshot['0:2'] === 'from-9'
    // → the displayed session's save preview is unchanged (nothing from tab 9 visible)
    // A second push with epoch E+1 → dropped (stored row unchanged).
  })

  it('a scan settling after a tab switch writes to ITS session in storage, never the screen', async () => {
    // Hold the resolve promise open (deferred bridge); start the scan on tab 7;
    // activate(8) mid-flight; release the resolve →
    //   displayed state (tab 8, empty session) stays empty — zero rows
    //   storageRows()['jff:session:7'] gains the fields/resolutions
  })

  it('a settling write to a DEAD session is dropped — even when the removal RACES the settle', async () => {
    // Same shape, but release the resolve and fire onRemoved(7) in the SAME
    // tick (removal racing the settling mutate — firing onRemoved comfortably
    // BEFORE the release would pass even with the resurrection race live) →
    //   after both settle: no jff:session:7 row exists, no state write, no
    //   throw. The store's global FIFO lock + the tombstone (Task 12) make the
    //   interleaving safe: the remove queues behind the in-flight mutate,
    //   still wins, and the tombstone refuses any later write for the tab.
  })

  it('the scan latch is global: a background session due re-scan queues and drains FIFO', async () => {
    // Scan in flight for tab 7 (held resolve); commit(8, same-site url of tab 8's
    // existing session) → NO second JFF_SCAN yet (count pinned).
    // Release tab 7's resolve → the queued scan for tab 8 fires exactly once and
    // its outcome lands in jff:session:8 (background → storage, per the test above).
    // B4 pin: every relay send the queued scan produced (inject, JFF_SCAN,
    // JFF_FILL) carried tabId 8 — the target-bound triple, never the displayed
    // tab's id. Additionally: a queued re-scan for a session that got PARKED
    // before the latch freed never fires at all (S11).
  })

  it('concurrent generates on two sessions keep their drafts apart', async () => {
    // Generate dispatched on tab 7's row; switch to tab 8 (existing session with a
    // same-labelled field); the draft settles → it lands in jff:session:7's answers
    // (provenance 'generated'), and tab 8's displayed row stays empty.
  })
})
```

#### Steps

- [ ] **Step 1:** Write the acceptance suite — RED.
- [ ] **Step 2:** Implement per the constraints.
- [ ] **Step 3:** Full panel suite + `npm run typecheck && npm run lint` — green/clean (every S4/S14 acceptance and kept-invariant test still green).
- [ ] **Step 4: Commit**

```bash
git add extension/src/panel
git commit -m "feat(sessions): global single-flight scan latch, per-session epochs, tabId-routed settling writes and snapshotPush (S7)"
```

---

### Task 17: E2E batch — era adaptation + the cross-cutting flows

**Files:**
- Create: `e2e/seed.ts` (onboarded-persona seeding helper)
- Create: `e2e/fixtures/greenhouse-apply/wizard-step1.html`, `e2e/fixtures/greenhouse-apply/wizard-step2.html`
- Create: `e2e/sessions.spec.ts`
- Modify: `e2e/full-loop.spec.ts`, `e2e/election.spec.ts`, `e2e/panel-port.spec.ts`, `e2e/foundation.spec.ts` (seeding + any session-era assertion drift — ONE batch, per the standing rule)

**Interfaces:**
- Consumes: everything landed. The e2e suite has been deliberately un-run since Task 3 (preamble rule); this task pays that debt in one pass.
- Produces: green e2e across old + new specs; the three cross-cutting flows from the spec TODO.

**Model:** integrator-opus-high.

**Verify:** `JFF_TEST_SEAM=1 npm run build && npx playwright test` (IDLE machine; foundation flake caveat applies), then `npm run build` (plain dist).

#### Work (binding contract)

1. **`e2e/seed.ts`:** `seedOnboardedProfile(dbPath)` — direct better-sqlite3 inserts of `email`/`phone`/`fullName` into the host home's `profile` table (the pattern `full-loop.spec.ts` already uses for reading). `seedResume(ext)` — an extension-origin page (`chrome-extension://<id>/manifest.json`, the `tabIdForUrl` pattern) writing `{ name: 'cv.txt', mimeType: 'text/plain', dataBase64: btoa('stub cv'), text: 'stub cv' }` under key `current` into IndexedDB `jff`/`resume` (same origin as the panel — the store the panel reads). Every spec that mounts the panel calls both (real-host specs) or `seedResume` alone (seam-fake-host specs — Task 3 already made the canned profile onboarded).
2. **Adapt the existing specs** to the onboarding/session era: add seeding before panel mounts; fix any assertion that referenced pre-session behavior (enumerate every change in the completion report). The 13 baseline tests must end green.
3. **`e2e/sessions.spec.ts` — three flows (binding):**
   - **Onboarding gate blocks scan until complete:** fresh host home, NO seeding → panel shows `Welcome — set up your profile`, no scan status rows; complete the flow through the real UI (upload a `.txt` via `setInputFiles`, type email/phone/full name, `Finish setup`) → auto-scan fires and reaches a settled status. Assert the host DB now holds the typed profile rows.
   - **Two-tab isolation, work preserved:** two fixture tabs A/B; panel page bound to A (override): scan, type a draft; second panel page bound to B: scan, type a DIFFERENT draft; reload panel A's page → A's draft rehydrates from `chrome.storage.session` (assert the draft text and `data-jff-session`); B's page still shows B's draft. (Override mode ignores `activated` — Task 14 constraint 3 — so isolation+rehydrate is the e2e-provable core of S2/S6; in-window swap is covered by the unit acceptance suite.)
   - **Same-site wizard re-projection:** panel bound to a tab on `wizard-step1.html` (a form whose fields include the label `Why do you want to work here?` plus a link `<a href="wizard-step2.html">Continue</a>`); scan, type a draft into that row; click the link in the fixture tab; the panel re-scans (webNavigation) and the draft re-appears on the step-2 row with the same label (step 2 reorders fields and adds a new one, mirroring the unit fixture); the new label's row is empty.
4. Wizard fixtures: plain HTML forms, no scripts needed beyond the link; step 1: `Why do you want to work here?` textarea + `Salary expectation` input; step 2: `Anything else?` textarea FIRST, then the `Why do you want to work here?` textarea — different count/order.
5. Session-7's combobox e2e fixtures and Task 10's react-select spec must still pass unchanged.

#### Steps

- [ ] **Step 1:** Write `seed.ts` + the wizard fixtures + `sessions.spec.ts` (three tests, RED where the code path is new).
- [ ] **Step 2:** `JFF_TEST_SEAM=1 npm run build && npx playwright test` — triage every failure: new-spec RED→green by finishing the harness; old-spec failures are era adaptations (fix + enumerate) unless they reveal a REAL regression — a real regression STOPS the task and is reported, not patched around.
- [ ] **Step 3:** Full `npx playwright test` green (isolated re-run for the foundation flake pair if needed). `npm run build` → plain dist, seam grep 0.
- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): onboarding/session era batch — seeding helper, wizard re-projection, two-tab isolation, gate flow (S/O/A e2e)"
```

---

### Task 18: Full verify, plain dist, A6 seed, spec ticks

**Model:** orchestrator + verifier-opus-low (the verifier runs the commands and returns raw evidence; the orchestrator judges).

- [ ] **Step 1:** `npx vitest run` — all green (record count; expect ≳ 626 + this plan's additions).
- [ ] **Step 2:** `npm run verify` on an IDLE machine (`pkill -f legacyScreenSaver` first). Foundation flake caveat: isolated re-run before judging `:128`/`:149`.
- [x] **Step 3:** `npm run build && grep -rl 'JFF_TEST_SEAM' extension/dist | wc -l` → `0` (plain dist restored — the user's Chrome loads this directory).
- [ ] **Step 4 (A6): seed the session-7 job as applied** — against the REAL host DB (this machine's `~/.job-form-filler`, honoring a custom `dbPath` in config). **First quit Chrome (or at least close the side panel)** so the native host child releases the WAL-mode DB — this script is a second writer on the user's live database. Note this run is also the live DB's `applied_jobs` MIGRATION: `openDb` runs `migrate()` (`CREATE TABLE IF NOT EXISTS`), creating the table on the real DB for the first time.

```bash
npm run build -w @jff/shared && npm run build -w @jff/host
node --input-type=module -e "
import { openDb, markApplied } from './host/dist/db/repos.js'
import { loadConfig } from './host/dist/config.js'
const db = openDb(loadConfig().dbPath)
const row = markApplied(db, {
  url: 'https://www.trmlabs.com/careers?ashby_jid=6edf242b-984d-41fb-8027-5f133a6353d4',
  company: 'TRM Labs',
  jobTitle: null,
})
console.log('seeded:', row.canonicalUrl, row.markedAt)
db.close()
"
```

Idempotent by design (re-running keeps the original `marked_at`). Record the printed canonical url + date as the A6 evidence.
- [ ] **Step 5:** Tick every landed TODO checkbox in the SPEC file (`docs/superpowers/specs/2026-07-29-onboarding-sessions-applied-combobox-design.md`) except the final manual-gate item; `grep -c '^- \[ \]' <spec>` should print `1`.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: full verify green, plain dist restored, TRM/Ashby job seeded as applied (A6), spec ticks"
```

---

### Task 19: Manual browser gate on the real Greenhouse page

**Model:** orchestrator (agent-driven browser verification per the project's proven pattern) + USER for anything requiring their judgment/session. Target: <https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002>. Reload the unpacked extension first (chrome://extensions → Reload).

Checklist (spec's final TODO, all six live):

- [ ] **Onboarding, fresh profile:** with a temporarily-empty profile (back up + clear `~/.job-form-filler/db.sqlite` profile rows, clear the stored resume), the panel shows the onboarding view and NO scan fires; complete it (real CV upload → auto-extract prefill → Finish) → scanning unlocks. Restore/keep the real DB state afterwards — record what was done.
- [ ] **Scan** the Greenhouse application page: fields enumerate, statuses sane.
- [ ] **Fill incl. the Degree dropdown:** `oth` (or the profile's degree value) commits `Other` on the REAL react-select — the C1 bug is dead on the page it was filmed on.
- [ ] **Ashby regression, live:** on the TRM/Ashby posting (now marked applied — enter via "Scan anyway"), one session-7-style combobox fill (e.g. `bra` → Brazil) still commits under the NEW pointer-sequence open gesture. "Click-open widgets see a strict subset" is thereby proven on the page it matters on, not only in fixtures — the claim is untested live for mousedown-toggling widgets until this box is ticked.
- [ ] **Tab-switch round-trip:** mid-application, switch to another tab and back — the work (drafts, edits, company) is intact; a second window's tab switches don't disturb it.
- [ ] **Mark applied** → the session ends and the applications list shows the entry (plus the seeded TRM row from A6).
- [ ] **Revisit badge:** re-open the posting URL → `Already applied on <date>` renders instead of a scan; `Scan anyway` works.
- [ ] Append the outcome (date, what was verified, any deviations) to the `## Manual handshake log` below, tick the spec's last TODO, and commit:

```bash
git add -A
git commit -m "docs: manual gate on the real Greenhouse page — session/applied/combobox flows live-verified"
```

---

## Post-execution reviews (NOT plan tasks — standing rules)

- **Dual plan review BEFORE Task 1:** fresh-context Opus 5 pass over this plan's mandated code (runtime/boot assumptions, forward-compat traps, dead flags) + one codex-review cross-vendor pass. Findings fix the PLAN before execution. **Status: DONE (2026-07-29) — 8 blockers + 14 should-fixes + 9 notes folded into this revision.**
- **Scoped re-review of Tasks 12/14/15/16 (round 2): DONE (2026-07-29)** — 5 blockers + 14 should-fixes + 8 notes folded into this revision (lock-not-chain store semantics, `mutate` return + `onWrite`, the `applyToSession` choke point, target-bound relay, partition completion). Per the reviewer's recommendation there was NO third full pass — only the codex cross-vendor check on the store contract.
- **Scoped codex pass on the Task 12 store contract: DONE (2026-07-29)** — 2 blockers + 2 should-fixes + 1 note folded: the per-tab lock is REPLACED by one global FIFO storage-operation lock (codex's own protocol, adjudicated — cross-tab eviction/interleaving races vanish as a class), permanent tombstones kill the save-after-remove resurrection, `onWrite` timing/error policy pinned (post-link, never awaited, per-subscriber try/catch, reentrancy-safe), the inverse flush-vs-mutate + remove-during-flush + two-tab-flush interleavings are test-pinned, and the pagehide durability claim is downgraded to best-effort. **The store contract is now FINAL.** The ONLY remaining review is the consolidated xhigh branch review after Task 18. Task 16's escalation to debugger-opus-xhigh is taken on the FIRST honest failure, not after a rework loop.
- **Consolidated branch review after Task 18, at effort xhigh** (spec §Execution, binding): the S slices rewrite the panel's core state machine — concurrency + data integrity over 850+ lines. The reviewer pays specific attention to the three silent-wrong-data surfaces: S4 merge keying (label-keyed, never ref-keyed), S7 single-flight + push routing, per-session company provenance. Code review is ALWAYS Opus in a fresh context.

## Plan-time decisions the reviews should scrutinize

Decisions this plan made where the spec was silent or approximate (flagged for the dual plan review):

1. **`canonicalUrl` keeps unknown params** (sorted) and drops only the named tracking set — the spec's identity list becomes documentation, not an allowlist. Rationale: a kept unknown param means at worst a missed badge; over-dropping merges distinct jobs. Review-adjudicated addition: the canonical form is SCHEME-LESS and strips a leading `www.` (`host/path?params`) — http/https and www-vs-bare are transport/vanity, not job identity.
2. **A3 page text** travels over a NEW `JFF_PAGETEXT` content message (body `innerText`, 4000-char cap) — the spec named the patterns, not the transport.
3. **A3 pre-sessions trigger** approximates same-site as same-hostname until Task 14 upgrades it to registrable-domain classification.
4. **A2 pre-sessions `startUrl`** is a panel state surviving only `navigated` resets; Task 14 dissolves it into `Session.startUrl`.
5. **`applied.list` returns a plain array** (no `{page, done}` envelope) — read-only v1, list sizes are human-scale.
6. **O3 completeness LATCHES** on its first settled verdict; only Finish moves it afterwards (a late-arriving load never flips a working panel).
7. **The default test/e2e persona becomes "onboarded"** (canned fake profile + seeded resume) — a harness-wide sweep mandated by the hard gate.
8. **`normalizeQuestion` moves to `@jff/shared`** with a host-side re-export (S4 needs it panel-side; zero host churn).
9. **S4 fieldKey fallback** projects only on a UNIQUE fieldKey match (ambiguity = no projection).
10. **Parked sessions disable Scan** on the parked tab (Discard is the escape hatch) — the tabId-keyed store cannot hold a parked and a live session for one tab.
11. **`?tabId=` override mode ignores `activated` events** — keeps the e2e panel-as-page pattern sound; in-window swap coverage lives in the unit acceptance suite.
12. **S6 quota eviction with no parked candidate degrades to in-memory WITH the pending row retained** (the next flush retries it) **and a visible warning** via the store's `onWarn` → host-banner path — never evicts the active session, never throws, never silently discards (review-adjudicated; the original "drop silently" was a blocker-adjacent should-fix).
13. **`data-jff-resets` dies with `resetCount`;** `data-jff-session` is the session-aware debug hook; `data-jff-scans` survives (the replay counter still exists).
14. **Post-mark confirmation is a PANEL-GLOBAL transient (`markedMsg`)** rendered as the same `data-jff-applied` badge markup — Mark applied deletes the session, so nothing session-borne can carry the badge; the durable badge on revisit comes from `applied.check` (review B8 adjudication).
15. **`SessionStore.mutate` is the ONLY write path for settling work targeting a non-displayed session** — read-your-writes over the pending debounce, ONE global FIFO storage-operation lock (load/loadAll/flush/remove/prune/eviction all enqueue on it; the codex-adjudicated simplification that replaced per-tab locking), permanent tombstones refusing save/mutate for closed tabs (Chrome never reuses tab ids within a browser session), write-through, null-drop arm, `Session | null` return + `onWrite` (post-link, never awaited, per-subscriber try/catch) for the display-repair path. The store contract is FINAL — reviewed by Opus round-2 and the scoped codex pass.

## Manual handshake log

(Task 19 appends dated entries here.)

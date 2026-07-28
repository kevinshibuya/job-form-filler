# Scan + fill correctness overhaul

Make the scan read real ATS forms correctly (labels, kinds, descriptions, required flags,
junk, frames) and make the fill path write them correctly and verifiably — driven by the
TRM/Ashby manual-test failures and a three-way adversarial review (gpt-5.6-sol, Opus 5,
Fable 5) of the diagnosis.

## TODO

Slice A — scan correctness:

- [ ] Every dangling-label field on the Ashby fixture set (17/17: comboboxes, yes/no,
      radio groups) resolves to its question title — e.g. "Select your country of
      employment", "Are you legally authorized to work in your current country of
      employment?" — with zero "(unlabelled field)" rows for them.
- [ ] An option label is never returned as a field or group label: on the radio-group
      fixture the group label is the question title, not "Yes, fully remote"; on the
      single-option consent fixture it is the policy statement, not "I agree".
- [ ] The ancestor climb never crosses a boundary containing another enumerated control:
      on a two-inputs-under-one-wrapper fixture (First/Last name) the inputs keep distinct
      labels instead of sharing the wrapper label.
- [ ] Placeholder text becomes a label only when every other source misses: the combobox
      fixture's label is the question title, never "Start typing...".
- [ ] A recovered label matching DEMOGRAPHIC_RE marks the field demographic (tier
      `skipped`), including choice fields — an Ashby-style EEO yes/no in a plain div is
      never resolvable or fillable.
- [ ] `required` is true for fields whose associated label carries a literal `*` in its
      text or a `required` class token (Ashby pattern), and stays false on the
      optional-field fixture; the LLM prompt and the panel `*` both reflect it.
- [ ] A hidden checkbox/radio whose wrapper contains 2–5 short-text sibling buttons and no
      other control enumerates as kind `choice` with options = the button texts verbatim
      (fixture includes Sim/Não texts); a styled hidden checkbox with a resolvable label
      and no sibling buttons stays kind `checkbox`.
- [ ] `EnumField.description` is captured wrapper-scoped (aria-describedby first, else a
      description/help/hint class-token block inside the field wrapper), capped at 500
      chars, never taken from a block containing a form control; both the essay fixture
      (sibling) and the combobox fixture (uncle) capture; the description text reaches
      both the mapping prompt and the generation prompt.
- [ ] `visible:false` fields are excluded before resolve: the `g-recaptcha-response`
      textarea appears in neither the resolve payload nor the panel. Exceptions still
      enumerate: file inputs, choice-pattern hidden inputs, and hidden checkboxes with a
      resolvable label.
- [ ] A select whose selected option has an empty `value` (a "Select…" placeholder) yields
      `currentValue: null` and resolves through the normal waterfall instead of being
      treated as already-on-page.
- [ ] Scan-time combobox harvest records the mounted options for openable comboboxes and
      leaves `options: []` on failure; after harvest the page is restored (no listbox left
      open, no typed value, no committed selection); the prompt marks combobox fields as a
      closed set whose option list may be partial.
- [ ] Exactly one frame is elected as the application frame (scored by field count,
      required controls, file input, job-text presence) and only its fields are sent to
      resolve and scan-time auto-fill. Bypass criterion: a recognizer-resolvable field in
      a non-elected frame (the newsletter email input) is never auto-filled and never
      appears in the resolve payload.
- [ ] Non-elected-frame fields render collapsed under an "Other page fields" group with a
      frame badge and support manual fill only.
- [ ] The resume upload targets the file field that scores on /resume|cv|currículo/i
      (label, name, accept; bonus for `required`); with zero scoring candidates no upload
      happens. Bypass criterion: on the two-file-input fixture the autofill-pane input is
      never the upload target.
- [ ] Panel rows render kind-aware: choice/radiogroup with ≤5 options as segmented
      buttons, larger option sets as a picker, file rows wired to the stored resume
      targeting their own fid, textarea only for text kinds; descriptions render as
      subtitles.
- [ ] Panel rows follow the elected frame's document order, deterministic across rescans,
      with tier shown as accent + badge; "Other page fields" sits collapsed at the bottom.

Slice B — fill correctness:

- [ ] `fillChoice` clicks the matching option button only when the button is inside the
      detected choice-pattern container AND is provably non-submitting (`type="button"`
      or no `<form>` ancestor). Bypass criteria: a submit-shaped button (untyped, inside
      a form) is never clicked — the fill returns a failure reason and the row shows a
      "select on the page" hint; `fillOne`'s general button rail behaves exactly as
      before for every button outside the choice pattern.
- [ ] A choice fill reports success only after an observable state change (hidden-input
      flip, aria state, or class/attribute delta on the clicked button); with no
      observable change it reports `fill.failed` with a reason.
- [ ] Filling "No" can never silently no-op: choice-kind fields route to `fillChoice`
      (never `fillCheckbox`); plain-checkbox uncheck of an already-unchecked box still
      reports ok (correct no-op).
- [ ] `fillCombobox` interacts only with a listbox attributable to the target control
      (aria-owns/aria-controls, or one that appeared in response to our interaction).
      Bypass criterion: on a two-open-combobox fixture it never selects an option
      belonging to the other combobox.
- [ ] When the target option is not mounted, `fillCombobox` types the value natively to
      filter, selects only an exact normalized match, and verifies the committed value;
      no exact match → `fill.failed: no-matching-option` (prefix guessing removed).
- [ ] Scan-time batch fill consumes the JFF_FILL reports: the "N filled" count reflects
      page-accepted fills only, and per-row failures render in the panel with their
      reason.

## Context

Manual test on https://www.trmlabs.com/careers?ashby_jid=6edf242b-984d-41fb-8027-5f133a6353d4
(35 fields found) surfaced six symptom classes; a Playwright DOM dump of the live Ashby
iframe plus a three-way adversarial review (codex log
`~/.claude/codex-runs/20260728-160329-18195-review-scan-diagnosis.log`, Opus 5 and Fable 5
agent reports, 2026-07-28) confirmed, corrected, and extended the diagnosis. Ground facts:

- Ashby emits `<label for="X">` where X matches no element id — 17 of 17 misread fields
  are exactly the dangling-label set. Comboboxes fall through to placeholder
  ("Start typing..."), yes/no checkboxes and radio fieldsets (child `<label>`, no
  `<legend>`) fall through to null.
- Yes/No questions are two untyped `<button>`s + a `display:none` checkbox. Buttons are
  never enumerated; `fillCheckbox("No")` on an unchecked box is a no-op that reports ok.
- Two file inputs exist; `scan.ts` uploads the resume to the FIRST (`fields.find`), which
  is Ashby's autofill-parser pane, not the required Resume field.
- Scan-time auto-fill writes tier-`auto` values into every frame — including the
  top-page newsletter email input (live PII write into a marketing form).
- `required` is false for every non-plain field (requiredness lives in a label CSS class,
  rendered as `*` via CSS, absent from textContent and attributes).
- The reCAPTCHA response textarea (`visible:false`) reaches the panel and the paid
  resolve; nothing reads `visible`.
- Descriptions exist as wrapper children (sibling of the control OR of the control's
  container — "uncle"); `aria-describedby` appears zero times on this form.
- `fillCombobox` never types and `listboxOf` falls back to any listbox in the document;
  `fillFields` produces `{filled, failed[]}` that nothing consumes.

Constraints (standing decisions): generic engine, no per-ATS adapters — every heuristic
below is justified as HTML/convention repair, not Ashby-specific; never auto-submit;
panel-driven UX; thin extension / smart host; do not regress radio grouping by name,
shadow-DOM walking, demographic skipping, per-frame injection, epoch/generation
discipline.

## Design

### A1. Label recovery (`extension/src/content/dom.ts`)

`labelFor` precedence becomes: explicit `label[for]` → aria-label → aria-labelledby →
wrapping label → fieldset legend → **dangling-label repair** → **name==for match** →
**guarded ancestor climb** → placeholder (true last resort).

- Dangling-label repair: collect `label[for=X]` in the control's scope where X resolves to
  no element. Such a label binds to the control iff the control is the single enumerable
  control inside the label's parent wrapper. Option labels are structurally excluded:
  their `for` resolves (to the radio/checkbox id). This rule alone covers 17/17 broken
  Ashby fields and is pure HTML repair.
- name==for: a dangling `label[for=X]` where the wrapper's control has `name == X` (Ashby
  yes/no checkboxes carry the uuid as name) — exact, generic (React `htmlFor`≈name
  convention).
- Guarded climb (last resort before placeholder): walk ≤5 ancestors; stop at `<form>`,
  shadow root, or the first ancestor containing another enumerated control (radio
  siblings sharing `name` don't count); accept only a child `<label>`/`<legend>`/heading
  whose `for` (if any) does not resolve to a control; never body/documentElement.
- `groupLabelFor` gains the dangling-label rule and the climb separately (it never calls
  `labelFor`); legend and `[role=group]` aria stay first.
- Every label recovered by ANY source is screened through `DEMOGRAPHIC_RE`; a match sets
  `demographic: true` (`classify.ts` currently only tests containers/frame signals).

Mislabeling is worse than null (a wrong label + recognizer ⇒ unconfirmed auto-fill), so
the climb is deliberately strict; unlabeled leftovers remain "(unlabelled field)".

### A2. Required recovery (`enumerate.ts` + `dom.ts`)

`required = el.required || aria-required || labelEl text contains literal '*' || labelEl
className has a token matching /(^|[-_ ])required/i` (and not `not-required`). The label
element used is whichever source A1 selected, so the signal rides the same binding.
Class-token matching is convention-based like `classify.ts`'s regexes; accepted risk.

### A3. Choice fields (`enumerate.ts`, `shared/src/field.ts`)

Detection: an `input[type=checkbox|radio]` that is self-hidden (`display:none` /
`visibility:hidden` / clipped) whose nearest wrapper contains 2–5 `<button>`s with short
text (≤30 chars each) and no other enumerable control → kind `choice`; options = button
texts verbatim (never boolean-mapped; i18n-safe); fid stamped on the hidden input (the
filler re-finds the buttons structurally from it). A hidden checkbox with a resolvable
label and no such buttons keeps kind `checkbox` (styled-checkbox recipe).

Schema: `WidgetKind` gains `'choice'`; `EnumField` gains optional `description` (default
absent) — single-repo coordinated change across shared/extension/host; optional-with-
default so an older cached `HostResponse` replay or a stale content script cannot produce
`bad_scan`.

### A4. Description capture (`enumerate.ts`)

Within the field wrapper established by A1's binding (label's parent wrapper): first
`aria-describedby` targets, else element(s) whose class has a token matching
/description|help|hint/i, positioned between label and control or adjacent to the
control's container. Reject any candidate whose subtree contains a form control; cap at
500 chars (whitespace-normalized). Piped verbatim into the mapping prompt
(`host/src/llm/mapping.ts`) and the generation prompt (`host/src/llm/generate.ts` +
`App.onGenerate` request). Descriptions are page-controlled text entering an LLM prompt —
same injection class as labels, larger payload; the 500-char cap and the host's existing
fencing apply.

### A5. Junk filtering + currentValue fix (`enumerate.ts` / `scan.ts`)

Fields with `visible:false` are dropped before the resolve request and never rendered,
EXCEPT: kind `file` (always forced visible today — the exception is structural, kept
explicit), choice-pattern hidden inputs (A3 re-kinds them anyway), and hidden
checkboxes/radios with a resolvable label. Filtering happens at the scan layer so junk
never reaches `claude -p`, the auto-fill loop, or honeypot inputs.

`currentValueOf` (select): a selected option with `value === ''` (or `disabled`) returns
null — "Select…" placeholders stop masquerading as page-sourced values.

### A6. Combobox option harvest (`scan.ts` + content script)

After enumeration (and after the resume-upload re-enumeration settles), for each
combobox: click to open → wait ≤500ms for a listbox attributable to that control
(aria-owns/controls, or a `[role=listbox]` that appeared after the click) → read
`[role=option]` texts → close via Escape then blur; verify the input value is unchanged,
else restore ''. Failures (no listbox, timeout) leave `options: []`. Harvest runs before
resolve so the LLM sees real options; the prompt marks comboboxes "closed set; options
may be partial". Mutation risk contained: open/close only, no typing, value verified
restored.

### A7. Frame election (`scan.ts`)

Score each frame report: `fields.length` + 3×(required count) + 5×(has file input) +
5×(frame contributed jobText). Highest score wins (tie → most fields; still tied → lowest
frameId). Only elected-frame fields go into the resolve request and the auto-fill loop.
Other frames' fields are kept in the scan result flagged `foreign: true`: the panel
renders them collapsed under "Other page fields" with a frame badge; rows support manual
Fill (user-initiated, same per-frame JFF_FILL path) but never Generate/auto-fill. The top
frame can legitimately win (Greenhouse/Lever render in the top document) — election is by
signal, not frame position.

### A8. Resume targeting (`scan.ts`)

Replace `fields.find(kind === 'file')` with scoring over elected-frame file fields:
+3 label match /resume|cv|currícul/i, +2 name/id match, +1 `accept` mentions pdf/doc,
+2 `required`. Highest positive score wins; zero candidates with positive score → no
upload (panel notes "resume field not identified"). The autofill-pane input (unlabelled,
not required) scores 0 and is never targeted.

### A9. Panel rendering + ordering (`FieldRow.tsx`, `group.ts`, `App.tsx`)

- Kind-aware editors: `choice`/`radiogroup` with ≤5 options → segmented buttons; >5
  options or `select`/`combobox` with harvested options → picker with typeahead filter;
  combobox with empty options → text input annotated "dropdown — options load on fill";
  `file` → row showing the stored resume name + "Put on page" targeting THIS row's fid
  via the existing base64 `JFF_FILL_RESUME` plumbing; everything else keeps the textarea.
- Description renders as a muted subtitle under the label; required `*` reflects A2.
- Ordering: rows follow the elected frame's document order (fid order within a frame is
  already document order), stable across rescans; tier becomes the existing color accent
  plus a small badge instead of bucketing. "Other page fields" collapsed at the bottom.

### B1. fillChoice (`fill.ts`)

Reached via kind-independent structural re-detection from the fid-stamped hidden input
(fill dispatches on live element shape, mirroring A3's detection — `fillOne` gains this
branch BEFORE the checkbox branch). Gate: the matching button (normalized text ==
normalized value) must be inside the pattern container AND (`type="button"` OR no
`<form>` ancestor). Refusal returns `{ok:false, reason:'choice-needs-user-click'}`; the
panel renders a "select on the page" hint for that reason. The general BUTTON rail in
`fillOne` is unchanged for everything outside this branch.

Verification: snapshot (hidden input checked/value, each button's className +
aria-pressed/aria-checked/data-state) → click → next-frame re-snapshot; any delta = ok,
no delta = `{ok:false, reason:'no-state-change'}`.

### B2. fillCombobox hardening (`fill.ts`)

- `listboxOf` scoped: aria-owns/controls first; else a `[role=listbox]` that was NOT
  present before our interaction (pre-click snapshot of mounted listboxes); the
  document-wide fallback is removed. No attributable listbox → fail.
- If no exact normalized match among mounted options: `setNativeValue(el, value)` to
  drive the typeahead, wait ≤500ms for options, then exact match only (prefix fallback
  removed). Select → verify the control's committed value/text contains the choice;
  mismatch → `{ok:false, reason:'no-matching-option'}` and typed text cleared.

### B3. Fill reports consumed (`scan.ts`, `App.tsx`)

`JFF_FILL` replies (`FillReport {filled, failed[]}`) are collected per frame during
scan-time auto-fill and returned in the scan result. Panel state records per-fid
outcomes: "N filled" = page-accepted count; a failed auto-fill row shows its reason and
drops back to needs-input styling. (Accept/Fill actions already verify per-field; this
closes the batch path — the handoff's known gap.)

## Error handling

- Harvest/click timeouts degrade to the pre-fix behavior (empty options, no label) —
  never fail the scan.
- Every new refusal is a first-class `fill.failed` reason surfaced on the row:
  `choice-needs-user-click`, `no-state-change`, `no-matching-option`,
  `resume-field-not-identified` (scan note).
- Frame election with a single frame is a no-op (elects it); zero fields overall keeps
  the existing empty-scan path.

## Testing

- Checked-in HTML fixtures distilled from the Ashby dump (scratchpad
  `ashby-dump3.json`), one per pattern: dangling-label combobox, yes/no choice (En +
  Sim/Não), radio fieldset with child label, single-option consent, description sibling +
  uncle, two file inputs, reCAPTCHA textarea, select-with-placeholder, styled hidden
  checkbox, First/Last shared wrapper. Unit tests drive enumerate/dom/fill against them
  (vitest + jsdom, as existing tests do).
- Fill-path bypass tests: submit-shaped button never clicked; foreign-frame field never
  auto-filled; autofill-pane input never receives the resume; cross-combobox listbox
  never used.
- e2e (Playwright + seam build): fixture page replicating the Ashby patterns in a
  cross-origin iframe plus a top-frame newsletter input — asserts election, demotion,
  page-order rendering, choice fill end-to-end; two-frame election test.
- Existing suites must stay green: `npm run verify` (typecheck + lint + unit + e2e).

## Out of scope

- Resolve cancellation on navigation (host-protocol change, spec-deferred from v1).
- The foundation e2e load-flake hardening slice (pre-existing, tracked in HANDOFF.md).
- Host sharp edges (machine-specific paths, ESLint scope) from session 1.
- Broader panel UI/UX pass beyond the row rendering/ordering above.
- Live-Ashby validation of choice-click behavior (manual gate after implementation).

## Execution

Two plan slices, in order: Slice A (scan correctness — A1–A9) then Slice B (fill
correctness — B1–B3). B3's report plumbing may land with A if the plan finds it cheaper
to build the observability first. Plan-level review (fresh-context Opus + codex
cross-vendor) before Task 1, per standing workflow rules.

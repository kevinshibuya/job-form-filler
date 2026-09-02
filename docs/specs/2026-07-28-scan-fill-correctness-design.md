# Scan + fill correctness overhaul

Make the scan read real ATS forms correctly (labels, kinds, descriptions, required flags,
junk, frames) and make the fill path write them correctly and verifiably — driven by the
TRM/Ashby manual-test failures, a three-way adversarial review (gpt-5.6-sol, Opus 5,
Fable 5) of the diagnosis, and a fresh-context Opus review of this spec (18 findings
applied, 2026-07-28).

## TODO

Slice A — scan correctness:

- [x] Every dangling-label field on the Ashby fixture set (17/17: comboboxes, yes/no,
      radio groups) resolves to its question title — e.g. "Select your country of
      employment", "Are you legally authorized to work in your current country of
      employment?" — with zero "(unlabelled field)" rows for them.
- [x] An option label is never returned as a field or group label: on the radio-group
      fixture the group label is the question title, not "Yes, fully remote"; on the
      single-option consent fixture it is the policy statement, not "I agree".
- [x] The ancestor climb never crosses a boundary containing another enumerated control
      (radios sharing the target's `name` count as one control): on a
      two-inputs-under-one-wrapper fixture (First/Last name) the inputs keep distinct
      labels instead of sharing the wrapper label.
- [x] Placeholder text becomes a label only when every other source misses: the combobox
      fixture's label is the question title, never "Start typing...".
- [x] A recovered label matching DEMOGRAPHIC_RE marks the field demographic (tier
      `skipped`), including choice fields — an Ashby-style EEO yes/no in a plain div is
      never resolvable or fillable.
- [x] `required` is true for fields whose bound label element carries a literal `*` in
      its RAW text or a `required` class token (Ashby pattern), and stays false on the
      optional-field fixture; the LLM prompt and the panel `*` both reflect it.
- [x] A hidden checkbox OR radio whose wrapper contains 2–5 short-text sibling buttons
      and no other control enumerates as kind `choice` with options = the button texts
      verbatim (fixtures include Sim/Não texts and a radio-backed variant); a styled
      hidden checkbox with a resolvable label and no sibling buttons stays kind
      `checkbox`.
- [x] `EnumField.description` is captured wrapper-scoped (aria-describedby first, else a
      description/help/hint class-token block inside the field wrapper), as
      whitespace-normalized textContent only (markup and hrefs discarded), capped at 500
      chars, never from a block containing a form control, never from a block whose
      class matches /error|invalid|validation/i; both the essay fixture (control
      sibling) and the combobox fixture (control's uncle inside the wrapper) capture.
- [x] The description text reaches BOTH the mapping prompt and the generation prompt
      through the real message path (schema changes of A4), inside the untrusted-content
      fencing.
- [x] `visible:false` fields are excluded from the resolve payload, the auto-fill loop,
      and the rendered list: the `g-recaptcha-response` textarea appears in none of
      them. Still kept: file inputs that score under A8 or carry a resolvable label,
      choice-pattern hidden inputs, and hidden checkboxes/radios with a resolvable
      label. The content script still enumerates and fid-stamps everything (snapshot and
      fid numbering unchanged).
- [x] A select whose selected option has an empty `value` or is disabled (a "Select…"
      placeholder) yields `currentValue: null` and resolves through the normal waterfall
      instead of being treated as already-on-page.
- [x] Scan-time combobox harvest records the mounted options for openable comboboxes in
      the ELECTED frame only, and leaves `options: []` on failure; a combobox in a
      non-elected frame or a demographic combobox is never opened; a combobox with a
      pre-existing value has the identical value after harvest; the prompt marks
      combobox fields as a closed set whose option list may be partial.
- [x] Exactly one frame is elected as the application frame (scored by field count,
      required controls, file input) and only its fields are sent to resolve, scan-time
      auto-fill, resume upload, and harvest. Bypass criteria: a recognizer-resolvable
      field in a non-elected frame (the newsletter email input) is never auto-filled and
      never appears in the resolve payload; election picks the form frame even when the
      user pasted job text.
- [x] Non-elected-frame fields render collapsed under an "Other page fields" group that
      names the elected frame, with a frame badge per row; they support manual fill
      only (no Generate, no auto-fill, not saved as answers).
- [x] The resume upload targets the file field that scores on /resume|cv|currícul/i
      (label, name, accept; bonus for `required`); with zero positively-scoring
      candidates no upload happens. Bypass criterion: on the two-file-input fixture the
      autofill-pane input is never the upload target.
- [x] Panel rows render kind-aware: choice/radiogroup with ≤5 options as segmented
      buttons, larger option sets as a picker, the A8-winning file row wired to the
      stored resume targeting its own fid (any other file row manual-only), textarea
      only for text kinds; descriptions render as subtitles.
- [x] Panel rows follow the elected frame's document order, deterministic across
      rescans, with tier shown as accent + badge; "Other page fields" sits collapsed at
      the bottom.
- [x] The status line separates `filled` (page-accepted fills, per B3 reports) from
      `already on page` (page-sourced values); neither count lies when a batch fill
      fails.

Slice B — fill correctness:

- [x] A choice field whose hidden input accepts a real click (observable state change)
      is filled WITHOUT any button being clicked.
- [x] When the hidden-input click produces no observable change, `fillChoice` clicks the
      matching option button only when that button (a) is a descendant of the detected
      choice container holding the fid-stamped hidden input, (b) does not match the
      submit vocabulary /^(submit|apply|send|continue|next|enviar|candidatar)/i in its
      normalized text, and (c) has `type="button"` or no `<form>` ancestor. Bypass
      criteria: an untyped button inside a `<form>` is never clicked; a submit-worded
      button is refused even on a page with no `<form>` at all; refusals return
      `choice-needs-user-click` and the row shows a "select on the page" hint;
      `fillOne`'s general button rail behaves exactly as before outside the choice
      branch.
- [x] A choice fill reports success only after an observable state change (hidden-input
      flip, aria state, or class/attribute delta on the clicked button); with no
      observable change it reports `fill.failed` with a reason.
- [x] Filling "No" can never silently no-op: choice-kind fields route to `fillChoice`
      before BOTH the radio and checkbox branches (radio-backed choice fixture proves
      it); plain-checkbox uncheck of an already-unchecked box still reports ok (correct
      no-op).
- [x] `fillCombobox` interacts only with a listbox attributable to the target control
      (aria-owns/aria-controls, or one that appeared in response to our interaction).
      Bypass criterion: on a two-open-combobox fixture it never selects an option
      belonging to the other combobox.
- [x] When the target option is not mounted, `fillCombobox` types the value natively to
      filter, selects only an exact normalized match, and verifies the committed value;
      no exact match → `fill.failed: no-matching-option` and the control is restored to
      its pre-fill value (prefix guessing removed).
- [x] Scan-time batch fill consumes the JFF_FILL reports: the "filled" count reflects
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
  rendered as `*` via CSS ::after, absent from textContent and attributes; the dump shows
  26 `_required_`-classed labels vs 6 plain).
- The reCAPTCHA response textarea (`visible:false`) reaches the panel and the paid
  resolve; nothing reads `visible`.
- Descriptions exist as wrapper children (sibling of the control OR of the control's
  container — its "uncle"); `aria-describedby` appears zero times on this form.
- `fillCombobox` never types and `listboxOf` falls back to any listbox in the document;
  `fillFields` produces `{filled, failed[]}` that nothing consumes.
- The page contains NO `<form>` element at all — "no form ancestor" is true for every
  button on it, which shapes the B1 gate design.

Constraints (standing decisions): generic engine, no per-ATS adapters — every heuristic
below is justified as HTML/convention repair, not Ashby-specific; never auto-submit;
panel-driven UX; thin extension / smart host; do not regress radio grouping by name,
shadow-DOM walking, demographic skipping, per-frame injection, epoch/generation
discipline.

## Design

### A1. Label recovery (`extension/src/content/dom.ts`)

`labelFor`/`groupLabelFor` change return shape to a binding descriptor
`{ text: string | null, source: string, element: Element | null }` (A2 and A4 need the
element; `enumerate.ts` reads `.text` where it used the string). Precedence for
`labelFor` after the existing chain misses: explicit `label[for]` → aria-label →
aria-labelledby → wrapping label → fieldset legend → **dangling-label repair** →
**name==for match** → **guarded ancestor climb** → placeholder (true last resort).

- Dangling-label repair: collect `label[for=X]` in the control's scope where X resolves
  to no element. Such a label binds to the control iff the control is the single
  enumerable control inside the label's parent wrapper. Option labels are structurally
  excluded: their `for` resolves (to the radio/checkbox id). **Radios sharing the
  target's `name` count as ONE enumerable control** — this exemption is part of the rule
  definition and applies everywhere the rule or the climb counts controls (without it
  the rule is structurally dead for radio groups, whose wrapper holds 3+ radios).
- name==for: a dangling `label[for=X]` where the wrapper's control has `name == X`
  (Ashby yes/no checkboxes carry the uuid as name; radio-group names end with it) —
  exact, generic (React `htmlFor`≈name convention).
- Guarded climb (last resort before placeholder): walk ≤5 ancestors; stop at `<form>`,
  shadow root, or the first ancestor containing another enumerated control (same radio
  exemption); accept only a child `<label>`/`<legend>`/heading whose `for` (if any) does
  not resolve to a control; never body/documentElement.
- `groupLabelFor` gains the dangling-label rule and the climb separately (it never calls
  `labelFor`); legend and `[role=group]` aria stay first.
- Demographic screen: `enumerate.ts` computes
  `demographic: isDemographic(el) || DEMOGRAPHIC_RE.test(binding.text ?? '')` — the
  injected `isDemographic` signature stays `(el) => boolean`; the label test lives in
  enumerate, not classify.

Mislabeling is worse than null (a wrong label + recognizer ⇒ unconfirmed auto-fill), so
the climb is deliberately strict; unlabeled leftovers remain "(unlabelled field)".

### A2. Required recovery (`enumerate.ts` + `dom.ts`)

`required = el.required || aria-required || binding.element's RAW textContent contains a
literal '*' || binding.element.className has a token matching /(^|[-_ ])required/i` (and
not `not-required`). The `*` test must run on raw `textContent` — `clean()` in `dom.ts`
strips a trailing `*` from the returned text, which is why the binding descriptor carries
the element. Class-token matching is convention-based like `classify.ts`'s regexes and
survives CSS-module hashing (`_required_f7cvd_91` matches); accepted risk.

### A3. Choice fields (`enumerate.ts`, `shared/src/field.ts`)

Detection: an `input[type=checkbox|radio]` that is self-hidden (via the injected
`MeasureFn`: `display:none`, `visibility:hidden`, or the new `clipped` flag) whose
nearest wrapper contains `CHOICE_MIN_BUTTONS=2`–`CHOICE_MAX_BUTTONS=5` `<button>`s with
short text (≤`CHOICE_MAX_OPTION_CHARS=30` each) and no other enumerable control → kind
`choice`; options = button texts verbatim (never boolean-mapped; i18n-safe); fid stamped
on the hidden input (the filler re-finds the buttons structurally from it). The bounds
are named constants — they encode "a segmented control, not a toolbar" — so fixtures and
code cannot drift. A hidden checkbox with a resolvable label and no such buttons keeps
kind `checkbox` (styled-checkbox recipe).

`Measure` gains `clipped: boolean`, computed in `defaultMeasure` (clip-rect/1px-box
recipe); unit fixtures drive it via an injected measure (jsdom returns 0×0 rects), the
real computation is exercised in Playwright.

Schema: `WidgetKindSchema` gains `'choice'`; `EnumFieldSchema` gains
`description: z.string().optional()`. Single-repo coordinated change across
shared/extension/host. A stale content script predating the fields cannot fail
`ScanResultSchema` (optional with absent default), and widening `WidgetKindSchema` stays
compatible with cached resolve responses (`Resolution` carries no kind). Root tsconfig
has `exactOptionalPropertyTypes: false`, so `description?: string` needs no extra
ceremony.

### A4. Description capture (`enumerate.ts`) and prompt plumbing (host + panel)

Capture: within the field wrapper established by A1's binding (the binding element's
parent wrapper): first `aria-describedby` targets, else element(s) whose class has a
token matching /description|help|hint/i anywhere inside the wrapper (the dump shows both
control-sibling and control-uncle positions). Reject any candidate whose subtree
contains a form control or whose class matches /error|invalid|validation/i. Value is
whitespace-normalized `textContent` only — markup and hrefs discarded — capped at 500
chars.

Plumbing (each is a real schema/code touch, enumerated so no path silently drops the
field): `EnumFieldSchema.description` (A3) carries it to the host; `buildMappingPrompt`
(`host/src/llm/mapping.ts:49-54`) emits it fenced; `HostRequestSchema`'s
`generate.params` gains `description: z.string().optional()`
(`shared/src/messages.ts:53-61` is a closed object — without this zod strips it);
`App.onGenerate` sends it; `handlers.ts` passes it through; `GenerationInput` +
`buildGenerationPrompt` (`host/src/llm/generate.ts`) emit it fenced with a new
`CAPS.description = 500` (`host/src/llm/fence.ts`); the new tag joins
`UNTRUSTED_PREAMBLE`'s enumerated tag list. Descriptions are page-controlled text
entering an LLM prompt — same injection class as labels, larger payload; cap + fencing +
preamble apply.

### A5. Junk filtering + currentValue fix (panel layer)

The content script continues to enumerate and fid-STAMP everything — snapshot behavior
and fid numbering across the pre/post-resume re-enumerations are unchanged. The PANEL
(`scan.ts`) drops `visible:false` fields from the resolve payload, the auto-fill loop,
and the rendered list, EXCEPT: file inputs that either score positively under A8 or
carry a resolvable label (the unlabelled autofill-pane input proves file inputs can be
junk — the blanket file exemption is deliberately NOT kept), choice-pattern hidden
inputs (A3 re-kinds them), and hidden checkboxes/radios with a resolvable label
(styled-control recipe).

`currentValueOf` (select): a selected option with `value === ''` or `disabled` returns
null — "Select…" placeholders stop masquerading as page-sourced values.

### A6. Combobox option harvest (elected frame only)

Runs after election, only for non-demographic combobox fields of the ELECTED frame, via
a new content message `JFF_HARVEST { epoch, fids }` added to `ContentMessageSchema`
(closed union — without the schema change the content script rejects it as
`bad_message`) and subject to the same epoch gate as fill. Per combobox: snapshot the
control's value → click to open → wait ≤500ms for a listbox attributable to that control
(aria-owns/controls, or a `[role=listbox]` that appeared after the click) → read
`[role=option]` texts → close via Escape then blur → if the value changed, restore the
SNAPSHOT value via `setNativeValue` (never `''` — a page-sourced value, e.g. from the
ATS resume-parse, must survive harvest identically). Reply `{ fid → options[] }`, merged
panel-side before resolve. Failures (no listbox, timeout) leave `options: []`. The
prompt marks comboboxes "closed set; options may be partial". Mutation risk contained:
open/close only, no typing, value verified restored.

### A7. Frame election (`scan.ts`)

Election happens immediately after enumeration, BEFORE everything else; the pinned phase
order is: enumerate → score/elect → jobText → resume upload (A8, elected frame only) →
harvest (A6, elected frame only) → resolve → auto-fill. Score per frame report:
`fields.length + 3×(required count) + 5×(has file input)`. No jobText term — jobText is
requested from frame 0 only and is skipped entirely when the user pasted text, so it
cannot be a fair signal (spec'd out; the previous draft's `5×(contributed jobText)` was
uncomputable). Highest score wins (tie → most fields; still tied → lowest frameId). Only
elected-frame fields go into the resolve request, the auto-fill loop, the resume upload,
and harvest.

Other frames' fields are kept in the scan result; `foreign` status is DERIVED panel-side
from `field.frameId !== electedFrameId` — it is not an `EnumField` property (zod strips
unknown keys at `ScanResultSchema`, and the schema doesn't need it). The "Other page
fields" group header names the elected frame (host + score) so a mis-election is
visible and explainable; an explicit "treat this frame as the application" override is
DEFERRED (needs rescan-with-election-pin plumbing; the visible header is the mitigation
until then). The top frame can legitimately win (Greenhouse/Lever render in the top
document) — election is by signal, not frame position.

### A8. Resume targeting (`scan.ts`)

Replace `fields.find(kind === 'file')` with scoring over elected-frame file fields:
+3 label match /resume|cv|currícul/i, +2 name/id match, +1 `accept` mentions pdf/doc,
+2 `required`. Highest positive score wins; zero candidates with positive score → no
upload (panel notes "resume field not identified"). The autofill-pane input (unlabelled,
not required) scores 0 and is never targeted.

### A9. Panel rendering + ordering (`FieldRow.tsx`, `group.ts`, `App.tsx`, `save.ts`)

- Foreign fields: `group.ts` currently drops any field without a resolution
  (`group.ts:29`) — foreign fields get a panel-side SYNTHETIC resolution
  `{ tier: 'needs_input', source: null, value: null, reason: 'other-frame' }` minted in
  the grouping layer, so they render without touching the host or the schema. Foreign
  rows: manual Fill only — no Generate, no auto-fill, and `save.ts` keeps skipping them
  (answers to another page's fields are not application answers; intended).
- Kind-aware editors: `choice`/`radiogroup` with ≤5 options → segmented buttons; >5
  options or `select`/`combobox` with harvested options → picker with typeahead filter;
  combobox with empty options → text input annotated "dropdown — options load on fill";
  the A8-WINNING file row shows the stored resume name + "Put on page" targeting its own
  fid via the existing base64 `JFF_FILL_RESUME` plumbing; any OTHER file row renders
  manual-only with its score reason (two identical resume buttons would reintroduce the
  autofill-pane trap); everything else keeps the textarea.
- Description renders as a muted subtitle under the label; required `*` reflects A2.
- Ordering: rows follow the elected frame's document order (fid order within a frame is
  document order), stable across rescans; tier becomes the existing color accent plus a
  small badge instead of bucketing. "Other page fields" collapsed at the bottom.
- Status line (`App.tsx:300-317`, `ScanStatus`): today "filled" counts every
  `tier === 'auto'` including `source: 'page'`. New semantics: `filled` = page-accepted
  fills (B3 reports), `already on page` = page-sourced values, shown separately.
  `App.test.tsx`/`ScanStatus.test.tsx` assert on the old semantics and change with this.

### B1. fillChoice (`fill.ts`)

Reached via kind-independent structural re-detection from the fid-stamped hidden input
(fill dispatches on live element shape, mirroring A3's detection). The branch sits
BEFORE BOTH the radio and checkbox branches (immediately after combobox) —
`fillOne` dispatches radio first today, so a later placement would swallow radio-backed
choices into `fillRadioGroup`.

Attempt order (cheapest and safest first — this also answers the codex D4 objection
instead of deferring it to a manual gate):
1. Real `.click()` on the hidden input itself, then verify by observable state change
   (same verification as step 2). If the state changed — done, no button touched.
2. Otherwise the gated button click. Gate: the matching button (normalized text ==
   normalized value) must (a) be a descendant of the detected choice container that
   holds the fid-stamped hidden input, (b) NOT match the submit vocabulary
   /^(submit|apply|send|continue|next|enviar|candidatar)/i, and (c) have
   `type="button"` or no `<form>` ancestor. Note the motivating page has NO `<form>`
   at all — condition (c) alone would blanket-allow, which is why (a) and (b) carry
   the rail there.
3. Refusal or no match → `{ok:false, reason:'choice-needs-user-click'}`; the panel
   renders a "select on the page" hint for that reason.

The general BUTTON rail in `fillOne` is unchanged for everything outside this branch.

Verification (both steps): snapshot (hidden input checked/value, each button's
className + aria-pressed/aria-checked/data-state) → act → next-frame re-snapshot; any
delta = ok, no delta = `{ok:false, reason:'no-state-change'}`.

### B2. fillCombobox hardening (`fill.ts`)

- `listboxOf` scoped: aria-owns/controls first; else a `[role=listbox]` that was NOT
  present before our interaction (pre-click snapshot of mounted listboxes); the
  document-wide fallback is removed. No attributable listbox → fail.
- If no exact normalized match among mounted options: `setNativeValue(el, value)` to
  drive the typeahead, wait ≤500ms for options, then exact match only (prefix fallback
  removed). Select → verify the control's committed value/text contains the choice;
  mismatch → `{ok:false, reason:'no-matching-option'}` and the control restored to its
  pre-fill value (never cleared to `''` — page-sourced values must survive).

### B3. Fill reports consumed (`scan.ts`, `App.tsx`)

`JFF_FILL` replies (`FillReport {filled, failed[]}`) are collected per frame during
scan-time auto-fill and returned in the scan result. Panel state records per-fid
outcomes: the status line's `filled` = page-accepted count (A9 semantics); a failed
auto-fill row shows its reason and drops back to needs-input styling. (Accept/Fill
actions already verify per-field; this closes the batch path — the handoff's known gap.)

## Error handling

- Harvest/click timeouts degrade to the pre-fix behavior (empty options, no label) —
  never fail the scan; harvest always restores the snapshotted value.
- Every new refusal is a first-class `fill.failed` reason surfaced on the row:
  `choice-needs-user-click`, `no-state-change`, `no-matching-option`,
  `resume-field-not-identified` (scan note).
- Frame election with a single frame is a no-op (elects it); zero fields overall keeps
  the existing empty-scan path.

## Testing

- Checked-in HTML fixtures distilled from the Ashby dump (scratchpad
  `ashby-dump3.json`), one per pattern: dangling-label combobox, yes/no choice (En +
  Sim/Não), RADIO-backed choice, radio fieldset with child label, single-option consent,
  description as control-sibling + as control-uncle, two file inputs, reCAPTCHA
  textarea, select-with-placeholder, styled hidden checkbox (stays `checkbox`),
  First/Last shared wrapper. Unit tests drive enumerate/dom/fill against them (vitest +
  jsdom; self-hidden/clipped states injected via `MeasureFn` since jsdom computes 0×0
  rects).
- Fill-path bypass tests: untyped button inside a `<form>` never clicked; submit-worded
  button refused even with no `<form>` on the page; choice with click-accepting hidden
  input fills with zero button clicks; foreign-frame field never auto-filled, never
  resolved, never harvested; autofill-pane input never receives the resume;
  cross-combobox listbox never used; harvest leaves a pre-set combobox value identical.
- e2e (Playwright + seam build): fixture page replicating the Ashby patterns in a
  cross-origin iframe (a SECOND static-server instance — `e2e/static-server.ts`
  currently serves one root on one origin — which also exercises the per-frame
  webNavigation injection from `295ff05`) plus a top-frame newsletter input — asserts
  election, demotion, page-order rendering, choice fill end-to-end; two-frame election
  test including the pasted-job-text case.
- Existing suites must stay green: `npm run verify` (typecheck + lint + unit + e2e).
  `App.test.tsx`/`ScanStatus.test.tsx` change deliberately with the A9 status-line
  semantics.

## Out of scope

- Resolve cancellation on navigation (host-protocol change, spec-deferred from v1).
- Election override ("treat this frame as the application") — deferred; the named
  elected frame in the "Other page fields" header is the interim mitigation.
- The foundation e2e load-flake hardening slice (pre-existing, tracked in HANDOFF.md).
- Host sharp edges (machine-specific paths, ESLint scope) from session 1.
- Broader panel UI/UX pass beyond the row rendering/ordering above.
- Live-Ashby validation of choice-click behavior (manual gate after implementation
  confirms which fillChoice step fires on the real page).

## Execution

Three plan slices, in order: **A-core** (A1–A5: labels, required, choice kind,
descriptions+plumbing, junk/currentValue), **A-interaction** (A6–A9: harvest, election,
resume targeting, panel), **B** (B1–B3: fillChoice, combobox hardening, fill reports).
B3's report plumbing may land earlier if the plan finds the observability cheaper first.
The full diff spans shared schema + content + panel + host prompts — the implementation
code review runs at effort **xhigh**, and plan-level review (fresh-context Opus + codex
cross-vendor) precedes Task 1, per standing workflow rules.

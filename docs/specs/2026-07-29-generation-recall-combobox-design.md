# Generation quality + recall + combobox fill (session-7 bug batch)

Fixes the six defects/features from the 2026-07-29 manual test round (user report with
screenshots), including the handoff's OPEN FINDING (re-scan idempotency). Authored in
autonomous mode: the user pre-delegated all brainstorm/design decisions ("go with the
most recommended one automatically always"). Each decision below records the alternative
considered.

## TODO

Implementation status. Tick as each lands with its tests.

- [x] B1a `fillCombobox` always drives the typeahead: focus + `setNativeValue` after the
      open click even when no listbox mounted; post-type wait ≥ 2000ms (async option fetch)
- [x] B1b matching ladder: exact normalized match, else UNIQUE normalized-substring match;
      zero or ambiguous → fail
- [x] B1c verification: committed control text must normalized-equal the CLICKED option's
      text; `FillReport.filled` entries become `{handle, committed}` and the panel
      canonicalizes the row value from `committed`
- [x] B1d new reason `combobox-no-listbox` (never opened/attributed) split from
      `no-matching-option` (Plan-3 Decision 6 debt), both with `REASON_HINT` copy
- [x] B2a CV text extraction at resume upload (pdfjs-dist legacy in the panel), stored
      beside the blob in IndexedDB; lazy re-extract for an already-stored resume
- [x] B2b `generate` request carries `cvText`; prompt gains trusted CV block + projects
      block; rules split factual (facts/CV only, refuse if absent) vs subjective
      (compose from CV × job post, never refuse)
- [x] B2c host `projectsPaths` config: local project files read + capped into the prompt
- [x] B2d codex reviewer pass (`codex` CLI, gpt-5.6-sol) refines the draft; graceful
      fallback to the unreviewed draft on any codex failure
- [x] B3 per-field generating state (`Set<string>`), gen-epoch guard on `onGenerate`
- [x] B4 "Generate all remaining (N)" sequential loop with per-row spinners + progress
      label, aborts on re-scan or terminal host error
- [x] B5a waterfall tier-1 (`already-on-page`) also attaches the recognized `key`
- [x] B5b `buildSaveItems` lets page-sourced rows with a factual key through (profile /
      answer_bank learning); qa_memory still never sees page-sourced text
- [x] B5c recognized-key / llm-key rows with NO stored value fall through to the exact
      qa_memory match before landing on needs_input
- [x] B5d `FieldRow` choice highlight + committed values compare NORMALIZED, not `===`
- [x] B5e `fillChoice` step 0: page already verified at the requested state → `{ok:true}`
      (kills the re-scan demotion of correct answers — the handoff OPEN FINDING)
- [x] B6 ProfileEditor "Generate from CV": host `facts.extract` maps CV text onto the 18
      fact keys; panel merges into EMPTY draft fields only
- [x] E2E: fixture combobox loads options only after typed input (async, filtered);
      choice re-scan stays green; combobox canonicalization covered
- [x] Manual browser gate on the real TRM/Ashby page, every workflow step printed
      (2026-07-29 agent-driven; full results in the v1 plan's Manual handshake log)

## Context (root causes, confirmed by code recon)

1. **Dropdown fill no-ops** — `fillCombobox` (`fill.ts:193-254`) only types into the input
   if a listbox mounted from the bare `.click()` (`fill.ts:240`). Real Ashby comboboxes
   ("Start typing...") mount options only AFTER keystrokes, so the fill bails instantly,
   returning `no-matching-option` without visible effect. Compounding: matching requires
   EXACT equality, so a partial query ("bra" → Brazil) could never succeed by design.
2. **Unusable AI drafts** — `buildGenerationPrompt` (`generate.ts:26-64`) rule 3 mandates
   a one-sentence refusal when the closed 18-key facts block can't answer. The CV never
   crosses native messaging (v1 privacy stance, `resume.ts:36`), no narrative facts
   exist, so refusals are the designed outcome for every subjective question.
3. **Spinner steals** — a single `generatingRef: string | null` (`App.tsx:80`); a second
   click overwrites the first, and the first completion nulls the second's spinner.
4. **No generate-all** — only per-row buttons exist; no batch message needed (loop in
   panel).
5. **Not remembered after refresh** —
   - Full Name/Email/Phone were tier-1 `already-on-page` (Ashby's resume auto-parse).
     `buildSaveItems` skips `source==='page'` rows (`save.ts:66`), and tier-1 resolutions
     carry no `key`, so the values are never learned; after refresh the empty fields
     resolve `recognizer:<key>:no-stored-value`. Exact match with the user screenshot
     (`llm-key:location:no-stored-value`).
   - A recognized key with no stored value short-circuits (`waterfall.ts:64`) without
     trying the qa_memory exact match two lines below — a saved answer under the
     normalized question is invisible.
   - Choice highlight uses strict `===` between value and option text
     (`FieldRow.tsx:108`) while fills match normalized (`fill.ts:8`) — "saved answer
     badge but nothing selected".
   - Re-scan demotes correct choices: `fillChoice` clicking a button already at the
     requested state yields no fingerprint delta → `no-state-change` → demotion
     (HANDOFF OPEN FINDING).
6. **No facts autofill** — facts are hand-typed only; CV text is not extractable today.

## Design

### D1. Combobox fill (`extension/src/content/fill.ts`)

Open click stays. Then unconditionally: `input.focus()`, `setNativeValue(input, value)`
(input+change events — the React-compatible typeahead trigger), then poll for an
attributable listbox + options for `COMBOBOX_TYPE_WAIT_MS = 2000` (50ms interval; the
options come from a debounced network fetch on the real page, 500ms was never enough).
The pre-type 500ms fast path stays for widgets that mount options on click.

Matching ladder against the attributable listbox's `[role=option]`s:
1. exact `norm(option) === norm(value)`;
2. else options where `norm(option).includes(norm(value))` — proceed ONLY if exactly one;
3. else fail: `combobox-no-listbox` if no listbox was ever attributed, otherwise
   `no-matching-option`.

Verification: click the option, next-frame re-read; success iff
`norm(committed) === norm(clickedOptionText)`. The requested value no longer has to
equal the committed text — "bra" legitimately commits "Brazil". `failClosed()`
(escape/blur/restore) unchanged for all failure paths.

**Protocol**: `FillReportSchema.filled` entries become
`z.object({ handle: FieldHandleSchema, committed: z.string().nullable() })` — `committed`
carries the canonical page-accepted text when it differs from the requested value, else
null. All consumers are in-repo (scan.ts collection, App.tsx counts, e2e assertions);
they update in the same slice. The panel writes `committed` into `edits[ref]` so the row,
subsequent saves, and the choice highlight all use the canonical text.

Alternative considered: keep exact-match-only and force users to type full option text —
rejected, it contradicts how the user demonstrably uses the field ("bra" + Fill).
Unique-substring keeps the no-wrong-option guarantee (ambiguity fails closed).

### D2. Generation context + reviewer (host + panel)

**CV text (panel)**: new `extension/src/panel/cvText.ts` — pdfjs-dist (legacy build,
worker disabled) extracts text at `onPickResume` time; `StoredResume` gains
`text: string | null`. For an already-stored resume without text, extraction runs lazily
on first need. Non-PDF or extraction failure → `text: null`; generation proceeds without
the CV block (silent degradation — the draft rules already handle absent context; no new
warning UI).

**Privacy note (user-decided 2026-07-29)**: extracted CV TEXT crosses native messaging
into prompts. This deliberately supersedes v1's "resume never crosses native messaging";
the raw file still never crosses.

**Request**: `generate` params gain `cvText: z.string().optional()`; `facts.extract`
(new) takes `{ cvText: z.string().min(1) }`.

**Projects (host)**: config gains `projectsPaths: string[]` (default `[]`, absolute
paths). At generate time the host reads each existing file (cap 4000 chars each, total
cap 12000) into a "PROJECT NOTES" block. Missing/unreadable paths are skipped silently.
Satisfies "optionally scan local project files" with zero new protocol.

**Prompt rewrite** (`buildGenerationPrompt`): keeps the security fencing for page-derived
strings. Adds trusted blocks: `CANDIDATE CV (trusted, from the candidate's own resume)`
capped 12000, and `PROJECT NOTES` when present. Rules change:
- Factual claims (employers, technologies, metrics, degrees, dates) only from facts/CV/
  project notes; if a factual question has no basis, one plain sentence saying what is
  missing — unchanged honesty rule.
- NEW: subjective questions (motivation, "why us", preferences, working style, biggest
  achievement framing) are answered constructively by connecting the CV and project
  notes to the job post; alignment between demonstrated work and the role is a truthful
  basis. Refusing these when CV context exists is forbidden.
- Existing voice/length/language rules stay.

**Reviewer pass**: new `host/src/llm/codexCli.ts` — a `CodexRunner` mirroring
`ClaudeRunner.complete` but spawning the codex CLI non-interactively (exec mode, model
`gpt-5.6-sol`, JSON-only output; the implementer verifies exact flags against
`codex exec --help` on this machine). Config: `codexPath` (default `'codex'`). New
`host/src/llm/reviewDraft.ts`: prompt = question + the same trusted/untrusted context +
the claude draft; instructions: remove any factual claim not grounded in the provided
context, tighten wording, enforce length/language/voice rules, return
`{"draft": "..."}`. Handler pipeline for `generate`: claude draft → codex review →
final. ANY codex failure (not installed, non-zero exit, timeout 120s, parse) → log to
host log + return the claude draft (`reviewed` never surfaces to the UI — YAGNI).

Alternative considered: single claude call with self-review instructions — rejected, the
user explicitly mandated a gpt-sol reviewer stage.

### D3. Per-field generating state + Generate all (panel)

`generatingRefs: ReadonlySet<string>` replaces `generatingRef`. `onGenerate`: functional
add/remove of ITS ref only; gen-epoch guard (`resetGenRef`) added so drafts from a dead
scan never land in `edits` (existing gap). Row prop: `generating=generatingRefs.has(ref)`.
Concurrent per-row generates stay allowed (independent host requests).

"Generate all remaining (N)": button in the needs-input group header, visible when N ≥ 1
eligible rows (needs_input, non-foreign, non-empty label, no existing draft/edit, not
currently generating). Sequential loop over eligible rows through the SAME per-ref
generate path (spinners light row by row); label shows `Generating i/N…`; loop aborts
when the gen epoch changes or a host error of kind `not_installed`/`not_authed`/
`rate_limit` surfaces (per-row transient errors skip that row and continue). No new host
protocol.

Alternative considered: parallel fan-out — rejected; each generate spawns a claude CLI
process + a codex process, and parallel spawns would thrash the machine and the rate
limit for zero UX gain over row-by-row progress.

### D4. Recall correctness (host waterfall + panel save/render + fill idempotency)

- **Tier-1 key harvest** (`waterfall.ts:49-52`): `already-on-page` resolutions also run
  `recognize(label, db)` and attach the key (value stays the page's).
- **Save** (`extension/src/panel/save.ts`): page-sourced rows pass through when
  `resolution.key !== null` (exempt from the `engine === final` drop; the host upsert is
  idempotent). Page-sourced rows never reach qa_memory (ATS noise must not poison it) —
  the existing host `save` routing by `fieldKey` already guarantees profile/answer_bank.
- **Waterfall fall-through**: extract the tier-3 exact-match lookup into a helper; the
  `recognizer:<key>:no-stored-value` and `llm-key:<key>:no-stored-value` paths try it
  before resolving needs_input (resolution keeps BOTH `key` and `answerId` when the
  fallback hits; reason `exact-match:key-fallback`).
- **Choice highlight** (`FieldRow.tsx`): option selected-state and value comparison use
  the same whitespace/case normalization as `fill.ts`'s `norm` (helper moves to
  `@jff/shared`); rendering canonicalizes to the option's own text.
- **fillChoice step 0** (`fill.ts`): before any click, if the target hidden input is
  already at the requested state (radio/checkbox: `checked === want`; value-mode:
  normalized equality) OR the matching button's fingerprint already shows active state
  (`aria-pressed`/`aria-checked`/`data-state`), return `{ok: true}`. This is verified
  page state equal to the requested state — success stays honest under the spec's
  "success ONLY on verified page state" rule; nothing is weakened (a click that changes
  nothing still fails). `election.spec.ts`'s paste-rescan expectations update
  accordingly (the :165-170 warning comment is superseded BY DESIGN here, not eroded).

### D5. Facts from CV (`ProfileEditor.tsx` + host)

"Generate from CV" button beside Save (disabled when no stored resume text). Panel sends
`facts.extract { cvText }`; host prompts claude to map the CV onto the 18 `FIELD_KEYS`
(zod: every key optional string; unknown keys stripped), returns the record. Panel merges
into EMPTY draft fields only — user-typed values are never overwritten — and the user
still reviews and presses Save (no silent persistence). Extraction failures surface the
existing host-error copy.

## Error handling

- Combobox: `combobox-no-listbox` and `no-matching-option` are distinct `REASON_HINT`
  rows ("Open this dropdown on the page yourself" vs "No option matches — pick another
  value"). All fill failures keep restoring the pre-fill value.
- Codex reviewer: every failure class degrades to the unreviewed claude draft; the host
  log records the codex error kind. Codex NEVER blocks generation.
- pdf extraction failure → `text: null`, generate/facts-extract proceed with what exists;
  `facts.extract` without text is unreachable (button disabled).
- Generate-all: terminal host errors stop the loop with the standard host-error banner;
  transient per-row failures skip and continue; re-scan aborts silently.

## Testing

- Unit (vitest+jsdom): typing-loaded combobox fixture (options mount only after `input`
  event, async, substring-filtered) — covers bare-click widgets, type-to-load widgets,
  ambiguous substring failure, no-listbox failure, committed-text canonicalization;
  `fillChoice` step-0 idempotency (already-checked radio, already-active button, and a
  no-op click still failing); `buildSaveItems` page-sourced keyed rows; waterfall
  fall-through (recognizer + llm-key paths); `FieldRow` normalized highlight;
  `App.test.tsx` per-ref spinner independence under concurrent generates + generate-all
  order/abort; `buildGenerationPrompt` block presence (CV/projects) + rule text; review
  pipeline fallback (fake codex runner failing every class); `facts.extract` handler
  (fake runner) + ProfileEditor empty-only merge.
- e2e (Playwright, seam build): fixture combobox converted to type-to-load; scan → fill
  "bra" → asserts committed "Brazil" in the panel row and on the page; double-scan of a
  filled choice page keeps `filled` counts (no demotion); existing 13 specs stay green.
- `npm run verify` (idle machine), then `npm run build` to restore the plain dist.
- Manual gate on the real TRM/Ashby page (agent-driven browser, every step printed):
  country combobox fill, generate on the two screenshot questions (asserting
  non-refusal, CV-grounded content), concurrent spinners, generate-all, save → refresh →
  re-scan recall of Full Name/Email/Phone + choice highlight, facts-from-CV.

## Out of scope

- DOCX/RTF resume text extraction (PDF only; others degrade gracefully).
- Cancelling in-flight generations; parallel generate-all.
- A `reviewed` badge or any reviewer-visible UI.
- Election override, resolve cancellation on navigation (still deferred from v1).
- Any change to the general BUTTON rail (`fill.ts:267-270` stays byte-identical) or to
  the never-auto-submit stance.

## Execution

Single plan, sliced: (1) fill-side (D1 + D4 fillChoice/FieldRow/save/waterfall),
(2) generation pipeline (D2 + D5), (3) panel concurrency/batch UI (D3) — slice 3 depends
on nothing in slice 2 except the generate path signature, so 2 and 3 stay separate
tasks in one plan. Reviews: fresh-context Opus 5 plan review + codex cross-vendor
review BEFORE task 1 (standing rule), pre-dispatch greps per batch (session-6 standing
rule), consolidated Opus 5 branch review + codex review at the end.

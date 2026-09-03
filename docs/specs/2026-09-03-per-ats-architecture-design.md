# Per-ATS architecture and four open defects: design

**Date:** 2026-09-03
**Grilled on:** Fable 5.1, three rounds, 16 questions, all answers recorded here.
**Companion docs:** `CONTEXT.md` (four entries added during the grill: ATS module,
Ignored field, Capture; Learned rule was proposed and dropped),
`docs/adr/0007-per-ats-knowledge-lives-in-code.md`.
**Input:** the handoff of 2026-09-03 (defects 7 to 10) and the user's ask:
"architecture this project in a way which is fine to add-on and improve on the
scanner individually for each platform".

## Goal

Give every ATS a place of its own in the code, so a Greenhouse fix cannot
regress Ashby and an unknown ATS still gets the generic path, and fix the four
defects the handoff left open, three of which are ATS-shaped or state-shaped.

## Decisions, in the order they were grilled

| # | Decision |
|---|---|
| Q1 | Restore the profile from the pre-gate backup before any live test. (User runs the command; the auto-mode classifier refused it.) |
| Q2 | Defect 10 ships as its own small plan first. The architecture plan carries defects 7, 8 and 9. |
| Q3 | An ATS may override, as optional layers over one generic path: detection, an empty-scan hint, junk rules, control handling, mapping hints for the Native host, the job description locator, Canonical URL rules. User control over the job description text and a per-field Ignore were added to the ask. |
| Q4 | The Native host knows the ATS: the extension detects it once per page and sends it with the scan. Recognizers stay generic by default. |
| Q5 | First cut: generic, Greenhouse, Ashby. Other ATSes get a module only when there is a real page to test against. |
| Q6 | A zero-field scan shows an explicit empty state, and an ATS module may add a hint. Clicking the page on the user's behalf is a later opt-in, not part of this design. |
| Q7 | The Session owns outcomes and progress. The status line is derived on every display from Session plus live state and is never stored as a screen state. |
| Q8 | Defect 9 is designed first, then gated by the user's live run. (The mechanism was traced during the fact pass; see E.) |
| Q9 | Generation never writes a Known key. A Draft can only become a Saved answer. |
| Q10 | Sessions only: ATS knowledge reaches the code through a session with the maintainer, never through runtime self-adaptation. ADR 0007. |
| Q11 | Superseded by Q16: no per-ATS ignore memory. |
| Q12 | Job description: extractor excludes script, style, noscript and template text; order is user paste, ATS locator, user-picked selector, heuristic; a heuristic pick is never learned; the panel shows source and size and offers "Not the job description". |
| Q13 | A Capture action in the panel saves a sanitised DOM, the scan result, the resolutions and the Ignored fields under the app directory. |
| Q14 | Defect 10 is cut at three points: the host's save handler never writes facts; the panel never sends fact rows through Save answers; fact rows with no stored value are not generation-eligible and offer "Save to profile" instead. |
| Q15 | One shared ATS registry, used by both sides. Identity comes from the elected frame's origin, not the tab URL. ADR 0003's host list folds into the registry. |
| Q16 | Ignore is Session-scoped: it hides the row for this application and is recorded in the Capture. |

## Scope

Six deliverables, five plans. The review wave split C: its two defect fixes
need nothing from B, and stacking them behind the architecture branch delayed
the only two user-visible fixes in the set.

- **A. Profile write guard** (defect 10). Plan `2026-09-03-profile-write-guard.md`.
- **B. ATS identity and modules**, including the job description work. Plan
  `2026-09-03-ats-identity-and-modules.md`.
- **C1. Panel state and the empty scan** (defects 8 and 7). Plan
  `2026-09-03-panel-state.md`.
- **C2. Ignored field, Capture, and the ATS evidence loop**. Plan
  `2026-09-03-ignore-and-captures.md`.
- **D. Serial choice fill** (defect 9, contained not cured). Plan
  `2026-09-03-serial-choice-fill.md`.
- **E. Docs**: this spec, ADR 0007, the glossary entries. Done during the grill.

Execution order, as one linear branch stack: A, C1, D, B, C2. Each branch is
created from the previous and its PR is based on the previous, retargeted to
`ai-staging` as the parent merges. They all edit `App.tsx`, and the stack is
what keeps them from colliding. C2 consumes B's ATS modules; C1 does not, and
deliberately ships before B so defects 7 and 8 land first.

Out of scope, deliberately: Workday, Lever, Gupy modules; an ATS gesture that
clicks the page to make the form present; a control adapter hook (the fill
gesture is generic today and a superset of both ATSes' needs, so the hook is
added the day a Capture shows a third shape); folding `company.ts`'s platform
list into the registry (it serves company guessing across eleven platforms and
has no scan behaviour attached).

## Traced mechanisms (facts, from the code pass)

### Defect 10: how a Draft reached the profile table

1. `host/src/resolve/waterfall.ts:63-90`: a Field that a recognizer maps to a
   Known key with no stored value resolves as `needs_input` **and keeps `key`**
   (`reason: recognizer:<key>:no-stored-value`). The LLM path does the same at
   `:167`.
2. `extension/src/panel/App.tsx:1333`: Generation writes the Draft into
   `session.edits[ref]`, the slot a manual edit uses. Provenance `generated` is
   recorded in `session.answers` but nothing on the save path reads it.
3. `extension/src/panel/save.ts:88`: `buildSaveItems` attaches
   `fieldKey: resolution.key` to every item unconditionally; the page-keyed
   passthrough at `:65-69` widens the door for page-sourced rows.
4. `host/src/handlers.ts:118-127`: any item with a non-null `fieldKey` is
   written to `profile` or `answer_bank` with no provenance or shape check.

The lowercased names and the lost `https://` prefixes are not a write-path bug:
no normaliser exists anywhere on that path; the values are what Resume
extraction returned. Out of scope here.

### Defect 8: why "Waiting for the local host" survives a green host banner

`App.tsx:1175`: the auto-scan effect sets `scanStatus = {kind:'connecting'}`
whenever the scan gate is closed. When the gate opens the effect calls
`onScan`, which returns early for a parked session (`App.tsx:859`) without
touching `scanStatus`. The screen keeps a status the live state never earned.
A tab round-trip clears it because `display()` reseeds from
`session.lastOutcome`.

### Defect 7: the empty state exists and did not render

`App.tsx:1054` maps a zero-field outcome to `{kind:'empty', frames}` and
`ScanStatus.tsx` has copy for it. On the live Ashby wrapper page nothing
rendered. The scan path has three zero-field returns in `scan.ts` (`:169`
retry still empty, `:260` form gone after the resume upload, `:295` only junk;
the captcha returns never render `empty` because `App.tsx:1051-1053` gives
captcha precedence) and the "Scan anyway" path in `App.tsx:1697-1710` re-triggers
through `scanNonce`. Which of these went silent is not yet known; C's task for
it carries a unit test for the empty render on every zero-field return and the
live gate re-checks the Ashby page.

### Defect 9: the false commit

`extension/src/content/fill.ts:349-460` (`fillCombobox`): when the open gesture
finds no option, the filler types the value into the input (`setNativeValue`),
waits for an option, clicks it, then verifies with
`norm(committed) === optionText` where `committed = input.value` when the input
is non-empty. If the typed value already equals the option text, a click that
did **not** commit passes verification: `input.value` still holds the typed
text. "oth" to "Other" passed honestly because the typed text differed from the
option; "Bachelor's Degree" typed against the option "Bachelor's Degree" is the
false pass. The menu stays open because nothing closed it, and the next field
opens its own: three open dropdowns is three false passes in a row. The same
false pass has a second shape: a widget that closes its menu on the click
without selecting, leaving the typed text in place. Both shapes are on the
typeahead path only (`fill.ts:426-427`); when the open gesture finds the option
without typing, `input.value` is empty and the structural fallback decides.
A separate question, not yet answered, is why the option click failed on the
live Degree widget at all; the commit gesture is a bare `hit.click()`
(`fill.ts:439`), and the C2 spike showed react-select needs the full pointer
sequence to open, so the same may hold for selecting.

### ATS identity today

- The resolve payload carries `url` and `hostname` of the tab, not the frame
  (`shared/src/messages.ts:42-52`).
- The relay stamps every frame reply with the frame's url
  (`extension/src/relay.ts:5,22`), and `scan.ts:198-203` already puts the
  elected frame's url into `ElectionOutcome.url`. The elected frame's origin is
  therefore available to the panel without a content-script change.
- The only executable ATS list is `ATS_HOSTS` in `host/src/canonicalUrl.ts:29`
  (`greenhouse.io`, `ashbyhq.com`).
- Recognizers see the label text only (`host/src/resolve/recognizers.ts:38`).
- The job description extractor (`extension/src/content/jobpost.ts`) reads
  `textContent`, which includes inline script and style text; and `scan.ts:210`
  auto-saves a heuristic pick as the learned selector for the hostname.

## Requirements

### A. Profile write guard

- **A1.** The Native host's `save` handler never writes `profile` or
  `answer_bank`: the keyed branch is deleted. `SaveItem.fieldKey` becomes
  `z.null()` in the schema, so a `save` request carrying any fact key fails as
  a whole with `bad_request` at validation, before the handler runs. This is an
  invariant, not a runtime condition, so a partial save would hide a panel bug.
- **A2.** `buildSaveItems` excludes every row whose resolution has a non-null
  `key`. The page-keyed passthrough (`save.ts:65-69`, "B5b") is removed with
  it. The `fieldKey` property stays in the shape for one release so an old
  panel talking to a new host fails loudly under A1 rather than silently.
- **A3.** A row whose resolution has a non-null `key` never shows "Generate with
  AI" and is skipped by "Generate all remaining". In its place, when the key
  has no stored value behind it (`source` not in `profile`, `answer_bank`,
  `llm_key`: that is `needs_input`, page-sourced, and the saved-answer
  key-fallback rows), it shows **Save to profile**: one click writes the row's
  current value, with the same precedence Save answers uses (page snapshot,
  then panel edit, then engine value), to that key via `profile.set` or
  `answerBank.set`, then refreshes the panel's facts. The button is disabled
  while the value is blank. Rows with a stored value show neither button;
  Accept and Fill are unchanged.
- **A4.** The generate-all batch (`App.tsx` `generateAll` loop) filters keyed
  rows out of its total before it starts, so the count on the button is the
  number it will actually draft.
- **A5.** A profile value is a single line: `profile.set` and `answerBank.set`
  normalise whitespace (newlines included) to single spaces and reject a
  normalised value longer than 500 characters with `bad_request`. Facts are
  typed into inputs; a paragraph is never a fact. The Profile editor and the
  onboarding finish check the host's answer and show a refused save instead
  of returning to the session view as if it had succeeded.
- **A6.** The one e2e case that proved the removed path (`e2e/full-loop.spec.ts`,
  Save answers writing `workAuth` into `answer_bank`) is inverted and extended
  to drive Save to profile.

### B. ATS identity and modules

- **B1.** `shared/src/ats.ts` exports `ATS_IDS = ['generic', 'greenhouse',
  'ashby'] as const`, `type AtsId`, `ATS_HOSTS: Record<Exclude<AtsId,
  'generic'>, readonly string[]>` (`greenhouse: ['greenhouse.io']`, `ashby:
  ['ashbyhq.com']`), `detectAts(hostname: string): AtsId` (lowercase, strip
  `www.`, domain-boundary suffix match, `generic` when nothing matches) and
  `isAtsHost(hostname: string): boolean` (`detectAts(h) !== 'generic'`).
- **B2.** `host/src/canonicalUrl.ts` uses `isAtsHost` from the registry. Its
  behaviour and tests are unchanged.
- **B3.** The panel detects the ATS from the elected frame's url, falling
  back to the tab hostname when the frame url is null. One procedure, one
  election: junk-drop with the generic rule, elect, detect from the winner,
  apply the winner's module rule to the elected frame's fields only. There is
  no second election, so the identity cannot drift; the procedure runs again
  wherever the election does (after the resume-upload re-enumeration). With no
  election (a zero-field scan), the ATS is the first non-generic detection over
  the tab hostname and every frame url, so an Ashby iframe on a wrapper page
  still yields `ashby` for the empty-state hint. `ScanOutcome`, `Session` and
  the `resolve` payload gain `ats: AtsId`. A session with no scan yet, or one
  stored before this change, reads as `generic`.
- **B4.** `recognize` takes `{ label, name }` and a db. A baseline recognizer
  entry may carry an `unless: RegExp`; the match is vetoed when `unless`
  matches the label or the name, and the Field falls through to the next tier.
  Learned mappings are never vetoed. The one seeded veto goes on the existing
  `earliestStart` entry:
  `unless: /(^|[^a-z])(month|day|year|mm|dd|yyyy)([^a-z]|$)/i`.

  **The veto is generic, not per-ATS.** The review wave rejected the original
  `ATS_RECOGNIZER_VETOES: Partial<Record<AtsId, …>>` design: no ATS wants the
  free-text `earliestStart` answer typed into a numeric date-year input, so
  filing the rule under `greenhouse` would have left the same mis-targeting
  live on every other ATS while paying for a per-ATS table. Per-ATS recognizer
  knowledge is built the day a case is genuinely ATS-specific; nothing in the
  evidence is.

  The veto also needs its second exit closed. A vetoed tier-2 hit reaches the
  LLM, whose `known_key` branch (`host/src/resolve/waterfall.ts:145-150`) can
  name the same key, find the stored value and emit a `proposed` resolution
  the user can Accept. The same `unless` therefore guards that branch too.
  `ats` still rides the `resolve` payload — it reaches `host.log` and a future
  mapping prompt would read it — but nothing branches on it yet.
- **B5.** `extension/src/ats/` holds one file per ATS plus `index.ts`:

  ```ts
  export interface AtsModule {
    id: AtsId
    /** Shown after the empty-scan copy. */
    emptyHint: string | null
    /** Extra junk rule, applied after the generic keepField. true = drop. */
    dropField: (f: EnumField) => boolean
    /** Tried before the learned selector. null = none known. */
    jobTextSelector: string | null
  }
  export function moduleFor(ats: AtsId | undefined): AtsModule
  ```

  `generic.ts` returns `{ emptyHint: null, dropField: () => false,
  jobTextSelector: null }`. `moduleFor` accepts `undefined` because a Session
  persisted before this change carries no `ats`, and returns the generic module
  for that and for any unrecognised id, never throwing. Every module has a unit
  test built on a fixture of its own ATS. The generic path's tests do not
  import any ATS module.

  Modules stay bundle-neutral: pure functions over `EnumField` and `Document`,
  no panel imports. When a content-side hook eventually arrives (a Workday
  gesture to make the form present), it reads its id from
  `detectAts(location.hostname)` in the frame itself, which yields the same id
  the panel derives from the elected frame's url, with no message change. That
  is what keeps the seam from being reopened by the third ATS.
- **B6.** Ashby module: `emptyHint`: `On Ashby the form is under the
  "Application" tab. Open it, then Scan again.` `dropField: () => false` and
  `jobTextSelector: null` in plan B; both are filled from the Ashby Capture in
  plan C2.

  **The junk rule this spec originally carried was withdrawn by the review
  wave.** It was `kind === 'file' && !visible && label === null`, and it is
  unsafe: `keepField` (`extension/src/panel/junk.ts:26`) already drops a hidden
  unlabelled file input unless `scoreResumeField(f) > 0`, so the only fields
  that rule can still reach are ones that scored as résumé candidates on their
  `name`, `idAttr`, `accept` or `required` — and Ashby's real résumé control is
  a dropzone over a hidden native input. The rule is therefore either a no-op
  or it drops the résumé target, `pickResumeTarget` returns null, and Ashby
  silently stops uploading the résumé. Writing it before the Capture existed
  also inverted ADR 0007's own rule that a module rule comes from observed DOM.
  Plan C2 writes it from the Capture, keyed on a signal that separates the two
  inputs, with an assertion that the résumé target survives it.
- **B7.** Greenhouse module: `dropField: () => false`, `emptyHint: null`,
  `jobTextSelector`: read from the Greenhouse Capture at execution time.
- **B8.** `dropJunk` takes the module: `dropJunk(fields, module)` keeps a field
  when `keepField(f) && !module.dropField(f)`.
- **B9.** Job description order and memory. `JFF_JOBTEXT` carries `selectors:
  { source: 'ats' | 'learned'; selector: string }[]` in try order; the reply's
  `source` is `'ats' | 'learned' | 'heuristic' | 'none'`. The panel builds the
  list as ATS locator first, learned selector second. `scan.ts` no longer calls
  `selector.save` on a heuristic result; only `onPickJobText` saves. The
  `≥ 400` character gate applies to every extracted source; a paste is the
  user's word and is not gated. The ATS locator is requested from frame 0,
  like every job text request today, so on a wrapper page whose form is an
  Ashby iframe the Ashby locator misses and the order falls through.
- **B10.** The extractor's `textOf` skips `script`, `style`, `noscript` and
  `template` subtrees (clone, remove, read). The picker uses the same function.
- **B11.** The Session stores `jobTextSource: 'pasted' | 'ats' | 'learned' |
  'heuristic' | 'none'`. Under the job description box the panel renders one
  line: `<n> characters, from <source copy>` where the copy is `your paste`,
  `the <ATS name> locator`, `your pick`, `a heuristic`, or `nothing found`.
  Next to it, when the source is `learned` or `heuristic`, a **Not the job
  description** button clears the session's jobText, calls the new host method
  `selector.clear { hostname, purpose }`, sets the source to `none` and leaves
  the picker as the next step.
- **B12.** The empty-scan copy gains the module's `emptyHint` when non-null:
  `ScanUiState` `empty` becomes `{ kind: 'empty'; frames: number; hint: string
  | null }`.

### C. Panel state, empty scan, Ignored field, Capture

- **C1.** One pure function decides the status line:

  ```ts
  export function statusFor(input: {
    gateOpen: boolean
    parked: boolean
    inFlight: ScanUiState | null      // the running scan's phase, this tab only
    actionFailure: ScanUiState | null // the last failed Accept/Fill/Pick, this tab only
    lastOutcome: ScanUiState | null   // session.lastOutcome
  }): ScanUiState | null
  ```

  Precedence: parked → null (the parked line is the whole message); in-flight
  → that; action failure → that; gate closed → `{kind:'connecting'}`; applied
  hit → null (the Revisit badge is the whole message); otherwise
  `lastOutcome`. `connecting` is never written to state. `scanStatus` in
  `App.tsx` shrinks to `inFlight` and `actionFailure`, both keyed by tab id in
  the runtime and owned by the code paths that produce them: the scan
  lifecycle for `inFlight`, the action handlers and a settled scan for
  `actionFailure`. `display()` writes and clears neither.
- **C2.** Every zero-field return of `runScan` reaches the screen as
  `{kind:'empty', frames, hint}`; a unit test drives all three returns and
  the "Scan anyway" path through the App and asserts
  `data-jff-status="empty"`.
- **C3.** `Session` gains `ignoredRefs: string[]`, cleared by
  `clearScanResults`. Every non-skipped `FieldRow` shows an **Ignore** button
  (`data-jff-ignore`). An ignored row leaves `main` and `foreign`, is skipped
  by Save answers, Generate all and the batched fill, and is counted in one
  line under the list: `<n> ignored · show`, which toggles a collapsed list of
  the ignored labels, each with **Restore**.
- **C4.** Capture. A **Save a capture** button (`data-jff-capture`) next to
  Discard session. The panel sends `JFF_CAPTURE { epoch }` to the elected
  frame; the content script answers `{ ok: true, html }` where `html` is the
  document's `outerHTML` after: removing every `script` element; removing the
  `value` attribute of every `input`; emptying every `textarea`'s text and
  every `[contenteditable]`'s text; clearing `selected` on every `option`;
  capped at 2,000,000 characters (truncated with a trailing
  `<!-- jff: truncated -->`). The panel redacts the scan evidence before
  sending: every field's `currentValue` and every resolution's `value` become
  null, and the host refuses an unredacted payload. The panel sends host
  `capture.save { ats, url, hostname, html, fields, resolutions, ignoredRefs,
  jobTextSource, election, frameReports }`; the host writes
  `<capturesDir>/<yyyy-mm-dd-hhmmss>-<ats>-<hostname>.json` (a configured
  directory defaulting to `<HOME_DIR>/captures`) and answers `{ path }`, which
  the panel shows in the save line. The privacy line, stated exactly: a
  Capture never leaves the machine, the directory is `0700` and the file
  `0600`, and what a Capture keeps is structure, not content.

  The first version of this line was wrong, and the review wave caught it three
  ways. "Typed Values are blanked" does not cover a committed choice:
  `fill.ts:448-452` documents that a successful react-select commit leaves
  `input.value` empty and writes the chosen text into a visible container, so
  after a fill the answers to work authorization, sponsorship, degree and
  notice period are ordinary page text. Nor did it cover a `checked` checkbox,
  which is an answer, or personal data sitting in `href`, `title`, `aria-*` and
  `data-*`. The redaction is therefore: drop `script`, `style`, `noscript`,
  `svg`, `img`, `iframe`, `link`; blank input values and `checked`, textarea
  and `contenteditable` text, and `option[selected]`; strip every attribute
  outside a small structural allowlist; and blank every text node and attribute
  whose value equals one of the values the panel holds, which is what catches
  the committed choice. Page text otherwise stays, including anything the ATS
  rendered from the Resume as text.
- **C5.** The Ashby and Greenhouse live pages are captured in plan C2; those
  two files are the fixtures for B6 and B7's `jobTextSelector` values, for the
  Ashby `dropField` rule, and for the two module tests. Capture is enabled on a
  zero-field scan, which is exactly the state whose evidence defect 7 needs.

### D. Serial choice fill

- **D1.** In `fillCombobox`, the commit gesture on the option is the same
  pointer sequence the open gesture uses (a strict superset of the click), and
  a commit is verified in two steps. First, **closed**: within
  `COMMIT_SETTLE_MS = 500` the attributable listbox is unmounted, or hidden by
  computed style, or the control reports `aria-expanded="false"`; a hidden
  but mounted menu counts as closed. Second, **evidence** of selection, one
  of: the input was emptied and the option text appears in a visible value
  container (react-select); the input's text was rewritten into the option
  text from something else; or the input already held the option text as
  typed, in which case a blur must leave it in place (a discarded typeahead is
  cleared on blur, a commit survives it). Non-input controls keep today's
  text check plus the closed step. A typed value equal to the option text is
  never evidence by itself. On a failed verification the filler runs
  `failClosed('no-commit')` (restore, Escape, blur).
- **D2.** Before the open gesture, if any `[role="listbox"]` is visible in the
  document, the filler sends Escape to the element that owns it (by
  `aria-controls` or `aria-owns`, else the active element), blurs it, and waits
  up to `CLOSE_WAIT_MS = 500` for it to close. If it stays visible the fill
  fails with `listbox-left-open` and never opens its own control.
- **D3.** `fillFields` stays strictly sequential and, between two consecutive
  choice-type fills (`combobox`, `select`, `choice`, `radiogroup`), waits for
  `waitForSettle` with a 300 ms ceiling.
- **D4.** Five unit fixtures in `fill.test.ts` pin the verdict, all
  type-to-load so the typeahead path runs: stubborn (menu stays, no commit),
  close-without-commit (menu closes, typed text discarded on blur), honest
  react-select, honest rewrite (typed prefix, canonical text committed), and
  honest exact (typed text equals the option, survives blur). The first two
  must fail `no-commit`; the last three must pass. Existing combobox fixtures
  that leave their listbox mounted after a commit are corrected to close it,
  as the widgets they model do; their expectations do not change.

### E. Docs and glossary

- **E1.** Written during the grill: CONTEXT.md entries, ADR 0007, this spec.
- **E2.** Each plan updates `docs/plans/README` if one exists (none does today)
  and ticks its own progress in-file.

## Gate

Each plan ends with typecheck, lint and unit green, and, at idle, `npm run
smoke` followed by a plain rebuild proven by `grep -rl 'jffFakeHost'
extension/dist | wc -l` printing 0. The user's live runs, in this order, close
the whole set:

1. Greenhouse page: scan, batch fill, Degree commits or is reported failed;
   the Save answers count excludes fact rows; `earliestStart` targets one field.
2. Ashby direct URL, landing state: the empty state renders with the Ashby
   hint. Application tab: the hidden autofill input is gone from the list.
3. Both pages: Save a capture, file lands under `~/.job-form-filler/captures/`.
4. Job description line reads the right source on both; "Not the job
   description" clears and the picker re-learns.
5. Park the session (navigate off-site), come back: no "Waiting for the local
   host" while the banner is green.
6. Profile table holds no prose after a generate-all plus save.

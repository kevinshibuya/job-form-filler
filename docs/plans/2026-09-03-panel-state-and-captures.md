# Panel state and captures implementation plan

**Goal:** The status line can only say what the Session and the live state currently earn; a zero-field scan always shows its empty state; the user can hide a wrong row for the Session; and one click saves a Capture the next ATS session can build on.
**Architecture:** One pure `statusFor` function replaces the stored `scanStatus` as the source of the status line, with in-flight and action-failure states kept per tab in the runtime and owned by the code paths that produce them. A unit test drives every zero-field return through the App. `Session.ignoredRefs` and an Ignore button hide rows for the Session. A `JFF_CAPTURE` content message returns a sanitised DOM, and a `capture.save` host method writes it with redacted scan evidence under a configured captures directory. The last task takes the two live Captures and fills the ATS modules' job description locators from them.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section C and "Defect 8", "Defect 7"
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `panel-state-and-captures`, created in Task 0 from `ats-identity-and-modules` (this plan consumes its `ats` field, `moduleFor` and the `empty` hint). Target `ai-staging`. Never commit on `main`.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests.
- Every task ends with `npm run typecheck` green before its commit.
- `npm run smoke` and `npm run verify` only on an idle machine; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- A Capture never leaves the machine: the only writer is the Native host, the only destination is the configured `capturesDir`, which defaults to `<HOME_DIR>/captures` (`HOME_DIR` is `host/src/config.ts:22`). Typed Values are blanked in the HTML and redacted from the scan evidence; page text stays, including anything the ATS rendered from the Resume as text.
- Capture cap is exactly 2,000,000 characters of HTML, truncated with the trailing comment `<!-- jff: truncated -->`.
- `runScan`'s zero-field returns, by current line: `scan.ts:169` (retry still empty), `:260` (form went away after the resume upload), `:295` (only junk on the page). The captcha returns at `:147`, `:217` and `:255` never render `empty`: `App.tsx:1051-1053` gives captcha precedence. A first-pass zero always falls through the retry (`scan.ts:154-168`), so "first pass empty" and "retry empty" are one path.
- Baseline at plan authoring, re-measured in Task 0: the unit count recorded at the end of `2026-09-03-ats-identity-and-modules.md`.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `panel-state-and-captures`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch from `ats-identity-and-modules`. Run typecheck, lint and unit tests; record the counts.

**Acceptance check:** `git branch --show-current` prints `panel-state-and-captures`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [ ] Create the branch
- [ ] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): panel state and captures, task 0 baseline`

### Task 1: `statusFor` and the end of stored screen states

**Files:**
- `extension/src/panel/status.ts` — create: `statusFor`
- `extension/src/panel/status.test.ts` — create
- `extension/src/panel/App.tsx` — modify: `SessionRuntime` gains `inFlight` and `actionFailure`; every `setScanStatus(...)` call becomes a write to the tab's runtime plus a render bump; the rendered status is `statusFor(...)`; the auto-scan effect's `{ kind: 'connecting' }` write at `:1175` is deleted; `display()` reseeds nothing and clears nothing; `lastOutcomeRef` is deleted
- `extension/src/panel/App.test.tsx` — modify: add the three cases below

**Interfaces:**
- Consumes: `ScanUiState`, `Session.lastOutcome`, `Session.parked`, `Session.appliedHit`, `scanGateOpen`
- Produces:

  ```ts
  export interface StatusInput {
    gateOpen: boolean
    parked: boolean
    appliedHit: boolean
    inFlight: ScanUiState | null
    actionFailure: ScanUiState | null
    lastOutcome: ScanUiState | null
  }
  export function statusFor(i: StatusInput): ScanUiState | null
  ```

  Precedence, first match wins: `parked` → null (the parked line is the whole message); `inFlight` → it; `actionFailure` → it; `!gateOpen` → `{ kind: 'connecting' }`; `appliedHit` → null (the Revisit badge is the whole message, as `App.tsx:930` does today); else `lastOutcome`. `connecting` is never written anywhere.

  Ownership of the two runtime fields, per tab:
  - `inFlight: ScanUiState | null` holds the phases `injecting`, `enumerating`, `retrying`, `resolving` (written by `onProgress`, `App.tsx:978-985`, which stays `alive(sc)`-gated) and `superseded` (written by the navigation handler at `:637`). Cleared by the scan that owns it when it settles or aborts, in its `finally`, **only if the runtime's generation still equals the scan's** (a dead scan must not clear a `superseded` a newer generation wrote), and by `endRuntime`.
  - `actionFailure: ScanUiState | null` holds `action_failed`, written at every `action_failed` site (four today: `App.tsx:1240, 1269, 1297, 1428`; five once the profile-write-guard plan merges). Cleared by `clearActionFailure`, by a settled scan of that tab, and by a generation bump.
  - `display()` touches neither: a tab round-trip cannot change the rendered status of a session whose inputs did not change, which is the invariant this task exists for.

**Work:** Keep the React state minimal: one `statusTick` counter bumped whenever a runtime status field changes for the displayed tab, so the render recomputes `statusFor`. Internal wiring beyond the constraints above is your choice.

**Acceptance check:** `npx vitest run extension/src/panel/status.test.ts extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with, in `status.test.ts`, one case per precedence rule; in App: (1) a parked session with the host answered renders the parked line and no `[data-jff-status]`; (2) with the gate closed and a non-parked session the panel shows `connecting`; park that session (an off-site navigation event) and then open the gate: no `[data-jff-status]` renders, where today `connecting` stays; (3) regression guard, green before and after: the generate-all round-trip case and a `done` outcome surviving a tab swap away and back. Red state: case 2's second half.

**Boundaries:** `ScanStatus.tsx` copy is unchanged. `generateAll` and `generatePaused` handling stays as it is (already per runtime).

- [ ] `statusFor` with its tests
- [ ] App wiring and the three cases; typecheck; commit `fix(panel): the status line is derived, never stored; parked sessions cannot show connecting`

### Task 2: Every zero-field scan renders its empty state

**Files:**
- `extension/src/panel/App.test.tsx` — modify: add the three cases below
- `extension/src/panel/App.tsx` — modify only if a case is red
- `extension/src/panel/scan.ts` — modify only if a case is red

**Interfaces:**
- Consumes: the zero-field returns listed in Global constraints; the "Scan anyway" button (`App.tsx:1697-1710`); `ScanUiState` `empty` with `hint`
- Produces: `data-jff-status="empty"` rendered in each case

**Work:** Drive the App with a fake relay: (a) `JFF_SCAN` answers zero fields on both passes (`scan.ts:169`); (b) a first pass with fields, a resume seeded, and the post-upload re-enumeration answering zero fields (`:260`); (c) only junk fields (a hidden unlabelled text input) so `kept` is empty (`:295`); (d) a session with `appliedHit` set, click `Scan anyway`, relay answers zero fields. Assert the status element in each; in (a) with an Ashby iframe url among the frame replies, assert the Ashby hint text. Note case (d) interacts with Task 1's `appliedHit → null` rule: "Scan anyway" clears `appliedHit` (`App.tsx:1704`) before the scan, so the rule does not hide the result; assert that ordering. If a case is red, find the path that drops the outcome and fix it at the source, not in the test; record under Progress which path it was. If all are green, record that the silent empty state was not reproducible in the unit harness and leave the live gate as the judge.

**Acceptance check:** `npx vitest run extension/src/panel/App.test.tsx -t "empty"` exits 0 with the four cases. Red state: at least one case is expected to be red; if none is, say so under Progress.

**Boundaries:** No copy changes. Do not add a retry.

- [ ] Write the four cases; fix what is red; commit `test(panel): every zero-field scan renders the empty state` (or `fix(panel): …` naming the path)

### Task 3: Ignored field

**Files:**
- `extension/src/panel/sessions.ts` — modify: `Session.ignoredRefs: string[]`, default `[]`, cleared by `clearScanResults`
- `extension/src/panel/sessions.test.ts` — modify: default and clear
- `extension/src/panel/FieldRow.tsx` — modify: `Ignore` button, new prop `onIgnore`
- `extension/src/panel/FieldRow.test.tsx` — modify: one case
- `extension/src/panel/group.ts` — modify: `buildRows(fields, resolutions, electedFrameId, ignoredRefs)` returns `{ main, foreign, ignored }`
- `extension/src/panel/group.test.ts` — modify: one case
- `extension/src/panel/App.tsx` — modify: `onIgnore`, `onRestore`, the ignored line and its collapsed list; `generateEligible`, the batched fill list and Save answers read `main`, which already excludes ignored rows once `buildRows` does
- `extension/src/panel/App.test.tsx` — modify: add the two cases below

**Interfaces:**
- Consumes: `Row`, `refOf`
- Produces: `FieldRowProps.onIgnore: (ref: string) => void`; a `data-jff-ignore="1"` button labelled `Ignore` on every non-skipped row; `PanelRows.ignored: Row[]`; a `data-jff-ignored-line` element reading `<n> ignored · show` (toggle text `hide`), rendered only when n > 0, with a list of labels each carrying a `data-jff-restore="1"` button labelled `Restore`

**Work:** Ignoring writes the ref into `session.ignoredRefs` through `writeSession`; restoring removes it. `buildRows` filters ignored refs out of both `main` and `foreign` and returns them as `ignored` in field order. Save answers, Generate all and the batched fill all derive from `main` and need no separate filter: assert it rather than add one.

**Acceptance check:** `npx vitest run extension/src/panel/group.test.ts extension/src/panel/FieldRow.test.tsx extension/src/panel/sessions.test.ts extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with: `buildRows` moves an ignored ref to `ignored`; FieldRow renders the button; App: clicking Ignore on a row removes it from the list, shows `1 ignored · show`, and the `save` request sent after clicking Save answers omits it; clicking Restore brings it back. Red state: `Session` has no `ignoredRefs`.

**Boundaries:** Skipped (demographic) rows have no Ignore button. Nothing is persisted outside the Session.

- [ ] Session field and tests
- [ ] `buildRows` and FieldRow with tests
- [ ] App wiring, line, list, cases; typecheck; commit `feat(panel): Ignored field, per Session`

### Task 4: Capture

**Files:**
- `shared/src/messages.ts` — modify: `JFF_CAPTURE { epoch }` content message; host method `capture.save` with the params below; `CaptureSchema`
- `shared/src/messages.test.ts` — modify accordingly
- `extension/src/content/capture.ts` — create: `sanitizedHtml(root: Document): string`
- `extension/src/content/capture.test.ts` — create
- `extension/src/content/index.ts` — modify: `JFF_CAPTURE` branch under the epoch gate
- `extension/src/panel/capture.ts` — create: `redactForCapture(fields, resolutions)` returning copies with `currentValue: null` and `value: null`
- `extension/src/panel/capture.test.ts` — create
- `host/src/config.ts` — modify: `HostConfig.capturesDir: string`, defaulting to `join(HOME_DIR, 'captures')` in `loadConfig`
- `host/src/config.test.ts` — modify: the default
- `host/src/captures.ts` — create: `writeCapture(dir, capture): string` (returns the path)
- `host/src/captures.test.ts` — create: writes under a temp dir
- `host/src/handlers.ts` — modify: `capture.save` case using `deps.config.capturesDir`
- `host/src/handlers.test.ts` — modify: one case with `config.capturesDir` set to a temp dir (the test builds `config` inline at `handlers.test.ts:35`)
- `extension/src/panel/App.tsx` — modify: `Save a capture` button next to Discard session; `onCapture`; the result line
- `extension/src/panel/App.test.tsx` — modify: one case

**Interfaces:**
- Consumes: `Session` fields `ats`, `startUrl`, `fields`, `resolutions`, `ignoredRefs`, `jobTextSource`, `election`, `frameReports`; the tab hostname
- Produces:

  ```ts
  export const CaptureSchema = z.object({
    version: z.literal(1),
    takenAt: z.string(),          // ISO
    ats: AtsIdSchema,
    url: z.string(),
    hostname: z.string(),
    html: z.string(),
    fields: z.array(EnumFieldSchema),          // currentValue always null
    resolutions: z.array(ResolutionSchema),    // value always null
    ignoredRefs: z.array(z.string()),
    jobTextSource: z.enum(['pasted', 'ats', 'learned', 'heuristic', 'none']),
    election: z.object({ frameId: z.number().int(), score: z.number(), url: z.string().nullable() }).nullable(),
    frameReports: z.array(z.object({ frameId: z.number().int(), url: z.string().nullable(), fields: z.number().int().nullable(), error: z.string().nullable() })),
  })
  ```

  `capture.save` params are `CaptureSchema` without `takenAt` (the host stamps it) and the host additionally refuses, `bad_request`, any field with a non-null `currentValue` or resolution with a non-null `value` (defence in depth for the redaction). Result `{ path: string }`. File name `<yyyy-mm-dd-hhmmss>-<ats>-<hostname>.json`, hostname with every character outside `[a-z0-9.-]` replaced by `_`. Panel: `data-jff-capture="1"` button, disabled when `fields.length === 0 || parked`; on success a `data-jff-capture-msg` line `Capture saved: <path>`; on failure the same line with the host error text.

**Work:** `sanitizedHtml` clones `document.documentElement`, then on the clone: removes every `script`; for every `input` removes the `value` attribute and sets `.value = ''` (the clone does not carry live values, so the attribute removal is what matters for serialisation); for every `textarea` sets `textContent = ''` and `.value = ''` (the text node is what `outerHTML` serialises); for every `[contenteditable]` sets `textContent = ''`; removes `selected` from every `option`; serialises `outerHTML`; truncates at the cap with the marker. The panel sends `JFF_CAPTURE` to the elected frame (fallback frame 0 when the election is null), runs `redactForCapture` on the session's fields and resolutions, and passes both with the reply's `html` to `capture.save`. The host creates the directory if missing and never overwrites: if the path exists, append `-2`, `-3`.

**Acceptance check:** `npm run build -w @jff/shared && npx vitest run extension/src/content/capture.test.ts extension/src/panel/capture.test.ts host/src/captures.test.ts host/src/config.test.ts host/src/handlers.test.ts extension/src/panel/App.test.tsx shared/src/messages.test.ts` exits 0 and `npm run typecheck` exits 0, with: a fixture holding an `input` with both a `value="attr-secret"` attribute and a divergent live `.value = 'live-secret'`, a `textarea` with markup text and a divergent live value, a `[contenteditable]` with text, a `script`, and a selected `option`, sanitises to HTML containing none of `attr-secret`, `live-secret`, either textarea text, the editable text, the script body, or `selected`; a 2,100,000-character body truncates with the marker; `redactForCapture` nulls every `currentValue` and `value`; the host writes a parseable file that round-trips through `CaptureSchema` and refuses an unredacted payload; the App case sends `capture.save` with the session's `ats`, `ignoredRefs`, and nulled values. Red state: `JFF_CAPTURE` is not a message.

**Boundaries:** No upload, no clipboard. The Session is unchanged by a capture. `data-jff-fid` attributes stay in the HTML (they are field ids, not personal data, and they correlate with `fields`).

- [ ] Schema; rebuild
- [ ] Content sanitiser with tests; message branch
- [ ] Panel redaction with tests
- [ ] Config field, host writer and handler with tests
- [ ] Panel button and line with the case; typecheck; commit `feat: Capture — sanitised DOM plus redacted scan evidence saved under the captures directory`

### Task 5: Live captures, and the modules' job description locators

**Files:**
- `extension/src/ats/fixtures/greenhouse-posting.ts` — create: distilled from the Greenhouse Capture
- `extension/src/ats/fixtures/ashby-posting.ts` — create: distilled from the Ashby Capture
- `extension/src/ats/greenhouse.ts` — modify: `jobTextSelector`
- `extension/src/ats/ashby.ts` — modify: `jobTextSelector`
- `extension/src/ats/greenhouse.test.ts` — create
- `extension/src/ats/ashby.test.ts` — modify: add the locator case
- `docs/plans/2026-09-03-panel-state-and-captures.md` — modify: Progress

**Interfaces:**
- Consumes: the two Capture files the user produces (below); `captureJobText` with `selectors`
- Produces: a non-null `jobTextSelector` in both modules, each proven by a fixture

**Work:** This task needs the user at the panel: reload the unpacked extension, open the Greenhouse posting and the Ashby **direct** posting URL (`jobs.ashbyhq.com/trm-labs/6edf242b-984d-41fb-8027-5f133a6353d4`, Application tab open; not the trmlabs.com wrapper, whose top document holds the posting text while the Capture holds the iframe), scan each, click `Save a capture` on each, and paste the two paths. From each Capture's `html`, find the element holding the posting text: the smallest container whose sanitised text is at least 400 characters and holds the posting body and nothing of the site chrome. Prefer an id or a stable, non-hashed class; Ashby's class names are hashed, so fall back to a structural or attribute selector and say so in the module's comment. Distil the container plus its ancestors into a fixture file under 30 KB. The module test asserts `captureJobText(fixtureDoc, [{ source: 'ats', selector }])` returns `source: 'ats'` with text that contains a known phrase of the posting and none of a known chrome phrase. If either Capture cannot be produced in the session, ship that module with `null`, record why under Progress, and continue.

**Acceptance check:** `npx vitest run extension/src/ats` exits 0 with the locator case in both module tests. Red state: both `jobTextSelector` are null.

**Boundaries:** Do not commit the raw Capture files; they hold the full page. Fixtures are distilled.

- [ ] User produces the two Captures; paths recorded under Progress
- [ ] Distil fixtures; set the selectors; tests; commit `feat(extension): Greenhouse and Ashby job description locators from live captures`

### Task 6: Gate and PR

**Files:**
- `docs/plans/2026-09-03-panel-state-and-captures.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `panel-state-and-captures` into `ai-staging`, a rundown for the user

**Work:** At idle, `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. The rundown for the PR body follows the spec's Gate list, items 2 to 5: Ashby landing state shows the empty state with the hint; Ignore a row and see the count line; park by navigating off-site and return, no `Waiting for the local host`; Save a capture on both pages and find the files under `~/.job-form-filler/captures/`, then `grep -c '<script' <file>` prints 0; the job description line names the locator on both ATSes.

**Acceptance check:** `npm run verify` exits 0; plain-dist grep prints 0; `gh pr view --json baseRefName` prints `ai-staging`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section.

- [ ] `uptime`, then `npm run verify`; record counts
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR with the rundown; commit `docs(plan): panel state and captures, task 6 gate`

## Progress

(filled in by execution)

# ATS identity and modules implementation plan

**Goal:** Every ATS the tool knows has one module of its own, layered over a generic path that no ATS change can touch, and both sides of the tool agree on which ATS a page is.
**Architecture:** A shared registry (`shared/src/ats.ts`) owns the ATS ids and host patterns; the Canonical URL code and the panel both detect through it. The panel detects from the elected frame's origin and sends `ats` with every resolve. The Native host's recognizers gain per-ATS vetoes. The extension gains `extension/src/ats/` with one module per ATS exposing three hooks (empty-scan hint, junk rule, job description locator) and a generic module with none. The job description path is reordered (paste, ATS locator, learned pick, heuristic), the extractor stops reading script and style text, a heuristic pick is never learned, and the panel shows where the text came from with a way to reject it.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section B and "ATS identity today"
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `ats-identity-and-modules`, created in Task 0 from `harness-v3-migration` (or from `ai-staging` if PR #1 has merged by then; say which under Progress). Target `ai-staging`. Never commit on `main`.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests.
- `npm run smoke` and `npm run verify` only on an idle machine; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- The generic path's tests (`junk.test.ts`, `jobpost.test.ts`, `recognizers.test.ts`, `canonicalUrl.test.ts`) never import an ATS module or an ATS fixture; each ATS module's test imports only its own fixture.
- ATS ids are the exact strings `generic`, `greenhouse`, `ashby`. Host patterns are the exact strings `greenhouse.io` and `ashbyhq.com`, matched on a domain boundary.
- `jobTextSelector` ships as `null` in both ATS modules here; plan `2026-09-03-panel-state-and-captures.md` fills them from the live Captures.
- Baseline at plan authoring, re-measured in Task 0: unit 866 tests / 53 files, typecheck 0, lint 0.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `ats-identity-and-modules`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch. Run typecheck, lint and unit tests; record the counts.

**Acceptance check:** `git branch --show-current` prints `ats-identity-and-modules`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [ ] Create the branch
- [ ] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): ats identity and modules, task 0 baseline`

### Task 1: The shared ATS registry

**Files:**
- `shared/src/ats.ts` — create: registry, `detectAts`, `isAtsHost`
- `shared/src/ats.test.ts` — create
- `shared/src/index.ts` — modify: `export * from './ats.js'`

**Interfaces:**
- Consumes: nothing
- Produces:

  ```ts
  export const ATS_IDS = ['generic', 'greenhouse', 'ashby'] as const
  export type AtsId = (typeof ATS_IDS)[number]
  export const AtsIdSchema: z.ZodEnum<['generic', 'greenhouse', 'ashby']>
  export const ATS_HOSTS: Record<Exclude<AtsId, 'generic'>, readonly string[]>
  export const ATS_NAMES: Record<AtsId, string>   // 'this site', 'Greenhouse', 'Ashby'
  export function detectAts(hostname: string): AtsId
  export function isAtsHost(hostname: string): boolean
  ```

**Work:** `detectAts` lowercases, strips a leading `www.`, and returns the first id whose host list contains an entry equal to the hostname or a suffix of it on a domain boundary (`host === h || host.endsWith('.' + h)`). `''` and unparseable input return `generic`. `ATS_NAMES.generic` is `this site` because it is used in copy ("the this site locator" must never render; Task 6 handles the generic case separately).

**Acceptance check:** `npx vitest run shared/src/ats.test.ts` exits 0 with: `boards.greenhouse.io` → `greenhouse`; `jobs.ashbyhq.com` → `ashby`; `notgreenhouse.io` → `generic`; `www.GREENHOUSE.io` → `greenhouse`; `trmlabs.com` → `generic`; `''` → `generic`; `isAtsHost('jobs.ashbyhq.com')` true, `isAtsHost('trmlabs.com')` false. Red state: the module does not exist.

**Boundaries:** No consumer is rewired here.

- [ ] Write the tests red
- [ ] Implement, export, rebuild shared; run the check; commit `feat(shared): ATS registry`

### Task 2: Canonical URL detects through the registry

**Files:**
- `host/src/canonicalUrl.ts` — modify: delete the local `ATS_HOSTS` and `isAtsHost`; import `isAtsHost` from `@jff/shared`

**Interfaces:**
- Consumes: `isAtsHost` from Task 1
- Produces: identical `canonicalUrl` behaviour

**Work:** Replace the local list and helper with the import. Update the comment block's last paragraph to point at `shared/src/ats.ts` as the list's home. Nothing else changes.

**Acceptance check:** `npx vitest run host/src/canonicalUrl.test.ts` exits 0 with no test edited. Red state: not applicable; this is a refactor proven by the unchanged suite plus `grep -c "ATS_HOSTS" host/src/canonicalUrl.ts` printing 0.

**Boundaries:** ADR 0003's rule is unchanged. Do not widen the host list.

- [ ] Rewire; run the check; commit `refactor(host): canonical URL reads the shared ATS registry`

### Task 3: The resolve payload carries the ATS and recognizers can be vetoed per ATS

**Files:**
- `shared/src/messages.ts` — modify: `resolve` params gain `ats: AtsIdSchema`
- `shared/src/messages.test.ts` — modify: the resolve schema case
- `host/src/resolve/recognizers.ts` — modify: `recognize` signature, `ATS_RECOGNIZER_VETOES`
- `host/src/resolve/recognizers.test.ts` — modify: add the three cases below
- `host/src/resolve/waterfall.ts` — modify: `WaterfallInput.ats`, both `recognize` call sites pass `{ label, name: f.name, ats: input.ats }`
- `host/src/resolve/waterfall.test.ts` — modify: inputs gain `ats: 'generic'`; add one Greenhouse case
- `host/src/handlers.test.ts` — modify: resolve requests gain `ats`

**Interfaces:**
- Consumes: `AtsId`, `AtsIdSchema` from Task 1
- Produces:

  ```ts
  export interface RecognizeInput { label: string; name: string | null; ats: AtsId }
  export const ATS_RECOGNIZER_VETOES: Partial<Record<AtsId, { key: FieldKey; unless: RegExp }[]>>
  export function recognize(input: RecognizeInput, db?: Database.Database): FieldKey | null
  ```

  Seed: `greenhouse: [{ key: 'earliestStart', unless: /(^|[^a-z])(month|day|year|mm|dd|yyyy)([^a-z]|$)/i }]`.

**Work:** A learned mapping still wins first and is never vetoed. A baseline hit is vetoed when the ATS has an entry for that key whose `unless` matches the trimmed label or the name; a vetoed hit returns null. The label is deliberately included: a label such as `Start date (MM/DD/YYYY)` names a date-formatted input, and the Answer bank's `earliestStart` is free text ("Imediato"), so vetoing there is correct, not collateral. Every existing caller of `recognize(label, db)` becomes `recognize({ label, name, ats }, db)`; the test file's existing calls pass `{ label, name: null, ats: 'generic' }` through a small local helper so the table of baseline cases stays readable.

**Acceptance check:** `npm run build -w @jff/shared && npx vitest run host/src/resolve shared/src/messages.test.ts host/src/handlers.test.ts` exits 0 with: `{ label: 'Earliest start date', name: null, ats: 'greenhouse' }` → `earliestStart`; `{ label: 'Earliest start date', name: 'job_application[answers][0][date][year]', ats: 'greenhouse' }` → null; the same input with `ats: 'generic'` → `earliestStart`; a learned mapping for that label on `greenhouse` still returns the learned key. Red state: `recognize` does not accept an object.

**Boundaries:** No other recognizer pattern changes. `mapping.ts` (the LLM tier) is not touched.

- [ ] Schema change; rebuild shared; fix the schema and handler tests
- [ ] Recognizer tests red, then implement; waterfall wiring; run the check; commit `feat(host): resolve carries the ATS; recognizers gain per-ATS vetoes`

### Task 4: Extension ATS modules and detection in the scan

**Files:**
- `extension/src/ats/index.ts` — create: `AtsModule`, `moduleFor`
- `extension/src/ats/generic.ts` — create
- `extension/src/ats/greenhouse.ts` — create
- `extension/src/ats/ashby.ts` — create
- `extension/src/ats/ashby.test.ts` — create: hand-built `EnumField` literals (the content fixture `extension/src/content/fixtures/ashby.ts` has no file input; the live shape is confirmed from the Ashby Capture in the panel-state plan)
- `extension/src/ats/index.test.ts` — create: `moduleFor` returns the generic module for `generic` and for any unrecognised value (a session persisted before this change carries `ats: undefined`)
- `extension/src/panel/junk.ts` — modify: `dropJunk(fields, module)`
- `extension/src/panel/junk.test.ts` — modify: existing calls pass the generic module; one case proves a module's `dropField` is applied after `keepField`
- `extension/src/panel/scan.ts` — modify: one `electAndDetect` helper used at both election sites, `ScanOutcome.ats`, resolve payload `ats`, zero-field returns detect over every frame url
- `extension/src/panel/scan.test.ts` — modify: the resolve request assertion gains `ats`; one case with an Ashby iframe url proves `ats: 'ashby'` and the hidden autofill input dropped; one zero-field case with an Ashby iframe url and a `trmlabs.com` tab proves `ats: 'ashby'` on the empty outcome
- `extension/src/panel/sessions.ts` — modify: `Session.ats: AtsId`, default `'generic'` in `newSession`; untouched by `clearScanResults` (the ATS rides the session like `site`)
- `extension/src/panel/site.ts` — modify: `hostnameOf` moves here from `App.tsx:30`
- `extension/src/panel/App.tsx` — modify: import `hostnameOf` from `./site` at `:942` and `:1421`; persist `out.ats` in the scan settle projection
- `extension/src/panel/App.test.tsx` — modify: `hostnameOf` import (`:5`) now from `./site`

**Interfaces:**
- Consumes: `AtsId`, `detectAts`, `EnumField`
- Produces:

  ```ts
  export interface AtsModule {
    id: AtsId
    emptyHint: string | null
    dropField: (f: EnumField) => boolean
    jobTextSelector: string | null
  }
  export function moduleFor(ats: AtsId): AtsModule
  export function dropJunk(fields: EnumField[], module: AtsModule): EnumField[]   // keepField(f) && !module.dropField(f)
  ```

  `ScanOutcome.ats: AtsId`; `ScanDeps` unchanged (the hostname fallback is already there).

**Work:** One procedure, one election. `electAndDetect(fields, reports, tabHostname)` does, in order: `kept = dropJunk(fields, generic)`; `election = electFrame(kept)`; `ats = detectAts(frameHostname(election, reports) ?? tabHostname)` where `frameHostname` is `hostnameOf` of the elected frame's url in `reports` (the lookup `electionOut()` already does), null when the url is null; `module = moduleFor(ats)`; then the module's `dropField` is applied to the **elected frame's fields only** (foreign fields are review-only and never resolved, so the module has nothing to say about them). There is no second election: if the module removes every field of the elected frame, `kept` for that frame is empty and the existing "only junk on the page" return at `scan.ts:295` fires. The helper runs at both election sites (`scan.ts:184` and the post-resume re-enumeration at `:249`), so the ATS is re-derived whenever the election is. For the zero-field returns at `scan.ts:169` and `:295` (which happen with no election), `ats` is the first non-generic `detectAts` over the tab hostname followed by every non-null `reports[].url`, else `generic`; this is what lets the Ashby hint render on a wrapper page such as `trmlabs.com`. The Ashby module: `dropField: (f) => f.kind === 'file' && !f.visible && f.label === null`; `emptyHint: 'On Ashby the form is under the "Application" tab. Open it, then Scan again.'`; `jobTextSelector: null`. Greenhouse: no drop, no hint, `null`. `moduleFor` returns the generic module for anything it does not recognise, no throw.

**Acceptance check:** `npx vitest run extension/src/ats extension/src/panel/junk.test.ts extension/src/panel/scan.test.ts extension/src/panel/sessions.test.ts extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with the cases named in Files. The Ashby module test builds two `EnumField` literals, `{ kind: 'file', visible: false, label: null, … }` and `{ kind: 'file', visible: false, label: 'Resume', … }`, and asserts `dropField` true then false. Red state: `extension/src/ats` does not exist.

**Boundaries:** `keepField` is unchanged. `election.ts` is unchanged. No content-script change. `company.ts` is unchanged. The ATS locator for the job description is still requested from frame 0 (`scan.ts:205`) while `ats` comes from the elected frame; on a wrapper page the Ashby selector is therefore tried against the top document, misses the 400-character gate, and the order falls through to the learned selector and the heuristics. That is accepted; the direct posting URLs are the ones the locators serve.

- [ ] Modules and their tests
- [ ] `dropJunk` signature and tests
- [ ] Move `hostnameOf` to `site.ts`; fix the three imports
- [ ] `electAndDetect` at both sites, zero-field detection, payload; session field; App projection; run the check; typecheck; commit `feat(extension): ATS modules, detection from the elected frame, Ashby junk rule`

### Task 5: Job description order, extractor hygiene, no auto-learn, and the source line

**Files:**
- `shared/src/messages.ts` — modify: `JFF_JOBTEXT` carries `selectors: { source: 'ats' | 'learned'; selector: string }[]`; new host method `selector.clear { hostname, purpose: 'job_description' }`
- `shared/src/messages.test.ts` — modify accordingly
- `extension/src/content/jobpost.ts` — modify: `captureJobText(root, selectors)` returns `source: 'ats' | 'learned' | 'heuristic' | 'none'`; `textOf` skips `script`, `style`, `noscript`, `template`
- `extension/src/content/jobpost.test.ts` — modify: add the cases below
- `extension/src/content/index.ts` — modify: the `JFF_JOBTEXT` branch passes `msg.selectors`
- `extension/src/panel/scan.ts` — modify: builds `selectors` (ATS locator first, learned second), stores `jobTextSource` on the outcome, deletes the heuristic `selector.save`
- `extension/src/panel/scan.test.ts` — modify: a heuristic result triggers no `selector.save`; the order of `selectors` is asserted
- `extension/src/panel/sessions.ts` — modify: `Session.jobTextSource: 'pasted' | 'ats' | 'learned' | 'heuristic' | 'none'`, default `'none'`
- `extension/src/panel/App.tsx` — modify: project `jobTextSource` (pasted text → `'pasted'`); render the source line and the `Not the job description` button under the job description box; `onPickJobText` sets `'learned'` on success
- `extension/src/panel/App.test.tsx` — modify: add the two cases below
- `host/src/handlers.ts` — modify: `selector.clear` case
- `host/src/db/repos.ts` — modify: `clearSelector(db, hostname, purpose)`
- `host/src/handlers.test.ts` — modify: one `selector.clear` case

**Interfaces:**
- Consumes: `AtsModule.jobTextSelector`, `ATS_NAMES`
- Produces: `ScanOutcome.jobTextSource`; `data-jff-jobtext-source` element whose text is `<n> characters, from <copy>` with copy `your paste` | `the <ATS_NAMES[ats]> locator` | `your pick` | `a heuristic` | `nothing found`; a `data-jff-jobtext-reject="1"` button rendered only for `learned` and `heuristic`

**Work:** `textOf` clones the element, removes the four tag kinds, then reads `textContent` and normalises whitespace as today; the picker uses the same `textOf`. `captureJobText` tries `selectors` in order under the same `≥ MIN_JOB_TEXT` gate and try/catch, then the heuristic tiers. In `scan.ts`, `selectors` is `[{source:'ats', selector: module.jobTextSelector}]` when non-null, then `[{source:'learned', selector}]` when the host returned one. The reject button clears `jobText`, sets `jobTextSource` to `'none'`, and calls `selector.clear` for the tab hostname; the picker stays enabled as today. The generic ATS never reaches the "locator" copy because its `jobTextSelector` is null.

**Acceptance check:** `npm run build -w @jff/shared && npx vitest run extension/src/content/jobpost.test.ts extension/src/panel/scan.test.ts extension/src/panel/App.test.tsx host/src/handlers.test.ts shared/src/messages.test.ts` exits 0 with: a container holding a 600-character description plus a `<style>` of 200 characters and a `<script>` of 300 yields text without the CSS or JS; `selectors` order is honoured and the reply's `source` names the winner; a heuristic result sends no `selector.save`; App renders `from a heuristic` after a heuristic scan and, after clicking reject, sends `selector.clear` and shows `from nothing found`; the host `selector.clear` deletes the row. Red state: `captureJobText` takes a single nullable selector.

**Boundaries:** `MIN_JOB_TEXT`, `MAX_JOB_TEXT`, the heuristic tiers and `cssPathOf` are unchanged. The paste box behaviour is unchanged.

- [ ] Schema; rebuild; host `selector.clear` with its test
- [ ] Extractor cases red, then implement
- [ ] `scan.ts` order and no auto-learn; session field; App line and button with its tests; typecheck; commit `feat: job description order paste, ATS locator, pick, heuristic; no auto-learn; source line`

### Task 6: The empty-scan hint

**Files:**
- `extension/src/panel/ScanStatus.tsx` — modify: `empty` gains `hint: string | null`, rendered as a second line when non-null
- `extension/src/panel/ScanStatus.test.tsx` — modify: one case with a hint, one without
- `extension/src/panel/App.tsx` — modify: the outcome mapping passes `moduleFor(out.ats).emptyHint`
- `extension/src/panel/sessions.test.ts` — modify only if a stored `lastOutcome` fixture of kind `empty` needs the new field

**Interfaces:**
- Consumes: `moduleFor`, `ScanOutcome.ats`
- Produces: `ScanUiState` `{ kind: 'empty'; frames: number; hint: string | null }`; the hint renders inside the same `role="status"` element under `data-jff-status="empty"`

**Work:** A stored session from before this change may hold an `empty` outcome without `hint`; treat a missing `hint` as null at the render site rather than migrating sessions.

**Acceptance check:** `npx vitest run extension/src/panel/ScanStatus.test.tsx extension/src/panel/App.test.tsx` exits 0 with the two ScanStatus cases and one App case: a zero-field scan on an `ats: 'ashby'` election renders the Ashby hint text. Red state: `empty` has no `hint`.

**Boundaries:** The rest of `ScanStatus` copy is unchanged. The zero-field render defect itself (defect 7's silence) belongs to the panel-state plan; this task only makes the hint available.

- [ ] Type and render; tests; commit `feat(panel): empty-scan hint from the ATS module`

### Task 7: Gate and PR

**Files:**
- `docs/plans/2026-09-03-ats-identity-and-modules.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `ats-identity-and-modules` into `ai-staging`, a rundown for the user

**Work:** At idle, `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. The rundown for the PR body: on the Ashby direct URL with the Application tab open, scan and confirm the unlabelled file row is gone and the job description line reads a source; on `trmlabs.com/careers?ashby_jid=…` (the wrapper) scan and confirm the line reads `from a heuristic`, click `Not the job description`, confirm `from nothing found`, pick the description, confirm `from your pick`; on Greenhouse, scan and confirm `earliestStart` resolves one field (`sqlite3` on `request_log` or the panel's reason strings); confirm `resolve` requests in `host.log` carry `ats`.

**Acceptance check:** `npm run verify` exits 0; plain-dist grep prints 0; `gh pr view --json baseRefName` prints `ai-staging`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section.

- [ ] `uptime`, then `npm run verify`; record counts
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR with the rundown; commit `docs(plan): ats identity and modules, task 7 gate`

## Progress

(filled in by execution)

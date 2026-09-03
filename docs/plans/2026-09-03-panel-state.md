# Panel state implementation plan

**Goal:** The status line can only say what the Session and the live state currently earn, and a zero-field scan always shows its empty state.
**Architecture:** One pure `statusFor` function replaces the stored `scanStatus` as the source of the status line, with in-flight and action-failure states kept per tab in the runtime and owned by the code paths that produce them. A unit test drives every zero-field return through the App.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section C and "Defect 8", "Defect 7"
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `panel-state`, created in Task 0 from `profile-write-guard`. This plan is part of a four-plan linear stack: `profile-write-guard` → `panel-state` → `ats-identity-and-modules` → `ignore-and-captures`. Those four all edit `App.tsx` and each consumes the one before it, so the stack is what keeps them from colliding. `2026-09-03-serial-choice-fill.md` is **not** in the stack: it touches `fill.ts` only and runs in parallel from `ai-staging`. Open the PR against the parent branch `profile-write-guard`, and retarget it to `ai-staging` once the parent merges. Never commit on `main`.
- Stack mechanics, so the retargets stay cheap: merge every stack PR with a **merge commit**, not a squash. Under a squash merge the child's three-dot diff re-shows the parent's whole change and the merge reapplies it, which forces a `git rebase --onto ai-staging <parent-tip>` first. And when a review of the parent produces fix commits, merge the parent forward into this branch **before** this PR's review is triggered, so the review reads the code that will actually land.
- Every `App.tsx:NNNN` citation in this plan is a line number as of `d90d6ed`. Earlier plans in the stack insert code above most of them, so re-find each site by the quoted anchor text rather than trusting the number.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests.
- Every task ends with `npm run typecheck` green before its commit.
- `npm run smoke` and `npm run verify` only on an idle machine; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- This plan runs **before** `ats-identity-and-modules`, so there is no `Session.ats`, no `moduleFor` and no `emptyHint`. `ScanUiState`'s empty state is `{ kind: 'empty'; frames: number }` and carries no hint here; the ATS hint is added by that later plan, which owns its own assertion for it. Do not reference an ATS module from this branch.
- `runScan`'s zero-field returns, by current line: `scan.ts:169` (retry still empty), `:260` (form went away after the resume upload), `:295` (only junk on the page). The captcha returns at `:147`, `:217` and `:255` never render `empty`: the ternary at `App.tsx:1051`, with the precedence comment at `:1048-1049`, gives captcha priority. A first-pass zero always falls through the retry (`scan.ts:154-168`), so "first pass empty" and "retry empty" are one path.
- Baseline at plan authoring, re-measured in Task 0: unit 866 tests / 53 files, typecheck 0, lint 0. If `profile-write-guard` has already changed the count, record its count instead.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `panel-state`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch from `profile-write-guard`. Run typecheck, lint and unit tests; record the counts.

**Acceptance check:** `git branch --show-current` prints `panel-state`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [ ] Create the branch
- [ ] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): panel state, task 0 baseline`

### Task 1: `statusFor` and the end of stored screen states

**Files:**
- `extension/src/panel/status.ts` — create: `statusFor`
- `extension/src/panel/status.test.ts` — create
- `extension/src/panel/App.tsx` — modify: `SessionRuntime` gains `inFlight` and `actionFailure`; every `setScanStatus(...)` call becomes a write to the tab's runtime plus a render bump; the rendered status is `statusFor(...)`; the auto-scan effect's `{ kind: 'connecting' }` write at `:1175` is deleted; `onProgress`'s gate at `:979` changes from `inScope(sc)` to `alive(sc)` (see Interfaces); `display()` reseeds nothing and clears nothing; `lastOutcomeRef` is deleted
- `extension/src/panel/App.test.tsx` — modify: add the four cases below

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
  - `inFlight: ScanUiState | null` holds the phases `injecting`, `enumerating`, `retrying`, `resolving` (written by `onProgress`, `App.tsx:978-985`) and `superseded` (written by the navigation handler at `:637`). Cleared by the scan that owns it when it settles or aborts, in its `finally`, **only if the runtime's generation still equals the scan's** (a dead scan must not clear a `superseded` a newer generation wrote), and by `endRuntime`.
  - **`onProgress`'s gate must change.** It reads `if (!inScope(sc)) return` at `App.tsx:979`, and `inScope` (`:319`) additionally requires the session to be the one on screen, so a scan on a background tab currently writes no progress at all. Change it to `alive(sc)`: the runtime is per tab, and a per-tab write must not depend on which tab is displayed. Leaving `inScope` here defeats this task's own invariant, because a session swapped away mid-scan comes back to an `inFlight` that was never written.
  - `actionFailure: ScanUiState | null` holds `action_failed`, written at every `action_failed` site. There are **five** on the parent branch: the four at `App.tsx:1240, 1269, 1297, 1428` as of `d90d6ed`, plus the `Save to profile failed: …` site that `profile-write-guard` Task 2 adds. Wire all five. Cleared by `clearActionFailure`, by a settled scan of that tab, and by a generation bump.
  - `display()` touches neither: a tab round-trip cannot change the rendered status of a session whose inputs did not change, which is the invariant this task exists for.

**Work:** Keep the React state minimal: one `statusTick` counter bumped whenever a runtime status field changes for the displayed tab, so the render recomputes `statusFor`. Internal wiring beyond the constraints above is your choice.

**Acceptance check:** `npx vitest run extension/src/panel/status.test.ts extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with, in `status.test.ts`, one case per precedence rule; in App: (1) a parked session with the host answered renders the parked line and no `[data-jff-status]`; (2) with the gate closed and a non-parked session the panel shows `connecting`; park that session (an off-site navigation event) and then open the gate: no `[data-jff-status]` renders, where today `connecting` stays; (3) a scan started on tab A, displayed swapped to tab B and back mid-scan, still renders tab A's in-flight phase — the case that goes red if `onProgress` keeps the `inScope` gate; (4) regression guard, green before and after: the generate-all round-trip case and a `done` outcome surviving a tab swap away and back. Red state: cases 2's second half and 3.

**Boundaries:** `ScanStatus.tsx` copy is unchanged. `generateAll` and `generatePaused` handling stays as it is (already per runtime).

- [ ] `statusFor` with its tests
- [ ] App wiring and the four cases; typecheck; commit `fix(panel): the status line is derived, never stored; parked sessions cannot show connecting`

### Task 2: Every zero-field scan renders its empty state

**Files:**
- `extension/src/panel/App.test.tsx` — modify: add the four cases below
- `extension/src/panel/App.tsx` — modify only if a case is red
- `extension/src/panel/scan.ts` — modify only if a case is red

**Interfaces:**
- Consumes: the zero-field returns listed in Global constraints; the "Scan anyway" button (`App.tsx:1697-1710`); `ScanUiState` `empty`
- Produces: `data-jff-status="empty"` rendered in each case

**Work:** Drive the App with a fake relay: (a) `JFF_SCAN` answers zero fields on both passes (`scan.ts:169`); (b) a first pass with fields, a resume seeded, and the post-upload re-enumeration answering zero fields (`:260`); (c) only junk fields (a hidden unlabelled text input) so `kept` is empty (`:295`); (d) a session with `appliedHit` set, click `Scan anyway`, relay answers zero fields. Assert the status element in each. Note case (d) interacts with Task 1's `appliedHit → null` rule: "Scan anyway" clears `appliedHit` (`App.tsx:1704`) before the scan, so the rule does not hide the result; assert that ordering.

If a case is red, find the path that drops the outcome, fix it at the source rather than in the test, and record under Progress which path it was.

If all four are green, the panel's zero-field rendering is not where defect 7 lives, and the task is not finished. Do this instead of closing it: add a temporary `console.debug` in the outcome mapping (`App.tsx:1051`) that prints the outcome `kind` and the frame count on every settle, reload the unpacked extension, reproduce on `trmlabs.com/careers?ashby_jid=…`, and read it back with the Chrome console. That says whether the panel received an `empty` outcome and failed to render it, or never received one. Record which under Progress, write the regression test for the path the live run actually shows, and fix that. Do not close this task on four green units alone: defect 7 is confirmed live, so a green unit suite means the harness misses it, not that it is gone.

**Acceptance check:** `npx vitest run extension/src/panel/App.test.tsx -t "empty"` exits 0 with the four cases, plus the regression case for the live path if the four were green. Red state: at least one case is expected to be red; if none is, the live probe above is the red state and its finding is recorded under Progress.

**Boundaries:** No copy changes. Do not add a retry. Remove the temporary `console.debug` before the commit.

- [ ] Write the four cases; fix what is red, or run the live probe and fix what it shows; commit `test(panel): every zero-field scan renders the empty state` (or `fix(panel): …` naming the path)

### Task 3: Gate and PR

**Files:**
- `docs/plans/2026-09-03-panel-state.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `panel-state` into `profile-write-guard`, a rundown for the user

**Work:** At idle, `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. The rundown for the PR body: park a session by navigating off-site and return, and confirm the status line no longer reads `Waiting for the local host…` beside a green host banner; scan a page with no application form and see the empty state; start a scan, switch tabs mid-scan and switch back, and confirm the phase still shows.

**Acceptance check:** `npm run verify` exits 0; plain-dist grep prints 0; `gh pr view --json baseRefName` prints `profile-write-guard`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section. Stop after opening the PR: the review is the user's to trigger.

- [ ] `uptime`, then `npm run verify`; record counts
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR with the rundown; commit `docs(plan): panel state, task 3 gate`

## Progress

(filled in by execution)

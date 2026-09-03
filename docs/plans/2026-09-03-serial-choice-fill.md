# Serial choice fill implementation plan

**Goal:** A combobox fill reports success only when the page really committed the option and closed its menu, and no fill ever starts while another widget's menu is still open.
**Architecture:** Changes inside `extension/src/content/fill.ts` only. The commit verdict in `fillCombobox` needs a closed listbox plus one of three kinds of commit evidence, so a typed value equal to the option text can no longer pass on its own, whether the menu stays open or closes without selecting. The commit gesture on the option becomes the same pointer sequence the open gesture uses. Before any open gesture the filler closes whatever listbox is visible and verifies it closed, and `fillFields` settles between consecutive choice-type fills. Five jsdom fixtures pin the verdict; five existing fixtures are corrected to close their listbox on commit, as real widgets do.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section D and "Defect 9: the false commit"
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `serial-choice-fill`, created in Task 0 from `harness-v3-migration` (stacked on PR #1, target `ai-staging`). Never commit on `main`.
- Run tests from the repo root: `npx vitest run <path>`.
- `npm run smoke` and `npm run verify` only on an idle machine; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- Timings are exact: `COMMIT_SETTLE_MS = 500`, `CLOSE_WAIT_MS = 500`, `CHOICE_GAP_SETTLE_MS = 300`, poll at the existing `COMBOBOX_POLL_MS = 50`.
- Helper provenance in `fill.ts`: `attributableListbox` and `mountedListboxes` are imported from `./harvest`; `nextFrame` (`fill.ts:94`), `wait` (`:229`), `isDisplayHidden` (`:284`), `visibleCommittedText` (`:302`), `dispatchOpenGesture` (`:249`) and `norm` are file-local; `waitForSettle` is a new import from `./settle` (`settle.ts:6`, signature `waitForSettle(root, { quietMs?, maxMs? })`).
- "Closed" means, for the attributable listbox: unmounted, or `isDisplayHidden`, or the control (the element or its closest `[role=combobox]`) has `aria-expanded="false"`. A hidden-but-mounted menu is closed.
- Baseline at plan authoring, re-measured in Task 0: unit 866 tests / 53 files, typecheck 0, lint 0.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `serial-choice-fill`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch from `harness-v3-migration`. Run typecheck, lint and unit tests; record the counts.

**Acceptance check:** `git branch --show-current` prints `serial-choice-fill`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [ ] `git checkout -b serial-choice-fill`
- [ ] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): serial choice fill, task 0 baseline`

### Task 1: The five verdict fixtures, red

**Files:**
- `extension/src/content/fill.test.ts` — modify: add the five cases below inside a new `describe('combobox verdict')`

**Interfaces:**
- Consumes: `fillOne` as exported today; `attributableListbox` behaviour (`harvest.ts:34`: a listbox linked by `aria-controls`/`aria-owns`, or one that appeared after our interaction)
- Produces: five named cases, listed with their expected verdicts

**Work:** One fixture builder with flags. Shape: a wrapper `div` holding `input[role=combobox][aria-controls=lb]`; the listbox `div#lb[role=listbox]` is **type-to-load**: it mounts with its option `Bachelor's Degree` only after the input receives an `input` event whose value is non-empty (never on `mousedown` alone; this is what makes the filler take the typeahead path, `fill.ts:426-427`, which is the path the false pass lives on). Every variant removes the listbox on `keydown` Escape, as real widgets do, so `failClosed` leaves a clean document. Variants, selected by the option's behaviour on our commit gesture:

1. **stubborn**: the option does nothing; the menu stays; input keeps the typed text. Expected: `{ ok: false, reason: 'no-commit' }`, and afterwards no `[role=listbox]` in the document and `input.value` equal to its pre-fill snapshot (`''`).
2. **close-without-commit**: the option removes the listbox and leaves the input text; a later `blur` on the input clears it (what a discarded typeahead does). Expected: `{ ok: false, reason: 'no-commit' }`, input restored to `''`.
3. **honest react-select**: the option empties the input, renders a sibling `<div class="single-value">Bachelor's Degree</div>` (no extra whitespace: the `committed: null` expectation depends on raw string equality at `fill.ts:455`), and removes the listbox. Expected: `{ ok: true, committed: null }`.
4. **honest rewrite**: filled with `bachelor`; the option sets `input.value = "Bachelor's Degree"` and removes the listbox. Expected: `{ ok: true, committed: "Bachelor's Degree" }`.
5. **honest exact**: filled with `Bachelor's Degree`; the option removes the listbox and leaves the input text; `blur` leaves it in place. Expected: `{ ok: true, committed: null }`.

Real timers, 10 s test timeout per case.

**Acceptance check:** `npx vitest run extension/src/content/fill.test.ts -t "combobox verdict"` fails on cases 1 and 2 with the page reporting `ok: true` (the false pass, both shapes), and passes 3, 4 and 5. Red state is the deliverable.

**Boundaries:** No change to `fill.ts` here. Do not touch existing cases yet (Task 2 does).

- [ ] Write the builder and the five cases; run the check; commit `test(content): reproduce the combobox false pass, both shapes`

### Task 2: Commit evidence, closed listbox, close-before-open, settle

**Files:**
- `extension/src/content/fill.ts` — modify: `fillCombobox` verdict and commit gesture, a `closeOpenListboxes` step before `dispatchOpenGesture`, the settle in `fillFields`
- `extension/src/content/fill.test.ts` — modify: the existing combobox success fixtures (the cases starting at `fill.test.ts:165`, `:362`, `:381`, `:402`, `:430`) so the option's commit removes `#lb` from the document, which is what the widgets they model do; no expectation changes

**Interfaces:**
- Consumes: the helpers named in Global constraints
- Produces: exported constants `COMMIT_SETTLE_MS = 500`, `CLOSE_WAIT_MS = 500`, `CHOICE_GAP_SETTLE_MS = 300`; failure reasons `no-commit` and `listbox-left-open`; `fillFields` awaits `waitForSettle(root, { quietMs: 100, maxMs: CHOICE_GAP_SETTLE_MS })` between two consecutive fills whose elements are both choice-type (`role=combobox`, `aria-haspopup=listbox`, `select`, radio, checkbox)

**Work:**

Commit gesture: replace `hit.click()` with `dispatchOpenGesture(hit)` (pointerdown, mousedown, pointerup, mouseup, click on the option: a strict superset of the click, for the same reason C2 widened the open gesture; widgets that select on mousedown are covered, click listeners still fire).

Verdict, in order, after the gesture and `nextFrame()`:

1. **Closed.** Poll up to `COMMIT_SETTLE_MS` until the listbox is closed (Global constraints definition). Not closed → `failClosed('no-commit')`.
2. **Evidence.** Let `typed` be the text the typeahead wrote (`''` when the open gesture found the option without typing). For an input-backed control, one of:
   - (a) `input.value === ''` and `visibleCommittedText(input, optionText, preTexts)` returns the option text (react-select);
   - (b) `norm(input.value) === optionText` and `input.value !== typed` (the widget rewrote the input);
   - (c) `norm(input.value) === optionText` and `input.value === typed`: blur the input, `nextFrame()`, and require `norm(input.value) === optionText` still (a discarded typeahead is cleared on blur; a commit survives it).
   For a non-input control: `norm(el.textContent.trim()) === optionText`, as today.
   None → `failClosed('no-commit')`.
3. `committed` reporting stays as today: `null` when the committed text equals the requested value, else the canonical text.

Close-before-open: before `dispatchOpenGesture(el)`, collect every `[role=listbox]` in the document that is not `isDisplayHidden`. For each, dispatch `keydown Escape` (bubbling) on the element that owns it (`[aria-controls=<id>]` or `[aria-owns=<id>]` when present, else `document.activeElement`), then blur that element. Poll up to `CLOSE_WAIT_MS` for all of them to be closed; if any is still visible, return `{ ok: false, reason: 'listbox-left-open' }` without opening this control. Do this once per fill, not in a loop.

Settle in `fillFields`: track the previous element's choice-type flag and await the settle when both previous and current are choice-type.

**Acceptance check:** `npx vitest run extension/src/content/fill.test.ts` exits 0: Task 1's five cases, every existing combobox case with its fixture corrected (expectations unchanged: `'bra'` still commits `'Brazil'` with the canonical text, the fail-closed restore cases still restore), plus one new case: with a visible foreign listbox on the page whose owner ignores Escape, `fillOne` on a combobox returns `listbox-left-open` and never dispatches the open gesture (spy on `mousedown` on the control). Red state: Task 1's cases 1 and 2 report `ok: true`.

**Boundaries:** No change to `harvest.ts`, `enumerate.ts` or the panel. No new timing constants beyond the three named. Existing expectations are not loosened; only fixture behaviour on commit changes. If an existing case cannot be made to pass by closing its listbox on commit, report `blocked: <case name>: <what else it needs>`.

- [ ] Correct the five existing fixtures (commit removes `#lb`); run the suite, still green
- [ ] Commit gesture and the three-step verdict; Task 1's cases go green
- [ ] Close-before-open with its new case; settle in `fillFields`; run the suite; commit `fix(content): combobox commit needs a closed listbox and commit evidence; close before open; settle between choices`

### Task 3: Live gate and PR

**Files:**
- `docs/plans/2026-09-03-serial-choice-fill.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `serial-choice-fill` into `ai-staging`, a rundown for the user

**Work:** At idle, `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. The rundown for the PR body: on the Greenhouse page, scan, let the batch fill run, then confirm on the page that at most one menu is open at any time and that the Degree row is either committed on the page or listed under "need input" with the reason `no-commit`, never reported filled while showing `Select…`. On the Ashby Application tab, fill a combobox with a value that equals an option label exactly (evidence tier (c)) and one that is a prefix (tier (b)); both must commit or fail honestly. The user's earlier observation (three menus open, Degree on `Select…`, panel says 16 filled) is the red state. If Degree now fails honestly with `no-commit` on every run, the commit gesture is the next suspect: record it under Progress for a diagnosing session rather than widening this plan.

**Acceptance check:** `npm run verify` exits 0; plain-dist grep prints 0; `gh pr view --json baseRefName` prints `ai-staging`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section.

- [ ] `uptime`, then `npm run verify`; record counts under `## Progress`
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR with the rundown; commit `docs(plan): serial choice fill, task 3 gate`

## Progress

(filled in by execution)

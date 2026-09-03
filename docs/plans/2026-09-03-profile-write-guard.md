# Profile write guard implementation plan

**Goal:** A generated Draft can never be stored as a Known key value again, and a fact row offers "Save to profile" instead of "Generate with AI".
**Architecture:** Three cuts on one path, shipped so the tree typechecks at every commit. Task 1 narrows `SaveItem.fieldKey` to `null` in the shared schema, drops keyed rows in the panel's `buildSaveItems`, deletes the host's keyed save branch, and adds a single-line shape rule to `profile.set` and `answerBank.set`, all in one commit. Task 2 replaces Generate with a one-click "Save to profile" on fact rows without a stored value, excludes them from the generate-all batch, and makes the Profile editor report a refused save. Task 3 updates the one e2e case that used the removed path.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section A and "Defect 10: how a Draft reached the profile table"
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `profile-write-guard`, created in Task 0 from `ai-staging`. This plan is part of a four-plan linear stack: `profile-write-guard` → `panel-state` → `ats-identity-and-modules` → `ignore-and-captures`. Those four all edit `App.tsx` and each consumes the one before it, so the stack is what keeps them from colliding. `2026-09-03-serial-choice-fill.md` is **not** in the stack: it touches `fill.ts` only and runs in parallel from `ai-staging`. PR #1 merged `harness-v3-migration` into `ai-staging`; confirm with `git log --oneline -1 origin/ai-staging` before branching, and if it has not merged, branch from `harness-v3-migration` and retarget on merge. Target `ai-staging`. Never commit on `main`.
- Stack mechanics, so the retargets stay cheap: merge every stack PR with a **merge commit**, not a squash. Under a squash merge the child's three-dot diff re-shows the parent's whole change and the merge reapplies it, which forces a `git rebase --onto ai-staging <parent-tip>` first. And when a review of the parent produces fix commits, merge the parent forward into this branch **before** this PR's review is triggered, so the review reads the code that will actually land.
- Every `App.tsx:NNNN` citation in this plan is a line number as of `d90d6ed`. Earlier plans in the stack insert code above most of them, so re-find each site by the quoted anchor text rather than trusting the number.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests, or they exercise the stale build.
- Every task ends with `npm run typecheck` green before its commit; the schema narrowing in Task 1 touches producer and consumer in the same commit for that reason.
- `npm run smoke` and `npm run verify` only on an idle machine (`uptime` load under the core count). They leave a seam dist behind; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- Glossary terms in prose and copy: Known key, Profile, Answer bank, Draft, Saved answer. Code identifiers stay as they are.
- Host wire shapes are exact: `profile.set` and `answerBank.set` take `{ values: Record<string, string> }` (`shared/src/messages.ts:39,41`).
- Baseline at plan authoring, re-measured in Task 0: unit 866 tests / 53 files, typecheck 0, lint 0.
- The user's profile was restored from `~/.job-form-filler/backups/db.pre-task19-2026-09-03.sqlite` before this plan runs. If `sqlite3 ~/.job-form-filler/db.sqlite "select value from profile where key='github'"` still prints prose, stop and report `blocked: profile not restored`.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `profile-write-guard`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch from `ai-staging`. Run typecheck, lint and unit tests; record the counts under `## Progress`. Run the profile check from Global constraints.

**Acceptance check:** `git branch --show-current` prints `profile-write-guard`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state before the task: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [x] `git checkout -b profile-write-guard`
- [x] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): profile write guard, task 0 baseline`

### Task 1: Facts never travel through Save answers; fact values are single-line

**Files:**
- `shared/src/messages.ts` — modify: `SaveItemSchema.fieldKey` becomes `z.null()`
- `shared/src/messages.test.ts` — **create** the case: `grep -n fieldKey shared/src/messages.test.ts` returns nothing today, so there is no `fieldKey` case to modify; write one that asserts `SaveItemSchema` rejects a non-null `fieldKey`
- `shared/src/keys.ts` — modify: export `FACT_MAX_CHARS = 500` and `normalizeFactValue(v: string): string` (collapse every run of whitespace, newlines included, into one space; trim)
- `shared/src/keys.test.ts` — create if absent, else modify: two cases for `normalizeFactValue`
- `extension/src/panel/save.ts` — modify: `buildSaveItems` excludes every row whose resolution has a non-null `key`; delete the page-keyed passthrough, which is **`save.ts:66-70`** (the three-line `B5b` comment plus the `pageKeyed` const and the `continue`), and the `!pageKeyed` waiver at **`:82`**; every item is built with `fieldKey: null`. **Do not delete `save.ts:65`.** That line is `if (field.demographic || resolution.tier === 'skipped') continue`, a separate privacy guard that `save.test.ts:94` and `:103` describe as deliberately independent, and it must survive this task untouched. Typecheck catches a stray reference to a deleted `pageKeyed`; nothing catches a silently deleted demographic guard.
- `extension/src/panel/save.test.ts` — modify **three** existing cases, not one: `:152` and `:167` are the page-keyed pair, and `:80` (`routes a corrected factual field to its answer-bank key, not to qa_memory`) also asserts a non-null `fieldKey` while being `source: 'answer_bank'`, so a search for "page-keyed" will not find it. Under the new rule it yields zero items and fails on `items[0]` being undefined. Add the two cases below
- `host/src/handlers.ts` — modify: delete the `if (item.fieldKey !== null)` branch in the `save` transaction; `profile.set` and `answerBank.set` normalise every value with `normalizeFactValue` and reject any normalised value longer than `FACT_MAX_CHARS`
- `host/src/handlers.test.ts` — modify: add the three cases below

**Interfaces:**
- Consumes: `isProfileKey`, `setProfile`, `setAnswerBank`, `upsertAnswer` as they exist
- Produces: `SaveItem.fieldKey: null` (the property stays so the wire shape is unchanged and an old panel fails loudly at validation); `profile.set` / `answerBank.set` fail `bad_request` with message `fact value over 500 characters: <key>`; stored fact values never contain a newline; `buildSaveItems` returns only keyless rows

**Work:** The keyed branch's removal leaves `setProfile`/`setAnswerBank` still used by `profile.set`/`answerBank.set`; `isProfileKey` stays used by the key checks. The empty-string delete semantics of `setProfile` are unchanged: normalise first, then the existing `trim() === ''` handling applies. Comment in `save.ts`: facts reach the store only through "Save to profile" (Task 2) and the editor.

**Acceptance check:** `npm run build -w @jff/shared && npx vitest run shared host/src/handlers.test.ts extension/src/panel/save.test.ts` exits 0 and `npm run typecheck` exits 0, with: (schema) `SaveItemSchema` rejects `fieldKey: 'github'`; (save.ts) a `needs_input` row with `key: 'github'` and a panel edit yields no item; an `auto` row with `source: 'page'`, `key: 'email'` and a page value yields no item; a keyless `needs_input` row with a generated edit still yields an item with `fieldKey: null`; (host) a raw `save` request whose item carries `fieldKey: 'github'` fails `HostRequestSchema` and, saved without the key, leaves `profile` and `answer_bank` unchanged while `qa_memory` gains the row; a `profile.set` with a two-line `location` stores it as one line; a `profile.set` with a 501-character `github` fails `bad_request` and leaves the row unchanged. Red state: today `HostRequestSchema` accepts `fieldKey: 'github'` and the handler writes it into `profile`; `buildSaveItems` emits `fieldKey: 'github'`.

**Boundaries:** Do not touch `waterfall.ts`; the `key` on a Resolution stays, Task 2 consumes it. No SQLite schema change. `e2e/full-loop.spec.ts` is Task 3's.

- [ ] Schema, `keys.ts` helpers with tests; rebuild shared
- [ ] `save.ts` and its tests
- [ ] Host branch removal and shape rule with tests; `npm run typecheck`; commit `fix: facts never travel through Save answers; fact values are single-line`

### Task 2: "Save to profile" replaces Generate on fact rows; the editor reports a refused save

**Files:**
- `extension/src/panel/FieldRow.tsx` — modify: button logic for keyed rows; new prop `onSaveFact`; `acting` union gains `'save_fact'`
- `extension/src/panel/FieldRow.test.tsx` — modify: add the four cases below
- `extension/src/panel/App.tsx` — modify: `onSaveFact` handler; `acting` state union gains `'save_fact'`; `generateEligible` excludes keyed rows; pass the prop at both `<FieldRow` sites (`App.tsx:1820`, `:1845`); **`onSaveFacts` (`:1444-1451`) alone** gains the `r.ok` checks on both requests, surfacing `hostErrorText(r.error)` through `setHostError` instead of merging and leaving the view. `onOnboardingFinish` (`App.tsx:1470`) already does exactly this, with a comment explaining why — leave it alone and treat it as the regression check that the new code matches
- `extension/src/panel/App.test.tsx` — modify: add the two cases below

**Interfaces:**
- Consumes: `Row` (`extension/src/panel/group.ts:3`), `isProfileKey` from `@jff/shared`, `portRef.current.request('profile.set' | 'answerBank.set', { values })`, `setFacts`, `edits`, `session.snapshot`
- Produces: `FieldRowProps.onSaveFact: (ref: string) => void`; a `data-jff-save-fact="1"` button with text `Save to profile` (busy label `Saving…`); `generateEligible` filters `r.resolution.key === null`

**Work:** A row with `resolution.key !== null` never renders "Generate with AI". It renders `Save to profile` when the key has no stored value behind it, which is `source` not in `profile`, `answer_bank`, `llm_key` (that is: `needs_input`, `page`-sourced, and the `saved_answer` key-fallback rows from `waterfall.ts:83-86,160-163`). Disabled when the current value is blank, while `locked`, or while `acting !== null`. Rows sourced from `profile`, `answer_bank` or `llm_key` render neither Generate nor Save to profile; Accept and Fill are unchanged.

**Where the button goes.** "Before the Fill button" only describes one of the three target row kinds. `FieldRow.tsx:188-211` renders Accept only under `tier === 'proposed'` and Generate plus Fill only under `tier === 'needs_input'`; a `page`-sourced or `saved_answer` row is `tier: 'auto'` and today renders the flex container and the reason span and nothing else. So for `needs_input` the button goes before Fill, and for the two `auto` kinds it is the first control that row has ever had. Put it in the same flex container, and add a FieldRow case for an `auto` row so the new branch is covered.

**Overwrites.** A `page`-sourced row can carry a key whose profile value already exists (email and phone after an ATS autofills them). Saving then replaces a good stored fact with whatever the page happened to hold. Render `Save to profile` only when `facts[key]` is absent or blank; when a value is already stored, render nothing and leave the Profile editor as the way to change it.

**The absent-value test is only meaningful once the facts have arrived.** `facts` starts as `{}` (`App.tsx:198`) and is filled by a `profile.get` plus `answerBank.get` round-trip (`App.tsx:731-743`); the comment at `App.tsx:1146` already records that a facts load can limp in after a deadline. In that window every key looks absent, so an ATS-autofilled email row would offer `Save to profile` and one click would overwrite the stored email with the page's value — the exact defect class this plan exists to close, on a profile that was just restored from backup. Gate the button on `factsLoaded && factsOk`, both of which already exist as state beside `facts`.

In `App.tsx`, `onSaveFact(ref)` finds the row in `main`, takes `snapshot[ref] ?? edits[ref] ?? row.resolution.value` (the same precedence `buildSaveItems` uses at `save.ts:76`, so a fact corrected on the page saves the page's value), calls `profile.set` when `isProfileKey(key)` else `answerBank.set` with `{ values: { [key]: value } }`, merges the result into `facts` on success, and on failure writes an `action_failed` status `Save to profile failed: …` like Accept does. `setActing({ ref, action: 'save_fact' })` for the in-flight lock. Then filter `generateEligible`.

**Acceptance check:** `npx vitest run extension/src/panel/FieldRow.test.tsx extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with, in FieldRow: a keyed `needs_input` row shows `Save to profile` and no `Generate with AI`; a keyed `saved_answer` row (`tier: 'auto'`, the kind with no controls today) shows `Save to profile`; a keyed `profile`-sourced row shows neither; a keyed `page`-sourced row whose key already has a stored fact shows neither; a keyed row rendered while `factsLoaded` is false shows neither, even though `facts` is empty; a keyless `needs_input` row still shows `Generate with AI`. In App: with a fake port, clicking `Save to profile` on a `github` row with the edit `https://github.com/x` sends exactly one `profile.set` with `{ values: { github: 'https://github.com/x' } }` and no `save`; a fake port answering `profile.set` with `ok: false` from the Profile editor leaves the editor view open and shows the host error banner. Red state: the first FieldRow case currently renders `Generate with AI`; the editor case currently returns to the session view.

**Boundaries:** `generateOne` is unchanged: the batch filter and the missing button keep keyed rows out. `ProfileEditor.tsx` itself is not touched.

- [ ] FieldRow prop, button, `acting` union; four cases red, then green
- [ ] `onSaveFact`, `generateEligible` filter, `r.ok` checks on both requests inside `onSaveFacts`; two App cases; typecheck; commit `feat(panel): Save to profile on fact rows; facts are never generated; the editor reports a refused save`

### Task 3: The e2e loop learns the new path

**Files:**
- `e2e/full-loop.spec.ts` — modify: the assertion that `answer_bank` gained `workAuth` through Save answers, which is at **`:157-158`** (`:163-164` is the unrelated applied-url assertion; do not invert that one), becomes its inverse, and a new step drives `Save to profile` on that row and asserts the `answer_bank` write

**Interfaces:**
- Consumes: the `data-jff-save-fact` button; the SQLite handle the spec already opens
- Produces: an e2e case that proves both halves: Save answers writes no fact, Save to profile writes one

**Work:** Keep the page edit of `#work_auth` as it is. After Save answers, assert `answer_bank` has no `workAuth`. Then click the row's `Save to profile` and assert `answer_bank.workAuth` equals the page value. Do not run the Playwright suite here unless the machine is idle; Task 4 runs it.

**Acceptance check:** `npx tsc -p e2e` exits 0. The behavioural check is Task 4's `npm run verify`. Red state: the existing assertion expects the removed write.

**Boundaries:** No other e2e spec changes.

- [ ] Edit the spec; `npx tsc -p e2e`; commit `test(e2e): Save answers writes no fact; Save to profile does`

### Task 4: Live gate and PR

**Files:**
- `docs/plans/2026-09-03-profile-write-guard.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `profile-write-guard` into `ai-staging`, a rundown for the user

**Work:** At idle, run `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. Write the manual rundown for the user in the PR body: open the Greenhouse page, scan, confirm the `github` row shows `Save to profile` and no Generate; type a URL, click it, open the Profile editor and see it; generate-all, Save answers, then `sqlite3 ~/.job-form-filler/db.sqlite "select key, substr(value,1,40) from profile"` shows no prose. Stop after opening the PR: the review is the user's to trigger.

**Acceptance check:** `npm run verify` exits 0; `grep -rl 'jffFakeHost' extension/dist | wc -l` prints 0; `gh pr view --json baseRefName` prints `ai-staging`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section.

- [ ] `uptime`, then `npm run verify`; record counts under `## Progress`
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR against `ai-staging` with the rundown; commit `docs(plan): profile write guard, task 4 gate`

## Progress

### Task 0 (done)

Branch `profile-write-guard` created from `origin/ai-staging` (`7b307d1`).

One correction was needed before the baseline. PR #1 merged at `439473e`, which
is one commit before `30dfe76`, the fable pass that produced the approved plan
set. So `ai-staging` carried the superseded plans: the pre-correction text still
named `harness-v3-migration` as this branch's base, still had
`serial-choice-fill` inside the stack, and was missing both the stack
merge-commit rule and Task 2's `factsLoaded && factsOk` gate. The approved text
is the contract, so `harness-v3-migration` was merged into this branch as its
first commit and travels to `ai-staging` with this PR. After that merge
`git diff --stat 30dfe76 HEAD` is empty: the branch is the code the plan was
written against.

Baseline, measured on the branch:

| check | result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, no errors or warnings |
| `npx vitest run` | `Test Files 53 passed (53)`, `Tests 866 passed (866)` |

Matches the plan's stated baseline of 866 tests / 53 files, typecheck 0, lint 0.

The full `npm run verify` was owed from the previous session and ran green at the
start of this one, on a tree byte-identical to this branch: typecheck 0, lint 0,
866/866, Playwright `17 passed`, and `grep -rl 'jffFakeHost' extension/dist | wc -l`
printing 0 after a plain rebuild.

Profile gate from Global constraints: 10 clean keys, `github` holds
`https://github.com/kevinshibuya`. Not prose, so the stop condition does not
fire.

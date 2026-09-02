# Harness v3 migration implementation plan

**Goal:** Bring job-form-filler in line with the v3 Claude Code harness and make every product LLM call name its model explicitly, chosen per task from the harness model table.
**Architecture:** Four deliverables from the spec. A (project structure) and B (git flow) are file moves, doc writes and git plumbing. C (model routing) adds one `models.ts` module, threads a model and a time budget through both CLI runners, hardens the Codex runner, adds a fake Codex binary to the e2e suite, moves two structured tasks from the Claude runner to the Codex runner, extends the Self-check with a Codex probe, and makes the panel's error copy vendor-neutral. D (harness repo) is two edits and one archive move under `~/.claude`.
**Spec:** `docs/specs/2026-09-02-harness-v3-migration-design.md`
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- All work on branch `harness-v3-migration`, created from `main` in Task 0. Never commit on `main`. The single push of `main` in Task 14 is the user's action with the `ALLOW_MAIN_MERGE=1` prefix.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests, or they exercise the stale build.
- Model ids are exact strings: `claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-luna`. No aliases anywhere in code, tests or docs.
- Prompt builders, zod schemas and degradation paths of the four existing LLM tasks stay unchanged. The only prompt difference after the move is the few-word suffix each runner appends after the prompt body (`claudeCli.ts:74` versus `codexCli.ts:72`).
- Time budgets per task stay what they are today: 240 seconds for facts extraction, mapping and generation, 120 seconds for review. The Codex runner's default stays 120 seconds; callers that need 240 pass it per call.
- `npm run smoke` and `npm run verify` only on an idle machine (`uptime` load under the core count). They leave a seam dist behind; Task 12 restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- The word Resume follows the glossary in every doc written here; code identifiers such as `cvText` stay.
- Task 1 may be delegated to `codex-implementation` (gpt-5.6-terra) as a bounded mechanical task; every other task runs inline on this session.
- Baseline at plan authoring, re-measured in Task 0: unit 794 tests / 51 files, e2e 17/17, typecheck 0, lint 0.

### Task 0: Branch and baseline

**Files:**
- none modified; `CONTEXT.md`, `docs/specs/2026-09-02-harness-v3-migration-design.md` and `docs/plans/2026-09-02-harness-v3-migration.md` already exist uncommitted and get committed here; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `harness-v3-migration`, a recorded baseline in this plan's Progress section

**Work:** Confirm `git status` shows exactly the three files above as untracked and nothing else. Create the branch from `main`. Run typecheck, lint and unit tests and record the counts under `## Progress` at the end of this file. Do not run the Playwright suite here.

**Acceptance check:** `git branch --show-current` prints `harness-v3-migration`; `npm run typecheck && npm run lint && npx vitest run` all exit 0. Red state before the task: `git branch --show-current` prints `main`.

**Boundaries:** No file edits beyond the Progress section. If unit counts differ from 794/51, record the difference and continue; if any test is red, stop and report `blocked: baseline red: <test>`.

- [x] `git checkout -b harness-v3-migration`, then commit the three untracked docs as `docs: glossary, migration spec and plan`
- [x] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): task 0 baseline`

### Task 1: Move the docs tree and stamp the finished plans

**Files:**
- `docs/superpowers/plans/*.md` — move to `docs/plans/` with `git mv`, names unchanged
- `docs/superpowers/specs/*.md` — move to `docs/specs/` with `git mv`, names unchanged
- `docs/plans/2026-07-27-job-form-filler-v1.md`, `docs/plans/2026-07-28-scan-fill-1-core.md`, `docs/plans/2026-07-28-scan-fill-2-interaction.md`, `docs/plans/2026-07-28-scan-fill-3-fill.md`, `docs/plans/2026-07-28-scan-observability.md`, `docs/plans/2026-07-29-generation-recall-combobox.md` — modify: status block under the H1
- Any tracked file whose text contains `docs/superpowers/`, except this plan and its spec (`docs/plans/2026-09-02-*`, `docs/specs/2026-09-02-*`, which describe the move and keep the old path as history) — modify: path only (find them with `git grep -l 'docs/superpowers/' -- ':!docs/plans/2026-09-02-*' ':!docs/specs/2026-09-02-*'`); nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: `docs/plans/` and `docs/specs/` as the only doc folders

**Work:** Seven plans and five specs move. Each of the six finished plans gets, directly under its H1, exactly:

```
**Status:** completed <YYYY-MM-DD>
Progress was tracked in the SDD ledger, which no longer exists. Checkboxes below reflect authoring, not execution.
```

The date is the author date of the last commit that touched the plan file or the spec it names, found with `git log --format='%ad' --date=short -1 -- <file>` for each of the two, taking the later. No checkbox is ticked. The active plan `2026-07-29-onboarding-sessions-applied-combobox.md` moves and gets its `docs/superpowers/` paths rewritten but is not otherwise touched here; Task 2 owns it. `docs/superpowers/` must not exist afterwards.

**Acceptance check:** `test ! -d docs/superpowers && git grep -l 'docs/superpowers/' -- ':!docs/plans/2026-09-02-*' ':!docs/specs/2026-09-02-*' | wc -l` prints 0, `ls docs/plans | wc -l` prints 8 (seven moved plus this plan) and `ls docs/specs | wc -l` prints 6. Red state before: `docs/superpowers` exists.

**Boundaries:** No content edits beyond the status block and path strings. Do not touch `.superpowers/`, `HANDOFF*.md`, this plan, its spec, or the active plan's body.

- [x] `git mv` both folders' files, remove the empty `docs/superpowers` tree
- [x] Rewrite `docs/superpowers/` path strings in the tracked files the grep names
- [x] Add the status block to the six finished plans with the computed dates
- [x] Run the check, commit `docs: move plans and specs to docs/plans and docs/specs, stamp finished plans`

### Task 2: Retrofit the active plan to v3

**Files:**
- `docs/plans/2026-07-29-onboarding-sessions-applied-combobox.md` — modify: header, checkboxes, Done lines, Progress notes, Task 19 text; nothing outside this list

**Interfaces:**
- Consumes: `.superpowers/sdd/2026-07-29-onboarding-sessions-applied-combobox/progress.md` (read only, 1241 lines, untracked) and `git log --oneline 7c6f917^..HEAD` (Tasks 1 to 8 predate the session-9 handoff commit `b5f8d65`, so the range must start at `7c6f917`)
- Produces: a plan file that carries its own progress

**Work:** Four edits.

1. Header. Remove the `> **For agentic workers:** ...` banner (line 3). Keep the existing `**Goal:**` and `**Architecture:**` lines. Replace the `**Tech Stack:**` line with `**Spec:** docs/specs/2026-07-29-onboarding-sessions-applied-combobox-design.md` followed by `**Execution model:** opus`. Rename `## Global Constraints` to `## Global constraints`. The `## Worker preamble` section stays as it is.
2. Tasks 0 to 18: tick every `- [ ]` to `- [x]`. Directly under each `### Task N:` heading add one line `Done: <range>, see progress notes.` The ranges were verified against `git log` at plan time and are authoritative: Task 0 no commits (baseline); 1 `7c6f917..70209a1`; 2 `70209a1..f212e1f`; 3 `f212e1f..092c3a7`; 4 `092c3a7..455d3bf`; 5 `455d3bf..de757e9`; 6 `de757e9..d19e217`; 7 `d19e217..cbbcd6f`; 8 `cbbcd6f..bc96ce3`; 9 `fcb1b3a`; 10 `6a7c2b8` and `fe0c339`; 11 `073e376`; 12 `4068c0a`; 13 `c0718bd`; 14 `b46b633`; 15 `fa485ce`; 16 `e4d1ac1`; 17 `8f7de95`; 18 `cfdddba`. Review fix passes: `ffb9d51`, `7eb2ca9`, `4d1b28e`.
3. `## Progress notes` section appended after the existing `## Manual handshake log`. One bullet per ruling in the ledger's `progress.md` whose line starts with a task number followed by `PARKED`, `ADJUDICATED`, `DEVIATION`, `PROCESS DEVIATION`, `ORCHESTRATOR FIX`, or `reconciled`. Each bullet: `Task N, <kind>: <one or two sentences, the ruling and its reason>`. Minor deferred items are summarised as one bullet per task: `Task N, deferred minors: <count>, see git history`. Then the branch review outcome and the two fix passes as three bullets, taken from the ledger's review section and the three fix commits. The four still-open items from the session-12 handoff (`startUrl` staleness, `drainRescans` stall, F5 narrowness, F9 draft override) each get a bullet marked `OPEN`.
4. Task 19 text. Replace the routing paragraph that names `codex-computer-use` with: steps 2 to 8 of the checklist run through Claude Code's Chrome browser tools with the user watching; step 1 (profile DB wipe and restore) runs only after the user says so in that session; the user's own pass is the final acceptance; then the `retro` skill. The eight checklist items stay verbatim. Replace `superpowers:retro` with `retro`.

**Acceptance check:** `grep -c '^\- \[ \]' <file>` prints 8 (Task 19's eight items are the only unticked boxes), `grep -c '^Done: ' <file>` prints 19, and `grep -c 'superpowers' <file>` prints 0. Red state before: the unticked count is 119 and the Done count is 0.

**Boundaries:** Do not edit any task's Work, Files or Acceptance text other than Task 19's routing paragraph. Do not delete `.superpowers/`. If a ledger ruling cannot be summarised in two sentences without losing its meaning, quote the ledger line verbatim instead.

- [x] Header edits
- [x] Tick Tasks 0 to 18 and add the 19 Done lines
- [x] Write `## Progress notes` from the ledger
- [x] Rewrite the Task 19 routing paragraph
- [x] Run the check, commit `docs(plan): retrofit the active plan to v3, progress in file`

### Task 3: ADRs

**Files:**
- `docs/adr/0001-llm-via-spawned-clis.md` — create
- `docs/adr/0002-native-host-with-sqlite.md` — create
- `docs/adr/0003-ats-scoped-tracking-param-stripping.md` — create
- `docs/adr/0004-draft-then-review-with-fallback.md` — create
- `docs/adr/0005-claude-for-prose-codex-for-structure.md` — create
- `docs/adr/0006-anti-fabrication-is-structural.md` — create; nothing outside this list

**Interfaces:**
- Consumes: spec section A5 (the six decisions with their reasons), `CONTEXT.md` vocabulary
- Produces: `docs/adr/` with six files

**Work:** Each file follows `~/.claude/skills/domain-modeling/ADR-FORMAT.md`: an H1 with the decision as a short title, then one paragraph of one to three sentences: context, decision, why. Use the glossary's terms (Draft, Canonical URL, Revisit badge, Native host, Resume, Value). ADR 0005 is titled after the vendor split and names the harness model table at `~/.claude/CLAUDE.md` and the rule "never inherit the CLI default" as its mechanism. ADR 0006 names the mapping schema's missing value field as the mechanism. No optional sections. Under 15 lines each.

**Acceptance check:** `ls docs/adr | wc -l` prints 6 and `wc -l docs/adr/*.md | tail -1` shows a total under 90. Red state before: `docs/adr` does not exist.

**Boundaries:** No implementation details beyond the ones the spec's A5 already names. No status frontmatter.

- [x] Write the six files
- [x] Run the check, commit `docs(adr): record the six standing decisions`

### Task 4: Project CLAUDE.md and settings

**Files:**
- `CLAUDE.md` — create
- `.claude/settings.json` — create; nothing outside this list

**Interfaces:**
- Consumes: spec A6 (the eight lessons) and A7 (the allowlist)
- Produces: both files, tracked

**Work:** `CLAUDE.md` is under 40 lines: an H1, one sentence on what the project is, then the eight lessons from spec A6 as a flat bullet list under `## Lessons`, each one or two lines, in the spec's order. The model-routing bullet names `host/src/llm/models.ts` and the `models` key of `~/.job-form-filler/config.json`. No restating of the global CLAUDE.md, no architecture tour.

`.claude/settings.json` holds only:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm run test)",
      "Bash(npm run smoke)",
      "Bash(npm run verify)",
      "Bash(npm run build)",
      "Bash(npm run build -w @jff/shared)",
      "Bash(npx playwright test:*)"
    ]
  }
}
```

**Acceptance check:** `wc -l CLAUDE.md` under 40, `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"` exits 0, `git check-ignore -v .claude/settings.json` prints nothing (verified at plan time: only specific `.claude/*` runtime files are excluded). Red state before: neither file exists.

**Boundaries:** No hooks, model, mode or env in the settings file. No lesson that the code or the spec already states.

- [x] Write both files
- [x] Run the check, commit `chore: project CLAUDE.md and verification allowlist`

### Task 5: Model registry and config

**Files:**
- `host/src/llm/models.ts` — create
- `host/src/llm/models.test.ts` — create
- `host/src/config.ts` — modify: `models` field and its validation
- `host/src/config.test.ts` — create if absent, else modify: the `models` cases
- `host/src/handlers.test.ts` — modify: the `config` literal at line 33 gains `models: {}`; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
// host/src/llm/models.ts
export type LlmTask = 'factsExtract' | 'mapping' | 'generate' | 'reviewDraft' | 'claudeAuthProbe' | 'codexAuthProbe'
export const LLM_TASKS: readonly LlmTask[]
export const DEFAULT_MODELS: Readonly<Record<LlmTask, string>>
export type ModelOverrides = Partial<Record<LlmTask, string>>
export type ResolvedModels = Readonly<Record<LlmTask, string>>
export function resolveModels(overrides: ModelOverrides): ResolvedModels
// host/src/config.ts
export interface HostConfig { /* existing five fields */ models: ModelOverrides }
```

`DEFAULT_MODELS` is exactly the spec's table: `factsExtract: 'gpt-5.6-sol'`, `mapping: 'gpt-5.6-sol'`, `generate: 'claude-opus-5'`, `reviewDraft: 'gpt-5.6-sol'`, `claudeAuthProbe: 'claude-opus-5'`, `codexAuthProbe: 'gpt-5.6-luna'`.

**Work:** `resolveModels` returns defaults with every override applied whose value is a non-empty string. In `loadConfig`, `models` is read from `cfg.models` when it is a plain object: keep only keys in `LLM_TASKS` whose values are non-empty strings, drop the rest, and log one warning line per dropped key through the same channel `handlers.ts` uses for the review-failure warning (the `CodexError` catch near `handlers.ts:107`). A missing or malformed `models` yields `{}`. `loadConfig`'s try/catch behaviour is unchanged. Internal structure of the validation is your choice.

**Acceptance check:** `npm run typecheck && npx vitest run host/src/llm/models.test.ts host/src/config.test.ts host/src/handlers.test.ts` green with tests for: defaults match the table; a valid override wins; an unknown key is dropped; a non-string value is dropped; an empty string is dropped. Red state before: `models.ts` does not exist so the test file fails to import.

**Boundaries:** Do not touch the runners or handler logic here. `authCachePath` stays non-overridable.

- [x] Write `models.ts` and its test, red then green
- [x] Extend `config.ts` and its test, patch the handlers test literal
- [x] Run the check, commit `feat(host): explicit per-task model registry with config overrides`

### Task 6: Codex runner: classification and one transient retry

**Files:**
- `host/src/llm/codexCli.ts` — modify: `CodexError` kinds, `createCodexRunner` opts, retry loop, the timeout comment
- `host/src/llm/codexCli.test.ts` — modify: retry and classification tests; nothing outside this list

**Interfaces:**
- Consumes: `SleepFn` from `host/src/llm/claudeCli.ts:20` (already imported by `codexCli.ts`)
- Produces:

```ts
export class CodexError extends Error { constructor(readonly kind: 'not_installed' | 'not_authed' | 'rate_limit' | 'process' | 'timeout' | 'invalid_output', message: string) }
export function createCodexRunner(opts: { codexPath?: string; run?: CodexRunFn; sleep?: SleepFn } = {}): CodexRunner
```

**Work:** Mirror the Claude runner's shape at `claudeCli.ts:68-126` for the transient class only. Classification, in this order: ENOENT stays `not_installed`; a non-zero exit whose stderr matches `/rate.?limit|429|overloaded|too many requests|usage limit/i` becomes `rate_limit`; a non-zero exit whose stderr matches `/not logged in|login|auth|unauthor|sign.?in/i` becomes `not_authed`; timeout stays `timeout`; other non-zero exits and spawn errors stay `process`. Terminal kinds (`not_installed`, `not_authed`, `rate_limit`) throw at once with a message that names codex. Transient kinds (`timeout`, `process`) retry exactly once after `await sleep(2_000)`, then throw. `invalid_output` does not retry. `sleep` defaults to a real `setTimeout` promise and is injected in tests as `() => Promise.resolve()`. The temp dir cleanup runs on every attempt. The comment on `CODEX_TIMEOUT_MS` stops saying the timeout exists for the review pass and says it is the runner default that callers may raise per call.

**Acceptance check:** `npx vitest run host/src/llm/codexCli.test.ts` green with new tests: a timeout then success returns the parsed result and the fake ran twice; two timeouts throw `timeout` after two runs; a usage-limit stderr throws `rate_limit` after one run; a not-signed-in stderr throws `not_authed` after one run; ENOENT after one run. Red state before: the retry tests see one run and the classification tests see `process`.

**Boundaries:** `CODEX_TIMEOUT_MS` value unchanged. No argv change here.

- [x] Tests red, then classification and retry loop
- [x] Run the check, commit `feat(host): codex runner classifies rate limit and sign-in, retries once on transient failure`

### Task 7: Runners take a model and a time budget per call

**Files:**
- `host/src/llm/claudeCli.ts` — modify: `RunFn`, `ClaudeRunner.complete`, `defaultRun` argv and timeout
- `host/src/llm/codexCli.ts` — modify: `CodexRunFn`, `CodexRunner.complete`, `defaultCodexRun` argv and timeout
- `host/src/llm/claudeCli.test.ts`, `host/src/llm/codexCli.test.ts` — modify: fakes take the opts, plus one argv test each
- `host/src/llm/factsExtract.ts`, `host/src/llm/mapping.ts`, `host/src/llm/generate.ts`, `host/src/llm/reviewDraft.ts` — modify: signatures gain `opts: CallOpts` and pass it through
- `host/src/llm/factsExtract.test.ts`, `host/src/llm/generate.test.ts`, `host/src/llm/reviewDraft.test.ts` — modify: fakes and calls
- `host/src/resolve/waterfall.ts`, `host/src/resolve/waterfall.test.ts` — modify: `WaterfallDeps` gains `mappingOpts: CallOpts`; every `{ db, runner }` deps literal in the test (about twenty, lines 47 to 186) gains it
- `host/src/handlers.ts`, `host/src/handlers.test.ts` — modify: `HandlerDeps` gains `models: ResolvedModels`, call sites build the opts
- `host/src/selfcheck.ts`, `host/src/selfcheck.test.ts` — modify: `realProbeAuth(claudePath, model)`
- `host/src/index.ts` — modify: build `models` from `resolveModels(config.models)` and wire it; nothing outside this list

**Interfaces:**
- Consumes: `resolveModels`, `ResolvedModels` from Task 5
- Produces:

```ts
// host/src/llm/claudeCli.ts
export type CallOpts = { model: string; timeoutMs?: number }
export type RunFn = (prompt: string, opts: CallOpts) => Promise<RunResult>
export interface ClaudeRunner { complete<T>(prompt: string, schema: z.ZodType<T>, opts: CallOpts): Promise<T> }
// host/src/llm/codexCli.ts (imports CallOpts from claudeCli.ts)
export type CodexRunFn = (prompt: string, opts: CallOpts) => Promise<CodexRunResult>
export interface CodexRunner { complete<T>(prompt: string, schema: z.ZodType<T>, opts: CallOpts): Promise<T> }
runFactsExtract(runner: ClaudeRunner, cvText: string, opts: CallOpts)
runMapping(runner: ClaudeRunner, input: MappingInput, opts: CallOpts)
runGeneration(runner: ClaudeRunner, input: GenerationInput, opts: CallOpts)
reviewDraft(runner: CodexRunner, input: GenerationInput, claudeDraft: string, opts: CallOpts)
interface WaterfallDeps { db: Database.Database; runner: ClaudeRunner; mappingOpts: CallOpts }
interface HandlerDeps { /* existing */ models: ResolvedModels }
realProbeAuth(claudePath: string, model: string)
```

**Work:** The Claude argv becomes `['-p', prompt, '--model', opts.model, '--output-format', 'json']` and its spawn timeout is `opts.timeoutMs ?? SPAWN_TIMEOUT_MS`. The Codex argv replaces the literal `'gpt-5.6-sol'` with `opts.model`; every other flag stays; its spawn timeout is `opts.timeoutMs ?? CODEX_TIMEOUT_MS`. Runner types still point at the Claude runner for facts and mapping in this task; Task 10 switches them. Handlers pass `{ model: deps.models.generate }`, `{ model: deps.models.reviewDraft }`, `{ model: deps.models.factsExtract }`, and `{ db, runner, mappingOpts: { model: deps.models.mapping } }` to the waterfall; `timeoutMs` is not set anywhere in this task because both paths still run on the Claude runner's 240-second default. `index.ts` computes `const models = resolveModels(config.models)` once and passes `models.claudeAuthProbe` to `realProbeAuth`.

The two argv tests: export a pure `buildArgv(prompt: string, opts: CallOpts): string[]` from each runner module, used by `defaultRun` and `defaultCodexRun`, and assert its output for a given model. No spawn mocking. The e2e fake at `e2e/bin/claude` reads only the value after `-p`, so the added flag is safe (verified at plan time).

**Acceptance check:** `npm run typecheck && npx vitest run host` green, including the two new argv tests. Red state before: the argv tests fail because `buildArgv` does not exist.

**Boundaries:** No change to prompts, schemas, retry logic, or which runner a task uses. Task 6's classification stays as landed.

- [x] `CallOpts`, `buildArgv` and the two argv tests red then green
- [x] Thread `opts` through the four task modules and their tests
- [x] `WaterfallDeps`, `HandlerDeps`, `index.ts`, `selfcheck.ts` wiring and tests
- [x] Run the check, commit `feat(host): every LLM call carries an explicit model id and time budget`

### Task 8: Fake codex binary for the e2e suite

**Files:**
- `e2e/bin/codex` — create, executable, no extension, same CommonJS-or-ESM-neutral style as `e2e/bin/claude`
- `e2e/hostBridge.ts` — modify: `codexPath` points at the fake, `JFF_FAKE_CODEX_MODE` is passed through, `startHost` accepts `codexMode`
- `e2e/full-loop.spec.ts` — modify: only if a review-degradation assertion depends on `no-codex` (check the `/production TypeScript/` assertion near line 117 still holds with the fake passing the Draft through unchanged); nothing outside this list

**Interfaces:**
- Consumes: the Codex argv from Task 7 (`exec -m <model> -s read-only --ephemeral --skip-git-repo-check --color never -o <outFile> <prompt>`)
- Produces: `startHost(opts: { mode?: string; codexMode?: string })` in `e2e/hostBridge.ts`; env `JFF_FAKE_CODEX_MODE` with values `ok` (default), `not_authed`, `rate_limit`, `timeout`

**Work:** The fake reads the prompt as the last argv element and the output path as the value after `-o`. It writes ONE JSON body to that file (not stdout) and exits 0, except: `not_authed` writes `Error: not logged in` to stderr and exits 1; `rate_limit` writes `usage limit reached` to stderr and exits 1; `timeout` sleeps 130 seconds so the host's SIGKILL fires. Bodies: the probe prompt (`/Reply with exactly/`) gets `{"ok":true}`; the review prompt (`/You review ONE drafted answer/`) gets `{"draft": <the draft text extracted from the prompt, unchanged>}`; the facts prompt (`/You extract job-application facts/`) gets `{}`; the mapping prompt gets the same per-ref array the fake claude emits, including the `salary` behaviour when `JFF_FAKE_CLAUDE_MODE=salary` (read that env too so existing salary tests keep their contract after Task 10). `hostBridge.ts` sets `codexPath: join(FAKE_BIN, 'codex')`, deletes the `no-codex` comment block, and passes `JFF_FAKE_CODEX_MODE: opts.codexMode ?? 'ok'`. The existing full-loop suite must stay green in this task: the review pass now goes through the fake and returns the Draft unchanged.

**Acceptance check:** `npm run smoke` green, 17/17, on an idle machine. Red state before: not applicable for the suite; the fake's own contract is checked by `JFF_FAKE_CODEX_MODE=not_authed e2e/bin/codex exec -m x -o /dev/null 'p'; echo $?` printing 1.

**Boundaries:** No host or panel code. No new spec file; the modes get exercised by Tasks 9 and 10.

- [ ] Write the fake, chmod +x, shell-check its four modes
- [ ] Repoint `hostBridge.ts`, pass the mode env
- [ ] Run the check, commit `test(e2e): fake codex binary beside the fake claude`

### Task 9: Codex probe in the Self-check

**Files:**
- `shared/src/messages.ts` — modify: `SelfCheckSchema` gains `codex` and `codexAuth`
- `host/src/selfcheck.ts`, `host/src/selfcheck.test.ts` — modify: deps, cache shape, probe
- `host/src/handlers.test.ts` — modify: the inline `selfCheckFn` fixture at lines 34 to 39 gains the two fields
- `host/src/index.ts` — modify: wire `codexPath` and the codex probe
- `extension/src/panel/Banner.tsx` — modify: two problem lines and the ready line
- `extension/src/panel/port.ts`, `extension/src/panel/App.test.tsx`, `e2e/election.spec.ts`, `e2e/sessions.spec.ts` — modify: the `SELF_CHECK` / `FAKE_SELF_CHECK` fixtures gain the two fields; nothing outside this list

**Interfaces:**
- Consumes: Task 5 `ResolvedModels`, Task 6 `CodexError` kinds, Task 7 `CallOpts`, Task 8's fake codex
- Produces:

```ts
// shared/src/messages.ts
SelfCheckSchema adds:
  codex: z.object({ ok: z.boolean(), path: z.string(), detail: z.string() }),
  codexAuth: z.object({ ok: z.boolean(), detail: z.string() }),
// host/src/selfcheck.ts
export interface AuthCacheFile { claude?: AuthCacheEntry; codex?: AuthCacheEntry }
SelfCheckDeps changes: readAuthCache: () => AuthCacheFile | null; writeAuthCache: (file: AuthCacheFile) => void
SelfCheckDeps adds: codexPath: string; probeCodexAuth: () => Promise<{ ok: boolean; detail: string }>
export function realProbeCodexAuth(codexPath: string, model: string): () => Promise<{ ok: boolean; detail: string }>
```

**Work:** `codex` mirrors `claude` (is the binary on disk, via the same `fileExists` rule; detail `codex CLI not found at the configured path` when missing). `codexAuth` mirrors `auth` with the same 12-hour cache: `authcheck.json` becomes `AuthCacheFile`; a legacy flat `AuthCacheEntry` on disk (has `ok` and `at` at the top level) is read as `{ claude: entry }`. Successful probes are cached per vendor; failures never are; writing one vendor's entry keeps the other's. `realProbeCodexAuth` builds a Codex runner and sends `'Reply with exactly {"ok":true}.'` with schema `z.object({ ok: z.boolean() })` and `{ model }`; `not_authed` maps to `ok: false` with detail `codex CLI is not logged in. Run \`codex login\` in a terminal.`; `rate_limit` maps to `ok: true` with detail `logged in (rate limited right now)` as the Claude probe does; any other failure maps to `ok: false` with the error message. Banner: `codex.ok` false pushes `check.codex.detail`; `codexAuth.ok` false pushes `check.codexAuth.detail`; the ready line reads `Host ready. Node <version>, claude and codex found, both signed in.` The five fixtures gain `codex: { ok: true, path: '(fake)', detail: 'found' }` and `codexAuth: { ok: true, detail: 'logged in' }`. No test asserts the old ready-line text (verified at plan time: only `Banner.tsx` and one historical plan doc contain it). Rebuild shared before running host and extension tests.

**Acceptance check:** `npm run build -w @jff/shared && npm run typecheck && npx vitest run && npx playwright test e2e/full-loop.spec.ts` green, with `selfcheck.test.ts` covering: both probes run when both caches are stale; a fresh codex cache skips the codex probe; a legacy flat cache file is read as the claude entry; a codex `not_authed` yields `codexAuth.ok === false`. The full-loop banner assertion at `e2e/full-loop.spec.ts:92` stays green because Task 8's fake answers the probe. Red state before: typecheck fails on the five fixtures once the schema gains required fields.

**Boundaries:** The auto-scan gate logic in `App.tsx` (around lines 1104 to 1117) is untouched; a failed codex probe shows in the banner and does not block the gate any differently than a failed claude probe does today. No new panel component.

- [x] Schema, shared rebuild, five fixtures, typecheck green
- [x] `selfcheck.ts` cache shape and codex probe, tests red then green
- [x] Banner lines, `index.ts` wiring
- [x] Run the check, commit `feat(selfcheck): probe codex sign-in beside claude`

### Task 10: Route facts extraction and mapping to Codex

**Files:**
- `host/src/llm/factsExtract.ts`, `host/src/llm/mapping.ts` — modify: runner type `CodexRunner`
- `host/src/llm/factsExtract.test.ts` — modify: fake typed as `CodexRunner`
- `host/src/resolve/waterfall.ts`, `host/src/resolve/waterfall.test.ts` — modify: `runner: ClaudeRunner` becomes `codex: CodexRunner`, error branch on `CodexError`, the test's `runnerThatThrows` helper and its deps literals follow
- `host/src/handlers.ts`, `host/src/handlers.test.ts` — modify: pass `deps.codex` with `{ model, timeoutMs: 240_000 }` to facts and the waterfall, map `CodexError` on the facts path to the host error
- `e2e/full-loop.spec.ts` — modify: the rate-limit test (lines 175 to 206) starts the host with `codexMode: 'rate_limit'` instead of `mode: 'rate_limit'` and keeps its assertion; nothing outside this list

**Interfaces:**
- Consumes: Task 7 signatures, Task 6 `CodexError` kinds, Task 8's `codexMode`
- Produces:

```ts
runFactsExtract(runner: CodexRunner, cvText: string, opts: CallOpts)
runMapping(runner: CodexRunner, input: MappingInput, opts: CallOpts)
interface WaterfallDeps { db: Database.Database; codex: CodexRunner; mappingOpts: CallOpts }
```

**Work:** Only the runner type, the time budget and the error class change. Both call sites pass `timeoutMs: 240_000` so the budget is what the Claude runner gave them. The waterfall's `instanceof ClaudeError` branch (near `waterfall.ts:121`) becomes `instanceof CodexError`, producing the same `llm-error:<kind>` / `llm-unavailable` statuses; the kinds `rate_limit`, `not_authed`, `not_installed`, `timeout`, `process`, `invalid_output` all exist on both sides after Task 6, so `waterfall.test.ts`'s existing `llm-error:rate_limit` assertion (lines 184 to 186) keeps passing with the helper retyped. The facts handler near `handlers.ts:173` catches `CodexError` and returns a host error with the same kind, one to one (`HOST_ERROR_KINDS` at `shared/src/messages.ts:11-14` already contains every one). Draft generation stays on the Claude runner, review stays on Codex. `host/src/llm/mapping.test.ts` needs no change: it never calls `runMapping` (verified at plan time).

**Acceptance check:** `npm run typecheck && npx vitest run host && npx playwright test e2e/full-loop.spec.ts` green, with `handlers.test.ts` asserting that `facts.extract` and `resolve` call the codex fake with `timeoutMs: 240_000` and never the claude fake, and that a `CodexError('not_authed')` from the codex fake surfaces as the `not_authed` host error on `facts.extract` and as `needs input` rows on `resolve`. Red state before: those assertions see the claude fake called.

**Boundaries:** Prompt builders and schemas byte-identical. No panel change (Task 11 owns the copy). If `HostErrorKind` lacks a value the mapping needs, stop and report `blocked: HostErrorKind has no <kind>`.

- [x] Handler tests red for the routing assertions
- [x] Switch types, deps, budgets and error branches
- [x] Rewrite the full-loop rate-limit test as a codex story
- [x] Run the check, commit `feat(host): resume facts extraction and field mapping run on codex`

### Task 11: Vendor-neutral panel copy

**Files:**
- `extension/src/panel/port.ts` — modify: `ERROR_COPY` lines 22 to 27
- `extension/src/panel/port.test.ts` — modify: the five assertions at lines 140 to 145
- `extension/src/panel/ScanStatus.tsx` — modify: line 25
- `extension/src/panel/ScanStatus.test.tsx` — modify: line 22
- Whatever renders `ERROR_COPY[kind]` for a host error in `App.tsx` (find with `git grep -n 'ERROR_COPY' extension/src/panel/App.tsx`) — modify: append the host's own message after the copy when present; nothing outside this list

**Interfaces:**
- Consumes: the host error envelope's `message` field (already carried; check `shared/src/messages.ts` `HostResponseSchema` error branch)
- Produces: no new exports

**Work:** New copy, verbatim:

```
not_installed: 'AI helper not found. Check the host config path.'
not_authed:    'AI helper not signed in. Run `claude` or `codex login` in a terminal, then retry.'
timeout:       'AI call failed. Retry or fill manually.'
process:       'AI call failed. Retry or fill manually.'
invalid_output:'AI returned unusable output. Fields are left as needs-input.'
```

`rate_limit`, `db`, `bad_request`, `unreachable` stay unchanged (the full-loop test asserts `Subscription rate limit`). The resolving status becomes `Matching <n> fields… (an AI call can take a minute)`. Where the panel renders a host error from `ERROR_COPY`, it renders the host's `message` on a second line when it is non-empty, so the vendor named by the host (`codex CLI is not logged in`, `claude CLI is not logged in`) reaches the user. If no host message is available on that path, say so in the commit message and leave the copy alone.

**Acceptance check:** `npm run typecheck && npx vitest run extension` green with the updated assertions, and `git grep -n -i 'claude' extension/src/panel/port.ts extension/src/panel/ScanStatus.tsx` prints only comment lines. Red state before: the five `port.test.ts` assertions and the `ScanStatus` table row expect the old strings.

**Boundaries:** No change to `Banner.tsx` (Task 9 owns it). No change to error kinds.

- [x] Update the copy and the two tests
- [x] Render the host message under the copy
- [x] Run the check, commit `feat(panel): vendor-neutral AI error copy, host message shown beneath`

### Task 12: Full verify, plain dist, live model ids

**Files:**
- `docs/plans/2026-09-02-harness-v3-migration.md` — modify: `## Progress` counts; nothing outside this list

**Interfaces:**
- Consumes: everything above
- Produces: recorded evidence

**Work:** On an idle machine (`uptime` first), run `npm run verify`. Then `npm run build` and the build proof grep. Then prove every pinned id from the shell:

```
claude -p 'Reply with exactly {"ok":true}.' --model claude-opus-5 --output-format json
codex exec -m gpt-5.6-sol  -s read-only --ephemeral --skip-git-repo-check --color never 'Reply with exactly {"ok":true}.'
codex exec -m gpt-5.6-luna -s read-only --ephemeral --skip-git-repo-check --color never 'Reply with exactly {"ok":true}.'
```

Record unit and e2e counts, the grep result, and the three CLI replies under `## Progress`. If a foundation e2e test fails, re-run `npx playwright test e2e/foundation.spec.ts` isolated before judging it.

**Acceptance check:** `npm run verify` exits 0; `grep -rl 'jffFakeHost' extension/dist | wc -l` prints 0 after `npm run build`; all three CLI commands print a body containing `"ok":true`. Red state before: not applicable, this is the gate.

**Boundaries:** No code edits. A red here is reported with its output, not patched around; a fix goes back to the owning task. If an id is rejected by its CLI, stop and report `blocked: <cli> rejects <id>`.

- [ ] `npm run verify` on an idle machine, counts recorded
- [ ] `npm run build`, grep proof recorded
- [ ] Three live CLI calls recorded
- [ ] Commit `docs(plan): task 12 verify evidence`

### Task 13: Harness repo edits

**Files:**
- `~/.claude/CLAUDE.md` — modify: model table header, the legend line above the table, and the sentence below it that begins `Cost is what I pay`
- `~/.claude/settings.json` — modify: add `"autoMemoryEnabled": false`
- `~/.claude/projects/*/memory/` — move to `~/.claude/archive/memory-2026-09-02/<project-dir-name>/`; nothing outside this list

**Interfaces:**
- Consumes: spec D1 to D5
- Produces: one commit on the `~/.claude` repo, pushed

**Work:** In the table at `~/.claude/CLAUDE.md:42`, rename the `cost` column to `affordability` and widen the separator row to match. Insert directly above the table: `All columns score 1 to 10, higher is better. Affordability 10 is the cheapest for me.` Rewrite the sentence below the table that starts `Cost is what I pay` so it reads `Affordability is what I pay, inverted (OpenAI is near-free for me).` and keep the rest of that paragraph. Row values unchanged. Add `"autoMemoryEnabled": false` at the top level of `settings.json`, keeping the file valid JSON and its key order otherwise. Move every `memory` directory with `mv`, one destination folder per project directory name. `~/.claude` may start in accept-edits mode; if a write is blocked, report which one rather than working around it. Commit as `harness: affordability column, auto-memory off, memory dirs archived` with `git -C ~/.claude` and push.

**Acceptance check:** `grep -c 'affordability' ~/.claude/CLAUDE.md` prints 2 or more and `grep -c 'Cost is what I pay' ~/.claude/CLAUDE.md` prints 0; `node -e "const s=require(process.env.HOME+'/.claude/settings.json'); process.exit(s.autoMemoryEnabled===false?0:1)"` exits 0; `ls -d ~/.claude/projects/*/memory 2>/dev/null | wc -l` prints 0; `ls ~/.claude/archive/memory-2026-09-02 | wc -l` prints 47; `git -C ~/.claude status --short` is empty after the push (`projects` and `archive` are gitignored there, verified at plan time). Red state before: the first grep prints 0.

**Boundaries:** Nothing else in `~/.claude` changes. The trusted-repo setting is not touched. Nothing is deleted.

- [ ] Table, legend and cost sentence
- [ ] Settings key
- [ ] Archive move
- [ ] Run the check, commit and push with `git -C ~/.claude`

### Task 14: Remote, ai-staging, PR, handoff

**Files:**
- `HANDOFF.md` — rewrite (untracked, excluded via `.git/info/exclude`); nothing outside this list

**Interfaces:**
- Consumes: the finished branch
- Produces: `origin`, `ai-staging`, an open PR, a v3 handoff

**Work:** In order:

1. `gh repo create kevinshibuya/job-form-filler --private --source=. --remote=origin` without `--push`.
2. Stop and ask the user to run the one push of `main`, since the merge hook blocks it for the agent:
   `ALLOW_MAIN_MERGE=1 git push -u origin main`
3. After the user confirms: `git branch ai-staging main && git push -u origin ai-staging` (verified at plan time against `block-merge-to-main.sh`: `ai-staging` does not match the protected-ref pattern).
4. `git push -u origin harness-v3-migration`, then `gh pr create --base ai-staging --title "Harness v3 migration" --body-file <a body written to the scratchpad>`. The body lists the four deliverables, the model table, the verify evidence from Task 12, and ends with the required attribution lines.
5. Rewrite `HANDOFF.md` in the v3 format from `~/.claude/skills/handoff/SKILL.md`: Next action is Task 19 of the onboarding plan with the Chrome-tools routing from spec A8; Dead ends carries the four OPEN items; State carries the PR URL, branch, counts; Suggested skills names `pickup`, `executing-plans`, `retro`. `.superpowers/` stays.
6. Give the user the manual-test rundown, in this order: `npm run build && npm run install-host -w @jff/host` (the Self-check schema gained required fields, an old host fails to parse), reload the unpacked extension, open the panel on any posting and confirm the banner says claude and codex found and both signed in, scan a form with a leftover field and confirm mapping still resolves, generate one draft, run the settings "extract facts" button once, then `codex logout`, reopen the panel and confirm the banner names the codex sign-in, `codex login`, reopen, banner green. Then stop.

**Acceptance check:** `git remote get-url origin` prints the GitHub URL; `git ls-remote --heads origin` lists `main`, `ai-staging` and `harness-v3-migration`; `gh pr view --json baseRefName -q .baseRefName` prints `ai-staging`. Red state before: `git remote` prints nothing.

**Boundaries:** Never run the `main` push yourself. Never merge. The review wave on the PR is the user's to trigger.

- [ ] Create the repo and remote
- [ ] Ask the user for the `main` push, wait
- [ ] Create and push `ai-staging`, push the branch, open the PR
- [ ] Rewrite `HANDOFF.md`, give the rundown, stop

## Progress

### Task 0 baseline (2026-09-02)

Branch `harness-v3-migration` created from `main` at `23248d8`. The three untracked docs committed as `79fce81`.

Measured on this branch, machine under load (load average 10.11 on 8 cores; unit tests are not gated on an idle machine, `verify` and `smoke` are):

- `npm run typecheck` — exit 0
- `npm run lint` — exit 0
- `npx vitest run` — exit 0, 51 test files, 794 tests, all passing

Identical to the counts recorded at plan authoring. No drift.

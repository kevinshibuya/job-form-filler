# Harness v3 migration: design

**Date:** 2026-09-02
**Grilled on:** Fable 5.1, four rounds, 27 questions, all answers recorded here.
**Companion docs:** `CONTEXT.md` (written during the grill), `docs/adr/0001` to `0006` (written by the plan).

## Goal

Bring job-form-filler in line with the v3 Claude Code harness that landed in
`~/.claude` on 2026-08-31 and 2026-09-01, and with the model routing rules that
follow from the Fable 5.1 launch. The project was built under the v2 harness
(superpowers skills, SDD ledger, QA-gate registry, architect and implementer
agents), all of which no longer exist.

## Scope

Four deliverables. A, B and D are structural. C changes product behaviour.

- **A. Project structure**: docs layout, plan headers with in-file progress,
  glossary, ADRs, project CLAUDE.md, project settings.
- **B. Git flow**: a remote and an `ai-staging` branch so the PR-based flow works.
- **C. Product model routing**: every LLM task names its model explicitly.
- **D. Harness repo**: the model table fix and the auto-memory switch in `~/.claude`.

Out of scope, handed to a follow-on Opus session: Task 19 of the
onboarding/sessions/applied/combobox plan (the live manual browser gate) and the
retro of that plan.

## Requirements

### A. Project structure

- **A1.** `docs/superpowers/plans/*` moves to `docs/plans/` and
  `docs/superpowers/specs/*` moves to `docs/specs/`, with `git mv` so history
  follows. `docs/superpowers/` no longer exists afterwards. File names are
  unchanged. Every in-repo path that points at the old location is updated.
- **A2.** The six finished plans (`2026-07-27-job-form-filler-v1`,
  `2026-07-28-scan-fill-1-core`, `2026-07-28-scan-fill-2-interaction`,
  `2026-07-28-scan-fill-3-fill`, `2026-07-28-scan-observability`,
  `2026-07-29-generation-recall-combobox`) each get a status block directly
  under the H1, two lines: `**Status:** completed <date of last commit touching
  its scope>` and `Progress was tracked in the SDD ledger, which no longer
  exists. Checkboxes below reflect authoring, not execution.` No checkbox is
  ticked retroactively.
- **A3.** The active plan `2026-07-29-onboarding-sessions-applied-combobox.md`
  gets the v3 header: `**Goal:**`, `**Architecture:**`, `**Spec:**` (its new
  path under `docs/specs/`), `**Execution model:** opus`. The superpowers
  sub-skill banner is removed. Tasks 0 to 18 have every checkbox ticked, and
  each task heading is followed by one line `Done: <commit range or hash>, see
  progress notes.` The decision rulings from the ledger's `progress.md`
  (parked items, adjudications, deviations) are folded into a
  `## Progress notes` section at the end of the plan, one bullet per ruling,
  so the ledger can be deleted later without losing them. Task 19's text is
  rewritten to the routing in A8.
- **A4.** `CONTEXT.md` at the repo root holds the domain glossary agreed in the
  grill, 35 terms in five groups, no implementation terms. Already written.
- **A5.** `docs/adr/` holds six ADRs in the domain-modeling format, one
  paragraph each, numbered 0001 to 0006:
  1. `0001-llm-via-spawned-clis.md`: LLM calls spawn the `claude` and `codex`
     CLIs on the user's subscriptions. No SDK, no API keys, no cost outside the
     subscriptions. Trade-off: no streaming, no tool use, JSON parsed out of
     prose.
  2. `0002-native-host-with-sqlite.md`: a native-messaging host with SQLite holds
     all state. Not extension storage (size, no SQL, no file access for the
     Resume), not a cloud service (the user's application data stays local).
  3. `0003-ats-scoped-tracking-param-stripping.md`: the Canonical URL strips
     `ref` and `source` only on known ATS hosts. Global stripping can collapse
     two distinct postings onto one Canonical URL; the cost of not stripping
     off-ATS is a missed Revisit badge.
  4. `0004-draft-then-review-with-fallback.md`: every Draft is written by Claude
     and reviewed by Codex in the same request. A review failure ships the
     unreviewed Draft with a warning rather than nothing.
  5. `0005-claude-for-prose-codex-for-structure.md`: Claude runs only where
     taste matters (the Draft); GPT models via Codex run the structured tasks
     (extraction, mapping, review, probes). The mechanism is that each LLM task
     names its model explicitly with an exact id from the harness model table
     (`~/.claude/CLAUDE.md`), never inherited from the CLI default. Reason: the
     CLI default follows whatever the user last set with `/model`, which put the
     product on the most expensive, slowest model without anyone deciding it.
     Cost of the split: prompts tuned per vendor, two sign-ins, a doubled e2e
     fake matrix.
  6. `0006-anti-fabrication-is-structural.md`: the mapping response schema has
     no value field, so the model cannot return answer text; every Value comes
     from the store. Reason: a model that can return a value will eventually
     invent one, and the tool's promise is that it never does. Cost: less
     flexible mapping.
- **A6.** A project `CLAUDE.md` at the repo root, under 40 lines, holding only
  project-local lessons the code does not say:
  - The build proof: after `npm run build`, `grep -rl 'jffFakeHost' extension/dist | wc -l` must print 0. The `JFF_TEST_SEAM` string is a compile-time define and never reaches a bundle, so grepping for it proves nothing.
  - `npm run smoke` and `npm run verify` drive a real Chrome with the unpacked extension; they are not read-only commands and leave a seam dist behind.
  - Run `npm run verify` only on an idle machine (check `uptime` first). Unit `waitFor` timeouts and cross-test timer leaks surface under load; a failure scattered across untouched files, different each run, is load noise. Re-run isolated at idle before investigating.
  - Before any live check: reload the unpacked extension at `chrome://extensions`.
  - Before any onboarding test on the real profile: back up `~/.job-form-filler/db.sqlite` and restore it after.
  - After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests.
  - Product model routing lives in `host/src/llm/models.ts` and follows the harness model table. Override per task under `models` in `~/.job-form-filler/config.json`.
  - Branch flow: feature branch, PR into `ai-staging`. Never commit on `main`.
- **A7.** A tracked `.claude/settings.json` holding only a Bash allowlist for
  the project's verification commands not already in the global list:
  `npm test`, `npm run test`, `npm run smoke`, `npm run verify`,
  `npm run build`, `npm run build -w @jff/shared`, `npx playwright test:*`.
  No hooks, no model, no mode.
- **A8.** `HANDOFF.md` is rewritten at the end of the migration in the v3
  handoff format (Next action, Dead ends, State, Suggested skills). Its next
  action is Task 19 with this routing: steps 2 to 8 of the gate run through the
  Chrome browser tools with the user watching; step 1 (wipe and restore the
  profile DB) runs only after the user says so in that session; the user's own
  pass is the final acceptance; then the retro. The archived session-7 handoff
  file stays untouched. `.superpowers/` stays until Task 19 and the retro are
  done.

### B. Git flow

- **B1.** A private GitHub repository `kevinshibuya/job-form-filler` is created
  with `gh repo create`, `origin` points at it.
- **B2.** `main` is pushed once. That push names a protected ref and is blocked
  by the merge hook, so the user runs it with the `ALLOW_MAIN_MERGE=1` prefix.
  The plan stops and asks at that step.
- **B3.** `ai-staging` is created from `main` and pushed.
- **B4.** All migration work happens on a feature branch
  `harness-v3-migration` created from `main` before any file changes, and lands
  as a PR into `ai-staging`.

### C. Product model routing

Five LLM tasks exist in the host today and C6 adds a sixth. The word Resume
follows the glossary; the code keeps its `cvText` identifiers. Their models after
this change:

| Task | Task name | Entry | Runner | Model |
|---|---|---|---|---|
| Resume facts extraction | `factsExtract` | `host/src/llm/factsExtract.ts` | codex | `gpt-5.6-sol` |
| Field mapping | `mapping` | `host/src/llm/mapping.ts` | codex | `gpt-5.6-sol` |
| Draft generation | `generate` | `host/src/llm/generate.ts` | claude | `claude-opus-5` |
| Draft review | `reviewDraft` | `host/src/llm/reviewDraft.ts` | codex | `gpt-5.6-sol` |
| Claude auth probe | `claudeAuthProbe` | `host/src/selfcheck.ts` | claude | `claude-opus-5` |
| Codex auth probe | `codexAuthProbe` | `host/src/selfcheck.ts` | codex | `gpt-5.6-luna` |

The probes only need any answer, so each runs on the cheapest row of its
vendor. Mapping runs on sol rather than terra because it is cross-lingual
classification against eighteen keys and saved-answer ids, and a wrong key puts
a proposed Value in the wrong box; terra stays one config edit away.

- **C1.** A module `host/src/llm/models.ts` exports the task names as a closed
  union, the default model id per task (the table above), and a resolver that
  applies config overrides. Model ids are exact strings, never aliases.
- **C2.** The Claude runner always passes `--model <id>`. The Codex runner
  always passes `-m <id>`. Each runner takes the model and an optional timeout
  per call, so one runner instance serves several tasks and each task keeps its
  own time budget.
- **C3.** `~/.job-form-filler/config.json` accepts an optional `models` object
  keyed by task name with string values. Unknown keys and non-string values are
  ignored with a warning in the host log, never a crash. Defaults apply for any
  task not overridden.
- **C4.** Resume facts extraction and Field mapping call the Codex runner.
  Their prompt builders, zod schemas and degradation paths are unchanged: an
  extraction failure still surfaces as a host error to the panel, a mapping
  failure still yields an empty map and `needs input` for every leftover Field,
  and a rate-limited mapping still reports `rate_limit`. The only prompt
  difference is the few-word suffix each runner appends after the prompt body.
  Both tasks keep their current 240-second budget.
- **C5.** The Codex runner classifies a usage-limit exit as `rate_limit` and a
  signed-out exit as `not_authed`, checking the rate-limit pattern first as the
  Claude runner does. It retries once after a transient failure (timeout or
  process error) with a short backoff. Terminal failures (not installed, not
  signed in, rate limited) never retry. The runner's default timeout stays at
  120 seconds; callers that need more pass it per call.
- **C6.** The Self-check probes Codex sign-in the same way it probes Claude,
  cached under the same 12-hour rule, and reports both results to the panel.
  A signed-out Codex shows in the panel before the first Scan, not as a silent
  mapping failure.
- **C7.** Tests: one unit test per runner asserts the spawned argv carries the
  model id; one test asserts config overrides win over defaults and bad
  overrides fall back; one test each for the Codex retry, the Codex rate-limit
  and sign-in classification, and the Codex probe. Existing runner tests stay
  green.
- **C8.** The e2e suite gets a fake `codex` binary beside the fake `claude`,
  honouring `-m` and `-o <file>`, with modes ok, not_authed, rate_limit and
  timeout selected by `JFF_FAKE_CODEX_MODE`. The host bridge points `codexPath`
  at it. The fake answers the mapping prompt like the fake claude does, answers
  the review prompt with the Draft unchanged, and answers the probe with
  `{"ok":true}`. The full-loop rate-limit test becomes a Codex rate-limit
  story.
- **C9.** The panel's LLM error copy stops naming a vendor. Each line says what
  happened and what to do ("AI helper not signed in. Run `claude` or `codex
  login` in a terminal, then retry."), and the host's own message, which names
  the vendor, is shown under it. The resolving status line stops saying Claude.

### D. Harness repo

- **D1.** In `~/.claude/CLAUDE.md`, the model table column `cost` becomes
  `affordability` and the line before the table reads: `All columns score 1 to
  10, higher is better. Affordability 10 is the cheapest for me.` Row values
  unchanged. No new rows.
- **D2.** `~/.claude/settings.json` gains `"autoMemoryEnabled": false`.
- **D3.** Every `~/.claude/projects/*/memory/` directory moves to
  `~/.claude/archive/memory-2026-09-02/<project-dir-name>/`. Nothing deleted.
- **D4.** Committed and pushed in the `~/.claude` repo with `git -C ~/.claude`.
- **D5.** The auto-mode trusted-repo setting is not changed.

## Verification

- Typecheck, lint and unit tests green on the feature branch.
- `npm run smoke` green on an idle machine, because C changes the host the
  panel talks to.
- Plain dist restored and the build proof grep prints 0.
- Every pinned id is proved live from the shell with a one-line prompt:
  `claude-opus-5` through `claude -p`, and `gpt-5.6-sol`, `gpt-5.6-luna`
  through `codex exec`.
- The signed-out path is proved once by hand: `codex logout`, reinstall the
  host, reload the extension, the banner names the Codex sign-in, `codex login`,
  banner green.
- The manual rundown starts with rebuilding and reinstalling the host, since the
  Self-check schema gains required fields and an old host would fail to parse.
- PR into `ai-staging` opened, manual-test rundown given, stop.

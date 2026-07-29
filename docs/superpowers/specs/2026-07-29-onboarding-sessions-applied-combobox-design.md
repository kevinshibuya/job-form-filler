# Onboarding gate + per-tab sessions + applied jobs + Greenhouse combobox

Four items from the 2026-07-29 user review (post session-7): (1) a hard onboarding flow
before any scanning, (2) per-tab application sessions that survive tab switching and
multi-page wizards, (3) recording jobs the user has applied to (the TRM/Ashby test job is
now applied; the new test page is
<https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002>), and (4) a combobox
fill failure on that Greenhouse page ("oth" does not select "Other").

Decisions were made interactively (AskUserQuestion); each Design section records the
alternative considered.

## TODO

Implementation status. Tick as each lands with its tests.

- [ ] O1 Onboarding completeness rule: exported `isProfileComplete(facts, hasResume)` —
      resume stored AND email, phone, and (fullName OR firstName+lastName) non-empty;
      required-key list is a plain exported const (extensible over time)
- [ ] O2 `OnboardingView` component: CV upload (reuses `saveResume` + text extraction) →
      auto-runs `facts.extract` and pre-fills EMPTY fields → full profile field list with
      required markers → Finish enabled only when the completeness rule passes
- [ ] O3 Gate wiring in `App`: on mount (after selfCheck) load resume + `profile.get` +
      `answerBank.get`; incomplete → render OnboardingView INSTEAD of scan UI, no
      auto-scan; Finish → normal panel flow begins. Existing installs with complete
      profiles never see the gate
- [ ] S1 `sessions` module: `Session` type (per-application state slice: fields,
      resolutions, election, edits, generatedRefs, filledRefs, snapshot, reuseOverrides,
      company, jobText, epoch, site) + load/save/remove on `chrome.storage.session`
      keyed by tabId, writes debounced; in-flight state (scanning, generatingRefs,
      generateAll progress) is never persisted
- [ ] S2 `App` refactor: the per-application state lives in the active session; tab
      switch SAVES the current session and DISPLAYS the activated tab's session (or an
      empty one) instead of clearing — no re-scan on switch
- [ ] S3 Navigation semantics: same-site navigation (same registrable domain) KEEPS the
      session and triggers a re-scan of the new page merged over kept answers/drafts
      (multi-page wizards); cross-site navigation and tab close END the session and
      remove it from storage
- [ ] S4 Panel reopen rehydrates sessions from `chrome.storage.session` (dies with the
      browser); on rehydrate, sessions whose tab no longer exists are pruned
- [ ] S5 Per-session epochs preserve the existing merge/abort machinery (re-scan still
      silently aborts a running generate-all; a scan settling after a tab switch writes
      to ITS session, not the visible one)
- [ ] A1 Host: `applied_jobs` table (id, url UNIQUE, company, job_title, applied_at) +
      repos + methods `applied.mark`, `applied.check`, `applied.list` (the existing
      `applications` save-log table is untouched)
- [ ] A2 Panel "Mark applied" button: records via `applied.mark` (url = job posting URL
      captured at session start, company from panel, job_title from harvest/tab title,
      nullable) and ends the session
- [ ] A3 Submission detection: after a same-site navigation re-scan, if the previous
      page had fillable fields and the new page has none OR its text matches
      confirmation patterns ("thank you for applying", "application submitted",
      "application received", …), show a non-blocking "Mark as applied?" prompt —
      never record silently
- [ ] A4 Revisit badge: before auto-scan, `applied.check(url)`; a hit renders
      "Already applied on <date>" instead of scanning, with a "Scan anyway" action
- [ ] A5 Applications list view in the panel: date, company, title, link (from
      `applied.list`); reachable from the main view
- [ ] A6 Seed the session-7 TRM/Ashby job as applied (one-off insert with its posting
      URL from the session-7 manual-gate log)
- [ ] C1 Reproduce + root-cause the Greenhouse combobox failure live on the test URL
      (systematic-debugging; the Ashby-verified typeahead arm demonstrably misfires
      there), root cause documented in the plan before the fix lands
- [ ] C2 Fix `fill.ts` for the Greenhouse widget class without regressing the Ashby
      arm (B1a–B1d invariants: typeahead always driven, unique-substring match,
      committed-text verification)
- [ ] C3 E2E fixture reproducing the Greenhouse widget behavior as a regression test
- [ ] E2E: two-tab switching preserves both sessions' work; same-site wizard navigation
      merges; onboarding gate blocks scan until complete
- [ ] Manual browser gate on the real Greenhouse page: onboarding (fresh profile), scan,
      fill incl. the Degree dropdown, tab-switch round-trip, mark applied, revisit badge

## Context

- `tabScope.ts` today deliberately binds the panel to ONE tab and clears ALL state on
  `activated`/`navigated`/`removed` — the exact behavior the user reports as losing work.
  Its comment explains the v1 rationale (stale wizard steps); sessions replace "clear"
  with "swap/merge" while keeping the staleness guarantees per session.
- `App.tsx` (852 lines) holds the per-application state as ~15 flat `useState`s plus
  epoch/reset refs seeded from `Date.now()`. The S-slices restructure this into a
  session object without changing the scan/resolve/fill flows themselves.
- Profile building blocks already exist: `ProfileEditor` over the 18 `FIELD_KEYS`
  (`shared/src/keys.ts`), resume upload with CV text extraction (`resume.ts`,
  IndexedDB), host `facts.extract` with empty-only merge (session-7 B6). Onboarding
  composes these; it adds no new storage.
- Host DB already has an `applications` table, but it is a SAVE-EVENT LOG (one insert
  per save, with fill counts). "Applied" is a different concept — one row per job the
  user actually submitted — hence the separate `applied_jobs` table.
- Session-7's combobox work (B1a–B1d) was live-verified on Ashby only. Greenhouse's
  widget fails: with options loaded and "oth" typed, Fill does not commit "Other". Root
  cause unknown until C1 (candidates: portal-rendered listbox not found, option
  text/commit verification mismatch, open-click vs focus ordering).

## Design

### O — Onboarding gate (hard)

**Decision: hard gate; core required = CV + name + email + phone.** (Alternatives: soft
nag banner; CV-only requirement. Rejected — the user wants scanning impossible until the
baseline profile exists, and core contact fields are what nearly every form needs.)

Flow: panel mount → selfCheck → load resume + facts. If `isProfileComplete` fails, render
`OnboardingView` (no auto-scan, no tab-scope scan triggers). Steps inside the view:

1. **CV upload** — same `saveResume` path (blob + extracted text to IndexedDB).
2. **Auto-extract** — on successful upload, call `facts.extract` and merge into EMPTY
   fields only (same rule as ProfileEditor's "Generate from CV").
3. **Review** — all 18 `FIELD_KEYS` rendered (same grouping as ProfileEditor), required
   ones (`email`, `phone`, name) marked. Everything else skippable: salary, linkedin,
   portfolio, location, workAuth, etc.
4. **Finish** — enabled when complete; persists via `profile.set`/`answerBank.set`, flips
   the gate, normal flow (auto-scan) starts.

The required-key list is one exported const so future "we decided salary is required too"
changes are one-line. ProfileEditor remains the post-onboarding edit path; OnboardingView
reuses its field-rendering rather than duplicating it (extract a shared piece if needed).

### S — Per-tab application sessions

**Decision: sessions live in the panel, persisted to `chrome.storage.session`, keyed by
tabId.** (Alternative: background-service-worker-owned state — rejected: MV3 workers are
themselves ephemeral, so it duplicates the persistence problem and doubles the plumbing.)

A `Session` is the per-application slice of today's App state (see S1). The panel keeps
`Map<tabId, Session>` semantics with the ACTIVE session rendered. Lifecycle:

| Event | Behavior |
|---|---|
| Tab switch | Save current session; display activated tab's session (or empty state). No scan fires. |
| Same-site navigation | Session survives. Re-scan the new page; merge results over kept answers/drafts (wizard step 2 sees step-1 work for fields still present; new fields resolve normally). |
| Cross-site navigation | Session ends, storage entry removed, fresh empty state (auto-scan per normal rules). |
| Tab closed | Session ends, storage entry removed. |
| Panel closed/reopened | Rehydrate all sessions from storage; prune entries whose tab is gone. |
| Browser restart | `storage.session` is gone by definition — clean slate. |

"Same site" = same registrable domain (eTLD+1); a minimal suffix heuristic is fine (the
plan decides the exact comparison — full PSL is out of scope). Rationale: Greenhouse and
Workday wizards hop subdomains/paths within one site; hopping to a different site is a
different application.

Epochs and races: each session carries its own epoch (seeded at session creation, still
clock-based). The session-7 invariants hold per session: a settling scan or generate
writes to the session it started in — if that session is no longer displayed, the write
goes to storage, not the screen; if the session died (cross-site nav/close), the write is
dropped. `generatingRefs`/`generateAll`/`scanning` are in-flight only: a tab switch
mid-generate lets the work complete into its session, but rehydration after panel close
loses only the in-flight spinners, never committed drafts.

Storage bounds: sessions are small JSON (fields + resolutions + edits); `storage.session`
allows 10 MB. Pruning on rehydrate plus removal on close/cross-site keeps the map tidy;
no LRU needed.

### A — Applied jobs

**Decision: record + revisit badge + list; detect-and-confirm, manual button as
fallback.** (Alternatives: manual-only — user must remember; fully automatic — false
positives write wrong records; full status-tracker CRM — YAGNI.)

- Host: `applied_jobs(id, url UNIQUE, company, job_title, applied_at)`; methods
  `applied.mark` (upsert by url), `applied.check(url)`, `applied.list`.
- The session captures the job posting URL at session start (first scanned page — later
  wizard pages keep the ORIGINAL url, which is the one worth recording).
- **Mark applied** button lives with the session UI; on confirm it records and ends the
  session.
- **Detection** is only a prompt: same-site nav where fields went from >0 to 0, or
  confirmation-pattern text match. No silent writes.
- **Revisit**: `applied.check` runs before auto-scan; a hit shows the badge + date and
  suppresses the scan ("Scan anyway" overrides — also the escape hatch for re-applying).
- **List view**: read-only v1 — date, company, title, link out to the posting.
- The TRM/Ashby job is seeded once (A6) so the record reflects reality.

### C — Greenhouse combobox

Bug, not a feature: C1 reproduces it live (agent-driven browser, same harness as the
session-7 manual gate) and root-causes before any fix. C2 must keep the Ashby arm's
invariants intact (the e2e combobox fixtures from session 7 stay green) and C3 adds a
Greenhouse-shaped fixture. Known facts from the report: options ARE present ("Other"
exists), "oth" is a unique 3-char substring, the panel classified the field `custom` with
hint "dropdown — options load on fill", and Fill visibly does nothing on the page.

## Error handling

- Onboarding: `facts.extract` failure is non-fatal — fields stay empty, user types them.
  Resume-extraction failure follows the existing silent-degradation rule (blob stored,
  no cvText). Host down during onboarding → existing host-error banner; gate stays.
- Sessions: a corrupt/unparseable stored session is dropped (fresh state), never crashes
  the panel. Storage write failures degrade to in-memory behavior (today's status quo).
- Applied: `applied.mark` failure surfaces the standard host-error copy and does NOT end
  the session (retryable). `applied.check` failure → proceed as not-applied (scan runs).
- Detection prompt: dismissible; dismissing never re-prompts for the same page load.

## Testing

- Unit: completeness rule truth table; OnboardingView (upload → prefill → required
  gating → finish); session (de)serialization + prune; tab-switch swap; same-site vs
  cross-site classification; merge-over-kept-answers; applied repos + handlers;
  detection heuristic (fields-vanished, pattern-match, no-false-positive on ordinary
  step pages); revisit-badge gating; combobox fix regression at the unit level.
- E2E (fixtures): the three flows in the E2E TODO; Greenhouse-widget fixture (C3).
- Live manual gate on the real Greenhouse page (final TODO) — the project's proven
  pattern for DOM-behavior truth.
- Full `npm run verify` on an idle machine (see flake memory); plain dist restored after.

## Out of scope

- Session survival across browser restarts (explicitly decided against — staleness risk).
- Applied-status pipeline (interview/offer/rejected), notes, editing the list.
- Making more fields required at onboarding (the const makes this a follow-up one-liner).
- The session-7 deferred findings (#5–#18) and the foundation-harness hardening — still
  queued for the retro/follow-up spec, not this batch.
- Full public-suffix-list handling for site comparison.

## Execution

Pipeline: this spec → plan (architect, slices routed per the model table) → dual plan
review (fresh Opus + codex) → implement ladder → dual branch review → live manual gate on
the Greenhouse page. S-slices touch the panel's core state machine — the plan review pays
extra attention to scan/epoch races (session-7's hardest surface).

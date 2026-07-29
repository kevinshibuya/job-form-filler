# Onboarding gate + per-tab sessions + applied jobs + Greenhouse combobox

Four items from the 2026-07-29 user review (post session-7): (1) a hard onboarding flow
before any scanning, (2) per-tab application sessions that survive tab switching and
multi-page wizards, (3) recording jobs the user has applied to (the TRM/Ashby test job is
now applied; the new test page is
<https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002>), and (4) a combobox
fill failure on that Greenhouse page ("oth" does not select "Other").

Decisions were made interactively (AskUserQuestion). Revised after a fresh-context Opus
spec review (3 blockers + 13 should-fixes folded in; see git history for the diff). The
reviewer's recommendation to split S into its own spec is instead handled by execution
ordering: O/A slices land first, the C1 spike runs before plan authoring, and the S
slices' branch review runs at effort xhigh.

## TODO

Implementation status. Tick as each lands with its tests.

### O — onboarding

- [ ] O1 Completeness is TRI-state: `complete` / `incomplete` / `unknown`. Exported
      `profileCompleteness(facts, hasResume, settled)` — `incomplete` only when the
      profile+resume loads SETTLED successfully and resume or a core fact (email, phone,
      fullName-or-firstName+lastName) is missing; load failure or timeout → `unknown`.
      Required-key list is one exported const (extensible)
- [ ] O2 `OnboardingView`: CV upload (reuses `saveResume`) → auto-runs `facts.extract`
      and pre-fills EMPTY fields (non-PDF uploads store the blob but skip auto-extract —
      the user types the fields) → all 18 `FIELD_KEYS` rendered with required markers →
      Finish enabled only on `complete`, persists via `profile.set`/`answerBank.set`
- [ ] O3 Gate wiring: auto-scan requires `gateOpen` AND a settled completeness decision;
      `incomplete` renders OnboardingView INSTEAD of scan UI (no scan triggers);
      `unknown` renders the NORMAL panel + host-error banner (never bricks an existing
      user when the host is down); existing complete profiles never see the gate

### S — per-tab sessions

- [ ] S1 `sessions` module: `Session` type with `version: 1`, an EXHAUSTIVE partition of
      App state (see Design table — per-session vs panel-global, including
      `companyGuessedRef` per-session), persisted to `chrome.storage.session` under
      `jff:session:<tabId>` (exported key regex beside `snapshotKey.ts`; must never
      match `SNAPSHOT_KEY_RE`); writes debounced AND flushed on
      `pagehide`/`visibilitychange:hidden`, un-debounced on tab switch and
      session-ending events; corrupt or version-mismatched rows dropped
- [ ] S2 Tab switch (filtered to the panel's own window) SAVES the current session and
      DISPLAYS the activated tab's session or an empty state — no scan fires on
      activation (today's economics kept: switching to a fresh tab shows empty state
      until the user clicks Scan or the tab navigates)
- [ ] S3 Navigation signal moves to `chrome.webNavigation.onCommitted` +
      `onHistoryStateUpdated` (permission already granted), carrying frameId + URL:
      top-frame AND elected-application-frame navigations both count as wizard steps;
      other subframes are noise. `tabs.onUpdated status==='loading'` remains only as a
      fallback signal
- [ ] S4 Same-site navigation keeps the session and re-scans: kept answers/drafts live
      in a ref-INDEPENDENT `answers` map keyed by `normalizeQuestion(label)` (+
      `fieldKey` when present) holding the value + provenance; after the new page's
      resolve they re-project onto matching new refs. All ref-keyed DOM assertions
      (`filledRefs`, `generatedRefs`, `snapshot`, `reuseOverrides`, `election`) are
      DROPPED on re-scan. Acceptance test: wizard step 2 with different field
      count/order attaches NO answer to a field whose label did not appear on step 1
- [ ] S5 Cross-site navigation PARKS the session (kept in storage, inactive) — SSO/OAuth
      round-trips and policy-page detours must not destroy paid drafts; returning to the
      session's registrable domain restores it. Deletion only on: tab close, mark
      applied, explicit discard. "Same site" = same registrable domain via a minimal
      suffix heuristic (full PSL out of scope)
- [ ] S6 Panel reopen rehydrates from storage; sessions whose tab is gone are pruned.
      Persisted `fields[].options` capped (≤100/field); on quota error evict the oldest
      PARKED session, never the active one
- [ ] S7 Concurrency: scan latch stays GLOBAL single-flight (at most one `resolve` in
      flight across all sessions; a background session's due re-scan queues via
      per-session pending-rescan). Epochs and generation counters are per-session.
      `snapshotPush` routes by `m.tabId` into the MATCHING session and compares against
      THAT session's epoch; `onSaveAnswers` merges with the session's tabId+epoch. A
      scan/generate settling after a tab switch writes to ITS session (storage), never
      the visible one; if its session died, the write is dropped
- [ ] S8 Retire/rewrite the clear-on-activate era tests in ONE batch before the S
      slices: `tabScope.test.ts`, `App.test.tsx` "activated never replays a scan" /
      "clears a GUESSED company on navigation", and the `data-jff-resets`/
      `data-jff-scans` e2e hooks get session-aware equivalents

### A — applied jobs

- [ ] A1 Host: `applied_jobs(id, url, canonical_url UNIQUE, company, job_title,
      marked_at)` (`marked_at`, not `applied_at` — the existing `applications` save-log
      column has different semantics) + exported `canonicalUrl()`: lowercase host, strip
      fragment + trailing slash, keep identity params (`ashby_jid`, `gh_jid`, `jobId`),
      drop tracking params (`utm_*`, `gh_src`, `ref`, `source`). Upsert by canonical_url
      preserves the ORIGINAL `marked_at`. Methods `applied.mark` / `applied.check` /
      `applied.list` with the full plumbing: `HostRequestSchema` union entries,
      `compute()` switch arms, repo functions
- [ ] A2 Panel "Mark applied" button: records via `applied.mark` (url = session's
      captured START URL — the first scanned page, not the current wizard step;
      job_title from `tab.title`, nullable; company from the panel field) and ends the
      session
- [ ] A3 Submission detection prompt (never a silent write): after a same-site
      navigation re-scan, fillable fields went >0 → 0 OR page text matches
      confirmation patterns (en: "thank you for applying", "application submitted",
      "application received"; pt: "obrigado por se candidatar", "candidatura enviada",
      "recebemos sua candidatura") → non-blocking "Mark as applied?"; dismissing never
      re-prompts for the same page load
- [ ] A4 Revisit badge: before auto-scan, `applied.check` on the canonicalized page
      URL; a hit renders "Already applied on <date>" instead of scanning, with "Scan
      anyway" (also the re-apply escape hatch)
- [ ] A5 Applications list view: date, company, title, link out. Panel navigation
      model: three mutually exclusive views (session / profile editor / applications
      list) toggled from the header
- [ ] A6 Seed the session-7 job as applied:
      `https://www.trmlabs.com/careers?ashby_jid=6edf242b-984d-41fb-8027-5f133a6353d4`

### C — Greenhouse combobox

- [ ] C1 **Pre-plan spike**: reproduce + root-cause the failure live on the test URL
      (systematic-debugging). Output — root cause + the failing DOM shape — is an INPUT
      to plan authoring; C2/C3 are only planned once it lands
- [ ] C2 Fix `fill.ts` for the Greenhouse widget class without regressing the Ashby arm
      (B1a–B1d invariants: typeahead always driven, unique-substring match,
      committed-text verification; session-7 combobox e2e stays green)
- [ ] C3 E2E fixture reproducing the Greenhouse widget behavior as a regression test

### Cross-cutting

- [ ] E2E: two-tab switching preserves both sessions' work; same-site wizard navigation
      re-projects answers by label; onboarding gate blocks scan until complete
- [ ] Manual browser gate on the real Greenhouse page: onboarding (fresh profile), scan,
      fill incl. the Degree dropdown, tab-switch round-trip, mark applied, revisit badge

## Context

- `tabScope.ts` today deliberately binds the panel to ONE tab and clears ALL state on
  `activated`/`navigated`/`removed` — the exact behavior the user reports as losing
  work. Its navigation signal (`tabs.onUpdated` `status==='loading'`) does NOT fire for
  subframe navigations or History-API SPA transitions — which is why S3 moves to
  `webNavigation`: the TRM/Ashby reference job submits inside a cross-origin IFRAME, and
  Workday wizards are SPAs; without frame-aware signals neither wizard re-scan nor
  submission detection would ever fire on the project's own reference pages.
- `App.tsx` (852 lines) holds 32 `useState`s + 7 refs; only `epochRef` is clock-seeded.
  Field identity is `ref = "frameId:fid"` and `fid` restarts at 0 every enumeration
  (`enumerate.ts:153`) — refs are MEANINGLESS across a re-scan, which forces S4's
  label-keyed answer carry (`save.ts`'s own comment: merging by ref "would attribute
  old answers to new fields and poison qa_memory").
- Profile building blocks already exist: `ProfileEditor` over the 18 `FIELD_KEYS`
  (`shared/src/keys.ts`), resume upload with CV text extraction (`resume.ts`, IndexedDB,
  PDF-only extraction), host `facts.extract` with empty-only merge (session-7 B6).
  Onboarding composes these; it adds no new storage.
- Host DB already has an `applications` table, but it is a SAVE-EVENT LOG (one insert
  per save, with fill counts, no UNIQUE). "Applied" is one row per job actually
  submitted — hence the separate `applied_jobs` table. `migrate()` is
  `CREATE TABLE IF NOT EXISTS`, so the addition is a safe no-op migration.
- Session-7's combobox work (B1a–B1d) was live-verified on Ashby only. Greenhouse's
  widget fails: options ARE present ("Other" exists), "oth" is a unique 3-char
  substring, the panel classified the field `custom` with hint "dropdown — options load
  on fill", and Fill visibly does nothing. Root cause unknown until C1 (candidates:
  portal-rendered listbox not found, commit-click vs verification mismatch, open-click
  vs focus ordering).

## Design

### O — Onboarding gate (hard)

**Decision: hard gate; core required = CV + name + email + phone.** (Alternatives: soft
nag banner; CV-only requirement. Rejected — the user wants scanning impossible until the
baseline profile exists, and core contact fields are what nearly every form needs.)

Completeness is tri-state because facts arrive over the native port: `profile.get`/
`answerBank.get` can fail or time out, and an existing user with a complete profile must
NEVER be walled into onboarding by a dead host (they'd have no working Finish either).
Only a successful load proving the profile incomplete shows `OnboardingView`; `unknown`
falls back to the normal panel + the existing host-error banner and `HOST_WAIT_MS`
semantics. The auto-scan effect additionally waits for the completeness decision to
settle — today it fires on `[tabId, scanNonce, gateOpen]` alone, which would race a scan
past a fresh install's gate.

Flow inside the view: upload CV (blob + extracted text; non-PDF skips extraction) →
`facts.extract` pre-fills empty fields (same rule as ProfileEditor's "Generate from CV")
→ review all 18 keys, core ones marked required → Finish persists and flips to the
normal flow. The required-key list is one exported const so "salary is now required too"
is a one-line change. ProfileEditor remains the post-onboarding edit path; the field
rendering is shared, not duplicated.

### S — Per-tab application sessions

**Decision: sessions live in the panel, persisted to `chrome.storage.session`, keyed by
tabId.** (Alternative: background-service-worker-owned state — rejected: MV3 workers are
themselves ephemeral, so it duplicates the persistence problem and doubles the plumbing.)

State partition (exhaustive over App.tsx's 32 states + 7 refs):

| Per-session (persisted) | Per-session (in-flight, NOT persisted) | Panel-global |
|---|---|---|
| fields, resolutions, edits, `answers` map (S4), company + companyGuessed, jobText, snapshot, reuseOverrides, filledRefs, generatedRefs, epoch, site, startUrl, scan outcome (`lastOutcome`), unreachable, activeCaptcha, frameReports, election | scanning latch participation, generatingRefs, generateAll progress, acting, saving, picking, saveMsg, pendingRescan | check, hostError, gateOpen, tabId (active), windowId, facts, factsLoaded, resumeName, cvText, showEditor / view mode |

`companyGuessedRef` is per-session by name: as a panel-global it would let tab B's guess
overwrite tab A's user-typed company — the exact bug the ref exists to prevent.

Lifecycle:

| Event | Onboarding gate | Applied badge | Scan fires? | Session effect |
|---|---|---|---|---|
| Panel mount | checked first | checked second | only if both pass + host gate | rehydrate all, prune dead tabs |
| Tab switch → existing session | already passed | shown if flagged | no | swap display; flush previous |
| Tab switch → no session | already passed | checked | **no** (empty state; Scan click or navigation starts it) | create lazily |
| Same-site nav (top or elected frame) | — | — | yes (re-scan + re-project) | survives |
| Cross-site nav | — | — | on return only | **parked**, restored on domain return |
| Tab close / discard / mark applied | — | — | — | deleted |
| Scan click | passed | overridable | yes | current session |

Precedence: onboarding gate > applied badge > host gate (`gateOpen`) > scan.

Navigation signals come from `chrome.webNavigation.onCommitted`/`onHistoryStateUpdated`
(frameId + URL; permission already granted). A navigation of the top frame OR the
elected application frame is a wizard step; other subframes (ads, widgets) are ignored.
The URL for same-site classification comes from the event, not from `chrome.tabs.Tab`
(which may still hold the pre-nav URL).

Merge-over-navigation (S4) is label-keyed, never ref-keyed: refs die with each
enumeration, so the session carries answers as
`normalizeQuestion(label) → {value, provenance, fieldKey?}` and re-projects after
resolve. DOM assertions (what's filled, what's highlighted, the snapshot, the election)
describe a dead page and drop. This preserves paid generate drafts (their VALUES ride
the answers map) while making it impossible to attribute an old answer to a new field —
the invariant the epoch machinery has always protected.

Concurrency (S7): the scan latch stays global single-flight — tab switching must never
multiply paid `claude -p` resolves; background re-scan needs queue per-session. Epochs,
generation counters, and snapshot routing are per-session (`snapshotPush` routes by its
`m.tabId`, not the visible tab). Settling work writes to its own session or is dropped
if the session died.

Durability: debounced writes + flush on `pagehide`/`visibilitychange:hidden` and on
every tab switch (a debounce alone would lose the newest edits exactly when the panel
closes — the work the feature exists to protect). `version: 1` on the shape; mismatched
or corrupt rows drop to fresh state, never crash. Options capped at 100/field in the
persisted form; quota errors evict the oldest parked session, never the active one.
Storage keys `jff:session:<tabId>` get their own exported regex; the two existing
`storage.session.get(null)` call sites (`App.tsx:279`, `:660`) filter by
`SNAPSHOT_KEY_RE` and stay correct — the invariant "no code path treats an unrecognized
row as a snapshot" is now stated, not lucky.

Multi-window: the panel binds to its own window (`chrome.windows.getCurrent` at mount)
and ignores `tabs.onActivated` events from other windows. A tab lives in exactly one
window, so tabId-keyed storage rows have a single writer.

### A — Applied jobs

**Decision: record + revisit badge + list; detect-and-confirm, manual button as
fallback.** (Alternatives: manual-only — user must remember; fully automatic — false
positives write wrong records; full status-tracker CRM — YAGNI.)

- URL identity: raw URLs disagree between ATSes — the Ashby job's identity IS its query
  param (`?ashby_jid=…`), Greenhouse's is the path with `gh_src`/`utm_*` as tracking
  noise. `canonicalUrl()` (A1) resolves this; the raw URL is stored alongside for
  display/debugging. `applied.mark` uses the session's captured START URL (wizard page
  2's URL is not the posting); `applied.check` canonicalizes the just-scanned page URL.
- Re-applying through "Scan anyway" and re-marking keeps the ORIGINAL `marked_at`.
- Detection is only ever a prompt (A3), bilingual per the project's en/pt support.
- List view is read-only v1. The panel grows a three-view navigation model (session /
  profile / applications) — `showEditor`'s two-mode toggle generalizes.
- The TRM/Ashby job is seeded (A6) so the record reflects reality.

### C — Greenhouse combobox

Bug, not a feature. C1 runs as a spike BEFORE plan authoring (the plan cannot specify
C2 without the root cause; live DOM inspection of the Degree widget vs `fillCombobox`'s
assumptions — role/aria attributes, listbox mount location, commit behavior). C2 keeps
the Ashby arm's invariants (session-7 combobox e2e fixtures stay green); C3 adds a
Greenhouse-shaped fixture.

## Error handling

- Onboarding: `facts.extract` failure is non-fatal — fields stay empty, user types
  them. Resume-extraction failure follows the existing silent-degradation rule (blob
  stored, no cvText). Host down → `unknown` completeness → normal panel + banner; the
  gate can only ever be shown by a SUCCESSFUL load proving incompleteness.
- Sessions: corrupt/version-mismatched stored rows are dropped (fresh state), never
  crash the panel. Storage write failures degrade to in-memory behavior (today's status
  quo). Quota errors evict oldest parked session.
- Applied: `applied.mark` failure surfaces the standard host-error copy and does NOT
  end the session (retryable). `applied.check` failure → proceed as not-applied.
- Detection prompt: dismissible; dismissing never re-prompts for the same page load.

## Testing

- Unit: completeness tri-state truth table (incl. load-failure → unknown);
  OnboardingView (upload → prefill → required gating → finish; non-PDF path); session
  (de)serialization, version drop, prune, key-regex disjointness from
  `SNAPSHOT_KEY_RE`; tab-switch swap incl. window filtering; same-site vs cross-site
  classification; parking + domain-return restore; label-keyed re-projection (the S4
  acceptance test); snapshotPush routing to a background session; global scan
  single-flight with per-session queued rescan; `canonicalUrl()` table (Ashby vs
  Greenhouse cases); applied repos/handlers; detection heuristic (fields-vanished,
  en+pt patterns, no false positive on ordinary step pages); revisit-badge gating and
  precedence; combobox fix regression at the unit level.
- S8 runs as ONE batch before the S slices: the old clear-on-activate assertions and
  `data-jff-resets`/`data-jff-scans` hooks are rewritten to session semantics (standing
  rule: stale tests are a pre-Task-1 batch, not serial surprises).
- E2E (fixtures): the cross-cutting flows in the TODO; Greenhouse-widget fixture (C3).
- Live manual gate on the real Greenhouse page (final TODO) — the project's proven
  pattern for DOM-behavior truth.
- Full `npm run verify` on an idle machine (see flake memory); plain dist restored
  after.

## Out of scope

- Session survival across browser restarts (explicitly decided against — staleness
  risk).
- Applied-status pipeline (interview/offer/rejected), notes, editing the list.
- Making more fields required at onboarding (the const makes this a one-liner later).
- The session-7 deferred findings (#5–#18) and the foundation-harness hardening —
  still queued for the retro/follow-up spec, not this batch.
- Full public-suffix-list handling for site comparison.
- A real job-title extractor (`tab.title` is the v1 source; a dedicated extractor
  would be new scope with its own acceptance test).

## Execution

Pipeline: C1 spike → plan (architect; O/A slices ordered BEFORE S slices) → dual plan
review (fresh Opus + codex) → implement ladder → dual branch review → live manual gate
on the Greenhouse page. The S slices rewrite the panel's core state machine
(concurrency + data integrity over 850+ lines): their branch review runs at effort
**xhigh**, and the plan review pays specific attention to the three silent-wrong-data
surfaces — S4 merge keying, S7 single-flight + push routing, and the per-session
company provenance.

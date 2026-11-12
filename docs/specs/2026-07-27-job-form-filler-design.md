# job-form-filler — design spec

Date: 2026-07-27
Status: approved (brainstorm complete; fresh-context Opus review applied 2026-07-27)

## What this is

A Chrome extension (MV3) + local native-messaging host that helps Kevin fill job
application forms on any platform — Greenhouse, Lever, Workday, Gupy, custom career
pages — including custom free-text questions. Personal tool (single user, sideloaded);
no API costs: all LLM work runs through the local `claude -p` CLI under the existing
subscription.

**Core bet:** instead of per-ATS adapters, one generic DOM engine plus a learning loop.
Every application grows a local answers database, so each future application is filled
more completely and more deterministically than the last.

Design DNA ported from the author's earlier `job-finder` project (Electron app, same
problem domain): answer-bank schema, anti-fabrication fill invariants, baseline
label→key regex recognizers, learned-mapping promotion, DOM enumeration for React
widgets, EEO/CAPTCHA safety rules. Security posture (job postings are untrusted input)
from the author's `ai-job-search` project.

## Decisions made during brainstorm

| Question | Decision |
| --- | --- |
| Relationship to job-finder | Fresh standalone codebase; port designs, not code wholesale |
| Audience | Kevin only (v1); no multi-user/Web-Store concerns |
| LLM access | `claude -p` via Chrome native messaging host — no API key, no daemon |
| Platform strategy | Generic engine for any form; **no per-platform adapters in v1** |
| Fill flow | Click-to-fill + side-panel review; never auto-submits |
| Architecture | Thin extension, smart host: extension scrapes/fills DOM; host owns matching logic, SQLite DB, `claude -p` |

## Components

All TypeScript.

1. **Content script** — injected on demand via
   `chrome.scripting.executeScript({target: {tabId, allFrames: true}})` when the user
   hits Scan (not statically on every page). Once injected it stays alive on the page
   through submit.
   - **Enumerator**: harvest form fields — label, input type, select/radio options,
     ARIA comboboxes (`role="combobox"`/`role="option"`), radio groups coalesced into
     one logical field with option labels. Ported from job-finder's
     `src/main/apply/domEnumerator.ts`. Pierces **open** shadow roots (plain
     `querySelectorAll` won't see them; custom career pages use them); closed shadow
     roots are a known v1 gap, surfaced in the panel as "N unreachable widgets".
   - **Filler**: per widget type — native value setter + bubbling `input`/`change`
     events for text/textarea; real `.click()` for ARIA comboboxes, radio groups, and
     custom listboxes (React-controlled widgets need real events, not value
     assignment); direct `.value` + `change` for native `<select>`; `DataTransfer` for
     the resume file input. Known limitation: `el.click()` yields `isTrusted: false`,
     which rare hardened widgets reject — those fields fall to needs-input.
   - **Job-post capture**: learned selector for this hostname → heuristics →
     user fallback (see pipeline).
   - **Element picker**: when job text isn't found, user clicks the element that holds
     it; the selector is saved per-hostname for future scans.
   - **Submit snapshot**: capture-phase `submit` + `beforeunload` listeners snapshot
     every enumerated field's live value and push it to the host before page teardown.
     This is what makes "Save answers" able to see what the user typed directly on the
     page.

2. **Side panel** (Chrome side panel API) — the extension's brain stem, not just UI.
   - **Owns the `chrome.runtime.connectNative` port.** A panel is a normal document
     that stays alive while open, so long `claude -p` calls survive. (An MV3 service
     worker is torn down after ~30s idle, killing the port and the host with it —
     that's why the port does NOT live in the service worker.) Single port also means
     a single host process, so no concurrent SQLite writers.
   - Review surface grouping every field:
     - **Filled** — value + source badge (profile / saved answer / AI).
     - **Proposed** — LLM- or fuzzy-matched values awaiting one-click accept
       (see confidence tiers).
     - **Needs input** — each with a [Generate with AI] button.
     - **Skipped** — EEO/demographic, never auto-filled.
   - Inline editing; explicit **Scan / Re-scan** button (auto-scan on panel open);
     manual paste box for job description (always-works fallback); "Save answers"
     action.
   - **Resume manager**: one-time `<input type="file">`; the file is stored as a Blob
     in IndexedDB (extension-side) and handed straight to the content script. The
     resume never crosses native messaging.
   - **Host self-check** on connect: shows node/claude/auth status before first fill.
   - **Tab-scoped**: the panel binds to the tab it was opened for and resets on
     `tabs.onActivated` / `onUpdated` (navigation), so wizard steps never show stale
     fields from another page.

3. **Service worker** — minimal: opens the side panel on action click
   (`chrome.action.onClicked` → `sidePanel.open({tabId})`, with
   `openPanelOnActionClick` disabled since it would suppress `onClicked`) and relays
   messages between panel and content scripts. Holds no state, no port, no logic.

4. **Native host** (Node + better-sqlite3, launched on demand by Chrome). Owns the
   matching engine, the SQLite database (WAL mode; the panel's single port is the
   only client), and the `claude -p` runner with JSON-schema-validated output.

### Manifest and permissions

- `permissions`: `nativeMessaging`, `sidePanel`, `storage`, `scripting`, `tabs`.
- `host_permissions`: `<all_urls>` — required because embedded ATS forms are
  cross-origin iframes, which `activeTab` deliberately excludes. Injection is still
  on-demand (Scan button), so nothing runs on pages Kevin doesn't scan.
- `key` pinned in `manifest.json` so the unpacked extension ID is stable — native
  messaging `allowed_origins` cannot wildcard and breaks if the ID drifts.

### Native host protocol (hard rules)

- Chrome's stdio framing (4-byte little-endian length prefix + JSON) is the only
  thing ever written to stdout. **All logging goes to stderr or a file** — one stray
  `console.log` corrupts the channel irrecoverably.
- The host executable registered with Chrome is a **wrapper shell script** exporting
  an explicit PATH / invoking absolute paths to `node` and the host entry point.
  Chrome launches hosts with a GUI environment: no shell profile, no nvm/Homebrew
  PATH. The `claude` binary path is a config value, verified by the self-check.
- The spawned `claude` child uses `stdio: ['ignore', 'pipe', 'pipe']` and receives
  the prompt via `-p` argv, never stdin (inherited pipes stall `claude -p` — lesson
  from job-finder `claudeCli.ts`).
- Every request carries a `requestId`; host responses are idempotent per id so a
  dropped connection can re-fetch rather than re-run.
- **Message size**: host→extension is hard-capped at 1 MB per message
  (extension→host is 64 MiB). Any potentially large host response (Q&A dumps,
  history) uses a `{page, done}` chunking convention. The resume never crosses this
  channel at all.
- Install script: writes the native-messaging manifest to
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` with the pinned
  extension ID and marks the wrapper executable.

### Field identity protocol

A "field" is addressed by `{frameId, fid, epoch}`:

- The enumerator stamps each element with `data-jff-fid` (per-frame counter) and
  reports `frameId` (multiple content-script instances exist under `allFrames`).
- Each enumeration pass increments `epoch`. Every panel/host/content-script message
  about a field carries the triple; a message with a stale `epoch` is rejected and
  forces a re-scan. Wizard steps and post-resume re-enumeration are therefore safe:
  old handles can't touch new DOM.

## Fill pipeline

```
open panel → Scan (auto on open)
  → content script enumerates fields + captures job post text
  → if job post text not found: user pastes it manually OR clicks the element
    where it lives (element picker); picked selector saved per-hostname in DB
    so future scans on that host find it automatically
  → PHASE 1 — resume: fill the file input first, wait for the ATS's async
    resume auto-parse to settle (MutationObserver + debounce), then
    RE-ENUMERATE; ATS-populated values are treated as already-filled, not blank
    (job-finder lesson: fill resume first or the auto-parse clobbers your values)
  → PHASE 2 — host resolves each remaining field through a waterfall:
      1. deterministic recognizers  (regex label→key: name, email, phone,
         linkedin, salary, notice, work auth… ported from job-finder's
         BASELINE_RECOGNIZERS) + learned label→key mappings
      2. saved-answer lookup: exact normalized question match (language-aware)
      3. one batched claude -p call for whatever's left → maps each label to a
         known key, a reusable saved answer (candidates = stored Q&A for the
         matching language, all of them — no index needed at personal scale),
         or "custom question"
      4. still unresolved → needs-input
  → confidence tiers decide what lands on the page:
      AUTO-FILL   tier-1 recognizers + tier-2 exact matches
      PROPOSED    tier-3 LLM/fuzzy results → panel shows value, one click to fill
      NEEDS-INPUT tier 4, plus any known_key that has no stored value yet
  → for each needs-input: [Generate] → claude -p gets question + job
    description + profile summary → draft → user edits → fill
  → USER clicks submit on the page (extension never submits); the content
    script's submit/beforeunload snapshot captures final on-page values
  → "Save answers" (before or after submit — snapshot makes both work):
    diff {engine-filled, panel-edited, on-page snapshot} → new/edited Q&A
    pairs land in SQLite, tagged reusable or company-specific
  → next application starts with a bigger memory
```

Multi-step wizards (Workday-style): re-run the loop per step — Re-scan after DOM
changes; stale-epoch protection guarantees old handles die.

**Anti-fabrication invariant** (ported from job-finder `fillLlm.ts`, enforced in code,
not trusted to the model): for factual fields the LLM only ever picks *which* stored
value applies — the value itself is substituted from the database, never
model-authored. Structural validation on every mapping response: a `known_key` outside
the closed key set or a `reuse_answer(id)` outside the candidate ids sent is rejected
→ needs-input. Only subjective free-text (the [Generate] flow) is LLM-written, and it
always passes through the user's hands before filling.

**Company-specificity guard**: every saved answer is tagged `reusable` or
`company_specific` at save time (panel suggests, user confirms). `company_specific`
answers ("Why Figma?") never auto-fill or propose verbatim — they only seed the
[Generate] draft as reference material.

## Data model (SQLite, one file on disk)

- **`profile`** — identity facts: name, email, phone, location, links
  (linkedin/github/portfolio). Hand-filled once in the panel (~15 fields; no CV-parse
  seeding — not worth a third prompt shape for one user), editable anytime.
- **`answer_bank`** — structured factual answers, keys modeled on job-finder's
  `AnswerBankSchema`: work auth, sponsorship, relocation, salary expectation, notice
  period, earliest start, remote preference, pronouns.
- **`qa_memory`** — the growing part: `(question_normalized, question_raw, answer,
  language, reusability [reusable|company_specific], times_used, last_used_at,
  source_url)`. EN and PT-BR answers both live here; language is part of the lookup.
  No FTS index in v1 — at personal scale, all rows fit in the mapping prompt.
- **`learned_mappings`** — label text → answer-bank key, promoted to deterministic
  after the user confirms an LLM mapping once.
- **`learned_selectors`** — `(hostname, purpose, selector)`; v1 purpose:
  `job_description`. Extensible (e.g. learned apply-form containers).
- **`applications`** — minimal submission history: URL, company, date, counts of
  filled/generated fields. One insert per "Save answers"; nothing else depends on it.

## `claude -p` usage

Two prompt shapes, both returning JSON validated against a schema. Invalid output →
one retry → fail closed to needs-input.

1. **Mapping call** (one per fill, batched): input = all unresolved
   `{label, type, options}` + the closed list of known keys + stored Q&A candidates
   (language-matched). Output per field: `known_key` | `reuse_answer(id)` | `custom`.
   Never returns values for factual fields — values come from the DB, and out-of-set
   keys/ids are structurally rejected.
2. **Generation call** (one per [Generate] click): input = question + job description +
   compact profile/CV summary + voice rules (honesty-first: may only claim facts
   present in the profile summary; no invented experience; no spaced em-dashes).
   Output: a draft answer.

**All page-derived strings are untrusted** — not just the job post: field labels and
option text come from the same page. Both prompt shapes fence every page-derived
string in delimiters with length caps, and instruct that fenced content is context,
never instructions (posture from ai-job-search `SECURITY.md`). The structural output
validation above is the enforcement backstop.

### Error taxonomy (ported from job-finder `claudeCli.ts`)

Classified host-side, rendered distinctly in the panel — these are silent-failure
modes under a subscription if left generic:

| kind | panel message |
| --- | --- |
| `not_installed` | "claude CLI not found — check host config path" |
| `not_authed` | "claude CLI not logged in — run `claude` once in a terminal" |
| `rate_limit` | "subscription rate limit — retry later; fields left as needs-input" |
| `timeout` / `process` | "claude call failed — retry or fill manually" (transient, one auto-retry) |
| `invalid_output` | fail closed to needs-input after one retry |
| host unreachable | self-check banner: reinstall instructions |

## Safety rails

- Never auto-submits. No exceptions, no flag.
- EEO/demographic detection rule: walk up from the field to the nearest `fieldset`,
  `section`, or `[role="group"]` ancestor, capped at 5 levels, hard-stop at the
  `<form>` element, **never** consult `document.body` — checking body-level headings
  is exactly the page-global taint bug job-finder documented.
- Active CAPTCHA challenge → panel flags it, extension does nothing. Passive
  reCAPTCHA badges (present on ~every Greenhouse form) are ignored, not treated as
  blocks.
- Everything local: SQLite + resume Blob on disk, `claude -p` under the subscription.
  No telemetry, no server, no remote storage.

## Testing

- **Host logic** (waterfall, DB, prompt building, schema validation, error taxonomy)
  is plain Node — unit tests without Chrome.
- **Enumerator/filler** tested against captured real-form HTML fixtures — start with
  job-finder's `e2e/fixtures/greenhouse-apply/` (Figma/Gusto/Lyft forms), grow the
  set from forms encountered in real use.
- **Live smoke** = applying to a real job with the panel open (which is also just
  using the tool). Lesson from job-finder: fixture-green is not live-green — SPA
  forms only truly validate against the live page.

## Out of scope (v1)

- Per-ATS adapters (Greenhouse Questions API, Lever specifics) — the generic engine
  plus learning is the bet; adapters can be added later if a platform resists.
- Auto-submit of any kind.
- LinkedIn Easy Apply (authenticated + ToS-sensitive; revisit with human-in-the-loop
  rules if ever).
- Multi-user support, Web Store packaging, key management.
- CV-parse profile seeding (hand-fill wins at n=1).
- FTS/semantic answer indexing — revisit when `qa_memory` outgrows the prompt window.
- Closed shadow roots (surfaced as unreachable, not filled).

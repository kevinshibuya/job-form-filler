# job-form-filler — design spec

Date: 2026-07-27
Status: approved (brainstorm complete)

## What this is

A Chrome extension (MV3) + local native-messaging host that helps Kevin fill job
application forms on any platform — Greenhouse, Lever, Workday, Gupy, custom career
pages — including custom free-text questions. Personal tool (single user, sideloaded);
no API costs: all LLM work runs through the local `claude -p` CLI under the existing
subscription.

**Core bet:** instead of per-ATS adapters, one generic DOM engine plus a learning loop.
Every application grows a local answers database, so each future application is filled
more completely and more deterministically than the last.

Design DNA ported from `~/keki/dev/personal_projects/job-finder` (Electron app, same
problem domain): answer-bank schema, anti-fabrication fill invariants, baseline
label→key regex recognizers, learned-mapping promotion, DOM enumeration for React
widgets, EEO/CAPTCHA safety rules. Security posture (job postings are untrusted input)
from `~/keki/dev/personal_projects/ai-job-search`.

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

1. **Content script** (`all_frames: true` so embedded ATS iframes work).
   - **Enumerator**: harvest form fields — label, input type, select/radio options,
     ARIA comboboxes (`role="combobox"`/`role="option"`), radio groups coalesced into
     one logical field with option labels. Ported from job-finder's
     `src/main/apply/domEnumerator.ts`.
   - **Filler**: set values so SPAs register them — real `.click()` for React-controlled
     widgets (programmatic `.fill()` does not fire React `onChange`), native value
     setters + `input`/`change` events for text inputs, `DataTransfer` for the resume
     file input.
   - **Job-post capture**: extract job description text from the page (learned selector
     → heuristics → fallback below).
   - **Element picker**: when job text isn't found, user can click the element that
     holds it; the selector is saved per-hostname for future scans.
2. **Side panel** (Chrome side panel API). Review surface grouping every field:
   - **Filled** — value + source badge (profile / saved answer / AI).
   - **Needs input** — each with a [Generate with AI] button.
   - **Skipped** — EEO/demographic, never auto-filled.
   - Inline editing; "Save answers" action after the user submits on the page.
   - Manual paste box for job description (always-works fallback).
3. **Service worker** — message router between content script ↔ panel ↔ native host.
   No logic.
4. **Native host** (Node + better-sqlite3; registered native-messaging host script,
   launched on demand by Chrome). Owns the matching engine, the SQLite database, and
   the `claude -p` runner with JSON-schema-validated output.

## Fill pipeline

```
click extension
  → content script enumerates fields + captures job post text
  → if job post text not found: user pastes it manually OR clicks the element
    where it lives (element picker); picked selector saved per-hostname in DB
    so future scans on that host find it automatically
  → host resolves each field through a waterfall:
      1. deterministic recognizers  (regex label→key: name, email, phone,
         linkedin, salary, notice, work auth… ported from job-finder's
         BASELINE_RECOGNIZERS)
      2. saved-answer lookup        (normalized question text, then FTS5
         fuzzy match against qa_memory)
      3. one batched claude -p call for whatever's left → maps each label
         to a known key, a reusable saved answer, or "custom question"
      4. still unresolved → needs-input
  → extension fills the confident ones; panel shows all of it
  → for each needs-input: [Generate] → claude -p gets question + job
    description + profile summary → draft → user edits → fill
  → USER clicks submit on the page (extension never submits)
  → "Save answers" → new/edited Q&A pairs land in SQLite
  → next application starts with a bigger memory
```

Multi-step wizards (Workday-style): re-run the same loop per step — the content script
re-enumerates after DOM changes and the user clicks fill again.

**Anti-fabrication invariant** (ported from job-finder `fillLlm.ts`): for factual
fields the LLM only ever picks *which* stored value applies — the value itself is
substituted from the database, never model-authored. Only subjective free-text (the
[Generate] flow) is LLM-written, and it always passes through the user's hands before
filling.

## Data model (SQLite, one file on disk)

- **`profile`** — identity facts: name, email, phone, location, links
  (linkedin/github/portfolio). Seeded once from the canonical CV (a `claude -p` parse
  of `~/keki/cv-rebuild/cv.html`), editable in the panel.
- **`answer_bank`** — structured factual answers, keys modeled on job-finder's
  `AnswerBankSchema`: work auth, sponsorship, relocation, salary expectation, notice
  period, earliest start, remote preference, pronouns.
- **`qa_memory`** — the growing part:
  `(question_normalized, question_raw, answer, language, times_used, last_used_at,
  source_url)`. FTS5 index for fuzzy lookup. EN and PT-BR answers both live here,
  tagged by language.
- **`learned_mappings`** — label text → answer-bank key, promoted to deterministic
  after the user confirms an LLM mapping once.
- **`learned_selectors`** — `(hostname, purpose, selector)`; v1 purpose:
  `job_description`. Extensible (e.g. learned apply-form containers).
- **`applications`** — light log: URL, company, date, which fields were
  filled/generated. Powers "Save answers" (knows what changed) and doubles as a
  submission history.

## `claude -p` usage

Two prompt shapes, both returning JSON validated against a schema. Invalid output →
one retry → fail closed to needs-input.

1. **Mapping call** (one per fill, batched): input = all unresolved
   `{label, type, options}` + the list of known keys + top FTS5 candidate questions
   from `qa_memory`. Output per field: `known_key` | `reuse_answer(id)` | `custom`.
   Never returns values for factual fields — values come from the DB.
2. **Generation call** (one per [Generate] click): input = question + job description +
   compact profile/CV summary + voice rules (honesty-first: may only claim facts
   present in the profile summary; no invented experience; no spaced em-dashes).
   Output: a draft answer.

Job post text is **untrusted input**: prompts fence it in delimiters and instruct that
it is context, never instructions (posture from ai-job-search `SECURITY.md`).

## Safety rails

- Never auto-submits. No exceptions, no flag.
- EEO/demographic sections detected and always left to the user; detection is scoped
  to the containing section (job-finder had a documented bug where page-global "EEO"
  text tainted unrelated fields — avoid).
- Active CAPTCHA challenge → panel flags it, extension does nothing. Passive
  reCAPTCHA badges (present on ~every Greenhouse form) are ignored, not treated as
  blocks.
- Everything local: SQLite + resume file on disk, `claude -p` under the subscription.
  No telemetry, no server, no remote storage.

## Testing

- **Host logic** (waterfall, DB, prompt building, schema validation) is plain Node —
  unit tests without Chrome.
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
- Semantic/embedding answer matching — FTS5 + LLM candidate selection is v1's fuzzy
  layer.

# Scan observability and async busy states — design

Date: 2026-07-28. Status: approved (brainstormed interactively; decisions recorded below).

## Why

The Task 23 manual handshake surfaced a defect class, not a single bug: on
https://www.trmlabs.com/careers?ashby_jid=… the user clicked Scan and "nothing happened" for
minutes. Evidence (host `request_log`) showed three complete scan cycles, each finishing in ~20ms
with `fields: []` — the panel scanned, found nothing, told nobody, and called nobody. Every failure
layer on the content-script leg is silent by design today:

- `inject()` relay failure → swallowed into `[]` (`App.tsx` inject wrapper).
- Broadcast relay failure → swallowed into `[]` (`sendToTab`).
- Per-frame `tabs.sendMessage` failures → silently skipped (`background.ts` broadcast loop).
- Per-frame `bad_scan` / `bad_message` replies → silently dropped (`scan.ts` enumerateAllFrames).
- A 0-field scan → renders nothing at all in the panel.
- A slow `resolve` (`claude -p` allows 240s ×2 attempts) → no in-progress indication.

Reproduction against the real page (Playwright, built extension) also proved a transient miss:
right after the Ashby iframe navigates to its `/application` view,
`chrome.scripting.executeScript({allFrames: true})` can skip that frame once, silently. A repeat
enumeration recovers. The user's persistent 0-field result on their Chrome remains unexplained —
this slice's diagnostics are the instrument that will identify it on the next manual run.

## Decisions (user-approved)

1. Feedback UI: one status line under the action row + spinner/disabled on the Scan button.
   Not banners, not a per-phase checklist.
2. 0-field scans: auto-retry the enumeration once (~1.5s delay), then show the empty state.
   `resolve` is never called with zero fields.
3. Failures: human-readable status line + collapsible details disclosure with raw per-frame
   evidence.
4. Scope: all async buttons get busy states (Scan, Save answers, Pick job description, per-row
   Accept/Fill). Generate already has one.

## Design

### 1. Progress reporting from `runScan`

`ScanDeps` gains `onProgress(p: ScanProgress): void`. `runScan` emits at each step:

```ts
type ScanProgress =
  | { phase: 'injecting' }
  | { phase: 'enumerating'; frames: number }        // also emitted for the resume re-enumeration
  | { phase: 'retrying' }                            // 0-field auto-retry in flight
  | { phase: 'resolving'; fields: number }           // host resolve call started
```

Terminal outcomes are NOT progress events; the panel derives them from the returned
`ScanOutcome` / thrown error. `onProgress` is required in `ScanDeps` (no optional-callback drift);
tests pass a recorder. The phase sequence per scenario is unit-tested in `scan.test.ts`.

### 2. Loud failures

- The panel's `inject` wrapper and `sendToTab` THROW on a relay-level failure (`ok: false`
  response, or `chrome.runtime.sendMessage` rejection) with the relay's error string. `runScan`
  does not catch; `onScan` catches everything and renders the failed status.
- `background.ts` broadcast: per-frame send failures are recorded, not dropped. The broadcast
  response becomes `{ ok: true, replies, failures: [{ frameId, error }] }`. Frame discovery's
  no-op `executeScript` returns `location.href` instead of `true`, so every frame in
  `replies`/`failures` carries its URL for diagnostics. Reply shape stays
  backward-compatible (`replies` unchanged).
- `enumerateAllFrames` keeps per-frame results (frameId, url, fieldCount | error) instead of
  discarding non-ok payloads. `ScanOutcome` gains `frameReports` for the diagnostics panel.
- The 0-field auto-retry: after PHASE 0 enumeration only (not after the resume re-enumeration),
  if total fields === 0 → emit `retrying`, wait ~1.5s (injected sleep fn, fake-timer testable),
  then re-inject + re-enumerate once with a fresh epoch, re-emitting `injecting` and
  `enumerating` as it goes. Still 0 → return the empty outcome WITHOUT calling
  `selector.get`/`JFF_JOBTEXT`/`resolve`.

### 3. Status line + diagnostics (`ScanStatus.tsx`)

Rendered directly under the action row, always present once a scan has started. Carries
`data-jff-status="<state>"` for browser smokes. States and copy:

| state       | copy                                                                                   | tone    |
| ----------- | -------------------------------------------------------------------------------------- | ------- |
| `connecting`| Waiting for the local host…                                                             | neutral |
| `injecting` | Reaching into the page…                                                                 | neutral |
| `enumerating`| Scanning page (N frames)…                                                              | neutral |
| `retrying`  | No fields yet — looking again…                                                          | neutral |
| `resolving` | Matching N fields… (a Claude call can take a minute)                                    | neutral |
| `done`      | ✓ N filled, M proposed, K need input                                                    | green   |
| `empty`     | ⚠ Scanned N frames, found no form fields. Open the application form, then Scan again.   | amber   |
| `captcha`   | ⚠ CAPTCHA active — nothing was filled.                                                  | amber   |
| `failed`    | ✕ Scan failed: <human reason>                                                           | red     |
| `action_failed` | ✕ <human reason>                                                                    | red     |

`action_failed` is for NON-scan actions (Accept/Fill/Pick) hitting a relay or page failure — their
errors must be as loud as scan errors, but must not read as "Scan failed". `connecting` covers the
mount-to-selfCheck gap when the auto-scan is queued behind the host answer (the auto-scan effect
waits for the selfCheck to answer or fail before its first run; a manual Scan starts at
`injecting`). The existing "Checking the local host…" pending banner (`Banner.tsx`) stays; its copy is
untouched. `llmError` outcomes render `failed` here; the existing `hostError` banner behavior is
unchanged.

Below the line, a `<details data-jff-diagnostics>` disclosure ("details"), shown for `empty` and
`failed` (and `done` when any frame reported an error): one row per frame — URL (truncated),
field count or error string — plus the inject/broadcast error when that is what failed.

### 4. Busy states on every async action

- Scan button: label "Scanning…" + `disabled` while a scan runs. `scanningRef` stays as the
  synchronous re-entry guard; a `scanning` state drives the UI.
- Save answers: "Saving…" + disabled while the save round-trip runs; `saveMsg` behavior unchanged.
- Pick job description: "Picking… (click the description on the page)" + disabled until the pick
  settles (it always settles: click, Escape, or timeout).
- FieldRow: a per-row busy mechanism generalizing `generatingRef` — `acting: { ref: string;
  action: 'accept' | 'fill' } | null` in App, passed down as FieldRow's `acting` prop; Accept
  renders "Accepting…", Fill renders "Filling…", both disabled while their send is in flight.
  Generate keeps its existing spinner prop.
- Accept/Fill/Pick failures are NOT silent: `fillOne` goes through the throwing relay wrapper and
  checks the frame's reply; a failure surfaces as `action_failed` in the status line, and a failed
  Accept does not promote the row's tier (a failed Fill does not mark "on the page").
- Shared helper in `ui.ts` for the busy label/disabled pair to keep the pattern uniform.

### 5. Testing

- Unit (`scan.test.ts`): phase sequences for happy path, inject failure, broadcast failure,
  0-field retry-then-empty, 0-field retry-then-found, captcha; retry skips `resolve`; frameReports
  content. The 1.5s delay is an injected `sleep` dependency, stubbed instant in unit tests (the
  App-level empty-state test runs the real timer with a widened budget).
- Unit (`background`-level test if present, else via relay contract tests): broadcast failure
  recording, discovery URL passthrough.
- Unit (`App.test.tsx`): each status renders with the right `data-jff-status`; buttons disable
  while busy; diagnostics disclosure appears on `empty`/`failed`.
- Browser smoke (extend existing Playwright specs): `data-jff-status` reaches `done` on the
  fixture form; a fixture page with zero fields reaches `empty` after the retry.
- Mutation probes (handoff lesson): deleting the retry, the `failures` recording, or the
  throw-on-relay-failure must each fail at least one test in isolation.

## Out of scope

Broader UI restyling, per-phase timing display, polling until fields appear, host-side changes,
per-ATS adapters. The environment-specific cause of the user's 0-field scans is diagnosed WITH
this slice (next manual run), not fixed by it.

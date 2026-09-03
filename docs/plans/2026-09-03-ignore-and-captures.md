# Ignore and captures implementation plan

**Goal:** The user can hide a wrong row for the Session, one click saves a Capture the next ATS session can build on, and the two live Captures give the ATS modules their job description locators and Ashby its junk rule.
**Architecture:** `Session.ignoredRefs` and an Ignore button hide rows for the Session. A `JFF_CAPTURE` content message returns a structurally sanitised DOM, and a `capture.save` host method writes it with redacted scan evidence under a configured captures directory. The last task takes the two live Captures and fills the ATS modules' job description locators and the Ashby `dropField` rule from them, which is the evidence loop ADR 0007 asks for.
**Spec:** `docs/specs/2026-09-03-per-ats-architecture-design.md`, section C
**Execution model:** opus

## Global constraints

- TypeScript: never `any`. Typed test fakes included.
- Branch `ignore-and-captures`, created in Task 0 from `ats-identity-and-modules` (this plan consumes its `ats` field, `moduleFor` and the ATS modules). This plan is part of a four-plan linear stack: `profile-write-guard` → `panel-state` → `ats-identity-and-modules` → `ignore-and-captures`. Those four all edit `App.tsx` and each consumes the one before it, so the stack is what keeps them from colliding. `2026-09-03-serial-choice-fill.md` is **not** in the stack: it touches `fill.ts` only and runs in parallel from `ai-staging`. Open the PR against the parent branch `ats-identity-and-modules`, and retarget it to `ai-staging` once the parent merges. Never commit on `main`.
- Stack mechanics, so the retargets stay cheap: merge every stack PR with a **merge commit**, not a squash. Under a squash merge the child's three-dot diff re-shows the parent's whole change and the merge reapplies it, which forces a `git rebase --onto ai-staging <parent-tip>` first. And when a review of the parent produces fix commits, merge the parent forward into this branch **before** this PR's review is triggered, so the review reads the code that will actually land.
- Every `App.tsx:NNNN` citation in this plan is a line number as of `d90d6ed`. Earlier plans in the stack insert code above most of them, so re-find each site by the quoted anchor text rather than trusting the number.
- Run tests from the repo root: `npx vitest run <path>`. After any edit under `shared/src`, run `npm run build -w @jff/shared` before host or extension tests.
- Every task ends with `npm run typecheck` green before its commit.
- `npm run smoke` and `npm run verify` only on an idle machine; the last task restores the plain dist and proves it with `grep -rl 'jffFakeHost' extension/dist | wc -l` printing 0.
- Every `.md` written here passes the design-tells hook. Do not add a `design-tells: acknowledged` marker.
- A Capture never leaves the machine: the only writer is the Native host, the only destination is the configured `capturesDir`, which defaults to `<HOME_DIR>/captures` (`HOME_DIR` is `host/src/config.ts:22`). The directory is created `0700` and every file is written `0600`.
- **What a Capture keeps is structure, not content.** The redaction rule is in Task 2 and it is the load-bearing part of this plan: a Capture is taken from a real job application holding the user's real personal data, and an agent reads it afterwards. Anything the rule misses sits in plaintext on disk.
- Capture cap is exactly 2,000,000 characters of HTML, truncated with the trailing comment `<!-- jff: truncated -->`.
- Baseline at plan authoring, re-measured in Task 0: the unit count recorded at the end of `2026-09-03-ats-identity-and-modules.md`.

### Task 0: Branch and baseline

**Files:**
- none modified; nothing outside this list

**Interfaces:**
- Consumes: nothing
- Produces: branch `ignore-and-captures`, a recorded baseline under `## Progress`

**Work:** `git status` must be clean. Create the branch from `ats-identity-and-modules`. Run typecheck, lint and unit tests; record the counts.

**Acceptance check:** `git branch --show-current` prints `ignore-and-captures`; `npm run typecheck && npm run lint && npx vitest run` exit 0. Red state: the branch does not exist.

**Boundaries:** No source edits. If any test is red, stop and report `blocked: baseline red: <test>`.

- [ ] Create the branch
- [ ] Run typecheck, lint, unit; write the counts under `## Progress`; commit `docs(plan): ignore and captures, task 0 baseline`

### Task 1: Ignored field

**Files:**
- `extension/src/panel/sessions.ts` — modify: `Session.ignoredRefs: string[]`, default `[]` in `newSession`
- `extension/src/panel/sessions.test.ts` — modify: the default
- `extension/src/panel/App.tsx` — modify: `clearScanResults` (`App.tsx:124`) clears `ignoredRefs`; `onIgnore`, `onRestore`, the ignored line and its collapsed list; `generateEligible`, the batched fill list and Save answers read `main`, which already excludes ignored rows once `buildRows` does
- `extension/src/panel/FieldRow.tsx` — modify: `Ignore` button, new prop `onIgnore`
- `extension/src/panel/FieldRow.test.tsx` — modify: one case
- `extension/src/panel/group.ts` — modify: `buildRows(fields, resolutions, electedFrameId, ignoredRefs)` returns `{ main, foreign, ignored }`
- `extension/src/panel/group.test.ts` — modify: one case
- `extension/src/panel/App.test.tsx` — modify: add the two cases below

**Interfaces:**
- Consumes: `Row` (`extension/src/panel/group.ts:3`), `PanelRows` (`:26`), `buildRows` (`:41`), `refOf`
- Produces: `FieldRowProps.onIgnore: (ref: string) => void`; a `data-jff-ignore="1"` button labelled `Ignore` on every non-skipped row; `PanelRows.ignored: Row[]`; a `data-jff-ignored-line` element reading `<n> ignored · show` (toggle text `hide`), rendered only when n > 0, with a list of labels each carrying a `data-jff-restore="1"` button labelled `Restore`

**Work:** Ignoring writes the ref into `session.ignoredRefs` through `writeSession`; restoring removes it. `buildRows` filters ignored refs out of both `main` and `foreign` and returns them as `ignored` in field order. Save answers, Generate all and the batched fill all derive from `main` and need no separate filter: assert it rather than add one. Note `clearScanResults` lives in `App.tsx:124`, not in `sessions.ts`; it keeps `site` and `startUrl` and must now also drop `ignoredRefs`, because a ref only means something for the scan that produced it.

**Acceptance check:** `npx vitest run extension/src/panel/group.test.ts extension/src/panel/FieldRow.test.tsx extension/src/panel/sessions.test.ts extension/src/panel/App.test.tsx` exits 0 and `npm run typecheck` exits 0, with: `buildRows` moves an ignored ref to `ignored`; FieldRow renders the button; App: clicking Ignore on a row removes it from the list, shows `1 ignored · show`, and the `save` request sent after clicking Save answers omits it; clicking Restore brings it back. Red state: `Session` has no `ignoredRefs`.

**Boundaries:** Skipped (demographic) rows have no Ignore button. Nothing is persisted outside the Session.

- [ ] Session field and tests
- [ ] `buildRows` and FieldRow with tests
- [ ] App wiring, line, list, cases; typecheck; commit `feat(panel): Ignored field, per Session`

### Task 2: Capture

**Files:**
- `shared/src/messages.ts` — modify: `JFF_CAPTURE { epoch, secrets }` content message; host method `capture.save` with the params below; `CaptureSchema`
- `shared/src/messages.test.ts` — modify accordingly
- `extension/src/content/capture.ts` — create: `sanitizedHtml(root: Document, secrets: string[]): string`
- `extension/src/content/capture.test.ts` — create
- `extension/src/content/index.ts` — modify: `JFF_CAPTURE` branch under the epoch gate
- `extension/src/panel/capture.ts` — create: `redactForCapture(fields, resolutions)` returning copies with `currentValue: null` and `value: null`; `secretsOf(session, edits, facts, resumeName)` returning every value the panel holds
- `extension/src/panel/capture.test.ts` — create
- `host/src/config.ts` — modify: `HostConfig.capturesDir: string`, defaulting to `join(HOME_DIR, 'captures')` in `loadConfig`
- `host/src/config.test.ts` — modify: the default
- `host/src/captures.ts` — create: `writeCapture(dir, capture): string` (returns the path)
- `host/src/captures.test.ts` — create: writes under a temp dir
- `host/src/handlers.ts` — modify: `capture.save` case using `deps.config.capturesDir`
- `host/src/handlers.test.ts` — modify: one case with `config.capturesDir` set to a temp dir (the test builds `config` inline at `handlers.test.ts:35`)
- `extension/src/panel/App.tsx` — modify: `Save a capture` button next to Discard session; `onCapture`; the result line
- `extension/src/panel/App.test.tsx` — modify: one case

**Interfaces:**
- Consumes: `Session` fields `ats`, `startUrl`, `fields`, `resolutions`, `ignoredRefs`, `jobTextSource`, `election`, `frameReports`; the panel's `edits`; the tab hostname; `EnumFieldSchema` and `ResolutionSchema` (re-exported from `shared/src/messages.ts:7`)
- Produces:

  ```ts
  export const CaptureSchema = z.object({
    version: z.literal(1),
    takenAt: z.string(),          // ISO
    ats: AtsIdSchema,
    url: z.string(),
    hostname: z.string(),
    html: z.string(),
    fields: z.array(EnumFieldSchema),          // currentValue always null
    resolutions: z.array(ResolutionSchema),    // value always null
    ignoredRefs: z.array(z.string()),
    jobTextSource: z.enum(['pasted', 'ats', 'learned', 'heuristic', 'none']),
    election: z.object({ frameId: z.number().int(), score: z.number(), url: z.string().nullable() }).nullable(),
    frameReports: z.array(z.object({ frameId: z.number().int(), url: z.string().nullable(), fields: z.number().int().nullable(), error: z.string().nullable() })),
  })
  ```

  `capture.save` params are `CaptureSchema` without `takenAt` (the host stamps it) and the host additionally refuses, `bad_request`, any field with a non-null `currentValue` or resolution with a non-null `value` (defence in depth for the redaction). Result `{ path: string }`. File name `<yyyy-mm-dd-hhmmss>-<ats>-<hostname>.json`, hostname with every character outside `[a-z0-9.-]` replaced by `_`. Panel: `data-jff-capture="1"` button, disabled only when there is no Session or it is parked — a zero-field scan is exactly the state whose evidence this plan needs, so it must stay capturable; on success a `data-jff-capture-msg` line `Capture saved: <path>`; on failure the same line with the host error text.

**Work:** `sanitizedHtml` clones `document.documentElement`, then on the clone, in this order:

1. Removes every `script`, `style`, `noscript`, `svg`, `img`, `iframe` and `link`.
2. For every `input`: removes the `value` attribute and sets `.value = ''`; removes the `checked` attribute and sets `.checked = false`. A checked radio or checkbox **is** an answer, so leaving it is the same leak as leaving a typed value.
3. For every `textarea` sets `textContent = ''` and `.value = ''` (the text node is what `outerHTML` serialises); for every `[contenteditable]` sets `textContent = ''`; removes `selected` from every `option` and sets `.selected = false`.
4. Strips every attribute not on this allowlist, on every element: `id`, `class`, `name`, `type`, `role`, `for`, `placeholder`, `accept`, `required`, `disabled`, `multiple`, `hidden`, `tabindex`, `inputmode`, `pattern`, `autocomplete`, `data-jff-fid`, `data-testid`, `data-qa`, `data-automation-id`, and `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-expanded`, `aria-haspopup`, `aria-controls`, `aria-owns`, `aria-hidden`, `aria-activedescendant`, `aria-selected`, `aria-autocomplete`. This removes `href`, `src`, `title`, `style`, `value`, and every other `data-*` an ATS hangs its state on. An allowlist is used rather than a blocklist because the next ATS will invent an attribute nobody predicted.

   The list carries three jobs, not one. The locator work needs `id`, `class` and `role`. The three named `data-*` keys are the stable hooks on hashed-class sites, which Task 3 names Ashby as; the blanket strip would remove exactly the attribute the Ashby selector has to use. And `serial-choice-fill` Task 3 sends a defect-9 diagnosis to a Capture, which needs the widget attributes the fill path itself reads: `aria-owns` (`harvest.ts:36`), `aria-hidden` (`fill.ts:286`), and the combobox state attributes. None of them carries personal data.
5. Blanks the `secrets`. **This is the step that catches a committed choice.** `fill.ts:448-452` documents that a successful react-select commit leaves `input.value` empty and writes the chosen text into a visible container, so after a fill the answers to work authorization, sponsorship, degree and notice period are ordinary page text and steps 1 to 4 do not touch them.

   Equality alone fails open on a real page, so the comparison is: normalise both sides with `norm()` and compare case-insensitively; for a secret of 6 characters or more, blank any text node that **contains** it; below 6, require equality (so the answer `No` cannot eat the label `Notice period`). Attributes always use the contains rule, since they are short and `aria-label` carries composites like `Remove Bachelor's Degree` on a clear button. A matched text node is blanked whole rather than substring-replaced.

   Equality would miss all three of the common shapes: a page rendering `Kevin Shibuya` from a profile holding `firstName` and `lastName` separately; a react-select live region reading `option Bachelor's Degree, selected.`; and a file chip reading `kevin-shibuya-cv.pdf (120 KB)`. Case and prefix variants matter too, because the spec records that Resume extraction stores lowercased names and prefix-less URLs while the page holds what the user typed, so `github.com/x` never equals `https://github.com/x`.

   `secretsOf` must include **`resumeName`** (`App.tsx:200`). Greenhouse and Ashby both render the uploaded filename as page text, and a résumé filename is usually the user's own name. It is the single most likely personal string in a post-fill Capture and no other step touches it.

   One residual, stated rather than hidden: a dropdown the user commits **by hand** after the scan is in neither `edits` nor the snapshot (`snapshot.ts:9-15` reads `input.value`, which react-select leaves empty), so its text is not among the secrets and survives. Say so in the `capture.ts` comment. Also worth one comment there: `secrets` crosses into the content script, which runs in an isolated world, so the page itself cannot read the message.
6. Serialises `outerHTML`; truncates at the cap with the marker.

`secretsOf` gathers, deduplicated and trimmed: every value in the panel's `edits`, every non-null `resolution.value`, every value in the session snapshot, and every stored fact value the panel holds. The panel sends `JFF_CAPTURE` with `secrets` to the elected frame (fallback frame 0 when the election is null), runs `redactForCapture` on the session's fields and resolutions, and passes both with the reply's `html` to `capture.save`. The host creates the directory `0700` if missing, writes `0600`, and never overwrites: if the path exists, append `-2`, `-3`.

**Acceptance check:** `npm run build -w @jff/shared && npx vitest run extension/src/content/capture.test.ts extension/src/panel/capture.test.ts host/src/captures.test.ts host/src/config.test.ts host/src/handlers.test.ts extension/src/panel/App.test.tsx shared/src/messages.test.ts` exits 0 and `npm run typecheck` exits 0, with a fixture holding: an `input` with both a `value="attr-secret"` attribute and a divergent live `.value = 'live-secret'`; a **checked** checkbox; a `textarea` with markup text and a divergent live value; a `[contenteditable]` with text; a `script`; a selected `option`; an `<a href="mailto:someone@example.com" title="chrome-secret">`; a `<div data-state="tenant-secret">`; a `<div class="single-value">Bachelor's Degree</div>` standing for a committed react-select whose option text is passed in `secrets`; a composite text node `<p>Hello Kevin Shibuya, welcome back</p>` where `secrets` holds `Kevin` and `Shibuya` as separate facts; a file chip `<span>kevin-shibuya-cv.pdf (120 KB)</span>` where `secrets` holds `resumeName`; and an `<button aria-label="Remove Bachelor's Degree">`. It sanitises to HTML containing none of `attr-secret`, `live-secret`, either textarea text, the editable text, the script body, `selected`, `checked`, the mailto address, `chrome-secret`, `tenant-secret`, `Bachelor's Degree`, `Kevin Shibuya`, or `kevin-shibuya-cv.pdf` — the last three proving the contains rule, the composite node and the filename respectively. Also: a 2,100,000-character body truncates with the marker; `redactForCapture` nulls every `currentValue` and `value`; the host writes a parseable file that round-trips through `CaptureSchema`, refuses an unredacted payload, and the written file's mode is `0600`; the App case sends `capture.save` with the session's `ats`, `ignoredRefs`, and nulled values, and the button is enabled on a zero-field session. Red state: `JFF_CAPTURE` is not a message.

**Boundaries:** No upload, no clipboard. The Session is unchanged by a capture. `data-jff-fid` attributes stay in the HTML (they are field ids, not personal data, and they correlate with `fields`).

- [ ] Schema; rebuild
- [ ] Content sanitiser with tests; message branch
- [ ] Panel redaction and `secretsOf` with tests
- [ ] Config field, host writer and handler with tests
- [ ] Panel button and line with the case; typecheck; commit `feat: Capture — structurally sanitised DOM plus redacted scan evidence saved under the captures directory`

### Task 3: Live captures, the modules' locators, and the Ashby junk rule

**Files:**
- `extension/src/ats/fixtures/greenhouse-posting.ts` — create: distilled from the Greenhouse Capture
- `extension/src/ats/fixtures/ashby-posting.ts` — create: distilled from the Ashby Capture
- `extension/src/ats/greenhouse.ts` — modify: `jobTextSelector`
- `extension/src/ats/ashby.ts` — modify: `jobTextSelector`, and `dropField` if the Capture supports one
- `extension/src/ats/greenhouse.test.ts` — create
- `extension/src/ats/ashby.test.ts` — modify: the locator case, and the junk-rule case if there is a rule
- `docs/plans/2026-09-03-ignore-and-captures.md` — modify: Progress

**Interfaces:**
- Consumes: the two Capture files the user produces (below); `captureJobText` with `selectors`; `pickResumeTarget` and `scoreResumeField` (`extension/src/panel/resumeTarget.ts`)
- Produces: a non-null `jobTextSelector` in both modules, each proven by a fixture; an Ashby `dropField` written from observed DOM, or a recorded reason for leaving it `() => false`

**Work:** This task needs the user at the panel: reload the unpacked extension, open the Greenhouse posting and the Ashby **direct** posting URL (`jobs.ashbyhq.com/trm-labs/6edf242b-984d-41fb-8027-5f133a6353d4`, Application tab open; not the trmlabs.com wrapper, whose top document holds the posting text while the Capture holds the iframe), scan each, click `Save a capture` on each, and paste the two paths.

**Locators.** From each Capture's `html`, find the element holding the posting text: the smallest container whose sanitised text is at least 400 characters and holds the posting body and nothing of the site chrome. Prefer an id or a stable, non-hashed class; Ashby's class names are hashed, so fall back to a structural or attribute selector and say so in the module's comment. Distil the container plus its ancestors into a fixture file under 30 KB. The module test asserts `captureJobText(fixtureDoc, [{ source: 'ats', selector }])` returns `source: 'ats'` with text that contains a known phrase of the posting and none of a known chrome phrase.

**The Ashby junk rule.** `ats-identity-and-modules` deliberately shipped Ashby with `dropField: () => false`, because the rule it proposed (`kind === 'file' && !visible && label === null`) is unsafe without observed DOM: `keepField` (`extension/src/panel/junk.ts:26`) already drops a hidden unlabelled file input unless `scoreResumeField(f) > 0`, so any input that rule can still reach is one that scored as a résumé candidate, and Ashby's real résumé control is a dropzone over a hidden native input. Write the rule now, from the Capture, and only if the Capture shows a signal that separates the autofill-pane input from the résumé input: compare their `name`, `idAttr`, `accept` and `required`. The rule must key on that distinguishing signal, never on `label === null` alone. Add a fixture holding **both** inputs, and two assertions: `dropField` drops the autofill input, and `pickResumeTarget` over the kept fields still returns the résumé input. If the Capture shows no signal that separates them, leave `dropField: () => false`, record why under Progress, and let the generic scorer keep doing the work — a silently broken résumé upload is far worse than one extra row in the list.

If either Capture cannot be produced in the session, ship that module with `null` and no rule, record why under Progress, and continue.

**Acceptance check:** `npx vitest run extension/src/ats extension/src/panel/junk.test.ts` exits 0 with the locator case in both module tests, and, when a rule was written, the two-input Ashby fixture proving the résumé target survives it. Red state: both `jobTextSelector` are null.

**Boundaries:** Do not commit the raw Capture files; they hold the full page. Fixtures are distilled. Do not weaken `keepField` or the résumé scorer to make a rule fit.

- [ ] User produces the two Captures; paths recorded under Progress
- [ ] Distil fixtures; set the selectors; tests
- [ ] Ashby junk rule from the Capture, or a recorded reason not to; commit `feat(extension): Greenhouse and Ashby locators, and the Ashby junk rule, from live captures`

### Task 4: Gate and PR

**Files:**
- `docs/plans/2026-09-03-ignore-and-captures.md` — modify: Progress section only

**Interfaces:**
- Consumes: everything above
- Produces: PR `ignore-and-captures` into `ats-identity-and-modules`, a rundown for the user

**Work:** At idle, `npm run verify`, then `npm run build` and the plain-dist grep. Reload the unpacked extension. The rundown for the PR body: Ignore a row and see the count line, then Restore it; Save a capture on both pages and find the files under `~/.job-form-filler/captures/`, then `grep -c '<script' <file>` prints 0 and `grep -c '<own phone number>' <file>` prints 0; the job description line names the locator on both ATSes; **and, on Ashby, upload a résumé and confirm it still attaches** — the one regression a junk rule can cause.

**Acceptance check:** `npm run verify` exits 0; plain-dist grep prints 0; `gh pr view --json baseRefName` prints `ats-identity-and-modules`. Red state: no PR exists.

**Boundaries:** No merge. No changes outside the Progress section. Stop after opening the PR: the review is the user's to trigger.

- [ ] `uptime`, then `npm run verify`; record counts
- [ ] `npm run build`; plain-dist grep prints 0
- [ ] Push, open the PR with the rundown; commit `docs(plan): ignore and captures, task 4 gate`

## Progress

(filled in by execution)

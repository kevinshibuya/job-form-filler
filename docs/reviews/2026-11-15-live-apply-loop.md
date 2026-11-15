# Live apply loop and architecture review

**Date:** 2026-11-15
**Method:** the built extension, a real host process and the real profile (a copy
of the database) were driven by Playwright against live application pages. Each
page was scanned and filled, never submitted. A separate DOM read of every form
control was the yardstick for what the tool reported and filled.
**Scope of this file:** sanitised. Pages are named by provider and number; the
raw records, with real answers and URLs, stay outside the repo.

## What was run

20 pages were opened across Greenhouse (hosted and embedded in company sites),
Ashby, Lever, Workable, Recruitee, SmartRecruiters and two company career sites.
16 of them showed an application form: 341 fields in total. Two extra actions
were tested once each: accepting a proposal, and generating a draft.

| Provider | Pages | Fields | Ended filled | No label | No job text | No company | Median resolve |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Greenhouse | 7 | 145 | 47 (32%) | 1 | 0 | 0 | 10.4 s |
| Ashby | 3 | 43 | 15 (34%) | 4 | 0 | 3 | 6.6 s |
| Lever | 4 | 123 | 29 (23%) | 24 | 4 | 4 | 12.8 s |
| Recruitee | 1 | 17 | 6 (35%) | 0 | 0 | 1 | 9.7 s |
| Workable | 1 | 13 | 7 (53%) | 0 | 0 | 1 | 7.2 s |
| **All** | **16** | **341** | **104 (30%)** | **29** | **4** | **9** | **10.4 s** |

By tier, the host resolved 118 fields as automatic, 38 as proposed, 164 as needs
input and 21 as skipped.

## What works

- Name and email filled on all 16 form pages, and the phone on at least 12.
- The résumé was attached on all 16, across Greenhouse, Ashby, Lever, Workable
  and Recruitee. On Greenhouse this is read from the upload input being replaced
  by the file, confirmed directly on one page.
- Frame election found the form inside a cross-origin Greenhouse iframe on the
  company-site page that embeds one.
- A react-select dropdown fill was confirmed by screenshot, with the option
  committed and the menu closed.
- A posting page with no form produced the explicit "found no form fields"
  message.
- Most failed fills came back as "needs input" instead of "filled": 8 of the 10
  failures seen were reported honestly.
- The mapping step never invented a value. Every wrong proposal below is a stored
  value offered in the wrong place.

## Findings, by cost to the objective

The objective is in the README: stop retyping the same answers, and get a first
draft of the free-text ones. A 30% fill rate means the tool types the identity
block and leaves most of the form. The findings are ordered by how much of the
remaining 70% each one explains.

### 1. Choice questions are where the fill rate dies

Most unfilled fields are dropdowns, yes/no buttons and option groups. Three
causes stack up.

- **Stored facts are verbatim strings with no derived forms.** `workAuth` is
  stored as `true`. It filled Ashby's yes/no buttons but failed on all three
  Greenhouse Yes/No dropdowns that asked it. The stored location, a
  "city, state, country" string, was proposed for a Country dropdown on six
  pages and failed three city autocompletes. The phone has no country code, and
  on one page the phone-country dropdown was offered the phone number.
- **Greenhouse dropdowns report zero options at scan.** All 7 Greenhouse pages
  sent every combobox with an empty option list, so neither the host nor the
  model can choose. A long saved free-text answer was proposed for a Yes/No
  dropdown.
- **A failed Accept is silent.** Accepting the location proposal for a Country
  dropdown left the row as "proposed", with no message.

Cause in code: the eighteen Known keys in `shared/src/keys.ts` hold one string
each, and `host/src/resolve/waterfall.ts` passes that string through unchanged.

Direction: give facts a type and derived forms (country, city, region, phone in
international form, booleans that render as Yes or No in the form's language),
and match against the options once they are known. Options can be read by
opening the menu during the scan, or matched at fill time when they load.

### 2. Recognizers ignore the kind of control

`host/src/resolve/recognizers.ts` matches the label text alone.

- `/linkedin/` matched a "LinkedIn" checkbox, one option of "how did you hear
  about us". The row said "filled" with the profile URL; the checkbox stayed
  unchecked.
- `/e-?mail/` matched a marketing-consent checkbox whose text mentions email.
  The row said "filled" with the email address; the checkbox stayed unchecked.
- `/based in/` sent the location string to a yes/no question on two pages.

The first two are false "filled" claims, the defect class the per-ATS spec calls
the false commit. Both come from a text fact being written to a checkbox.

Direction: gate each recognizer by control kind, and make a checkbox fill report
success only when the box is checked.

### 3. Checkbox groups are not groups

Radio groups arrive as one field with its options. Checkbox groups do not: each
option becomes its own row, labelled with the option text, and the question is
lost. 48 of the 341 fields were such rows. A pronoun question alone produced up
to 11 rows on three Lever pages.

Cause in code: `extension/src/content/enumerate.ts` groups radios by name and
has no equivalent for checkboxes.

### 4. Lever custom questions have no labels

24 of the 123 Lever fields had no label at all, and 22 fields across providers
carried a placeholder or button text as their label ("Type your response",
"Attach", "Upload a file", "Replace file", "Uploading..."). On one Lever page 31
of 42 fields needed input, most of them unlabelled, so nothing downstream could
work. Labels are also polluted: a select's label included every option, and a
file input's label included the file name.

Cause in code: the label heuristics in `extension/src/content/dom.ts` do not
know Lever's question markup or Greenhouse's upload group.

### 5. Demographic questions slip through

15 of the 31 choice questions whose label names a demographic attribute were
not flagged: gender, race, Hispanic
or Latino, sexual orientation, disability and neurodivergence. Each was offered
"Generate with AI". On two pages a required consent checkbox was skipped as
demographic instead.

Cause in code: `isDemographic` in `extension/src/content/classify.ts` tests only
the headings of an enclosing fieldset, section or group. It never tests the
field's own label, and a heading that is a sibling of the fields is not seen.

### 6. Job description and company are missing on apply-only URLs

All four Lever pages sent an empty job description and no company. All three
Ashby pages sent no company, and one sent 778 characters of job text. A draft
written from there has no job to refer to.

Direction: per provider, read the posting from its own page or public API, and
take the company from the URL or the title.

### 7. Generation asserts personal facts

The one draft generated answered a question about accommodation needs with a
confident statement that none were needed. Nothing stored says so, and the row
showed no review warning. The mapping step is protected by its schema (ADR
0006); generation has no equivalent guard for a factual question.

Direction: decide whether a question asks for a fact or for prose before
drafting, and have the reviewer check every personal claim against the résumé
and the profile.

### 8. Junk rows

- Ashby's "autofill from résumé" upload appeared as an unlabelled file row on
  all three Ashby pages.
- Greenhouse's cover-letter input was offered the résumé file on three pages.
- Recruitee's hidden per-question file inputs produced five rows.
- On a company listing page with no form, the site's locale selector was
  reported as the only field, "1 already on page".

## Speed

Every scan waits on one model call. The `resolve` request took a median of
10.4 s (5.9 s to 26.2 s), and the recognizer fills, which need no model, come
back in the same response. So the name and email appear after ten seconds, not
at once.

Three observations:

- `resolveFields` runs the recognizers and the mapping call in one pass.
  Returning the deterministic results first would fill the identity block
  immediately, with proposals arriving after.
- The real database holds 0 learned mappings after 8 recorded applications, so
  every page pays for the model again on labels it has seen before.
- `host/src/llm/models.ts` names model ids that are older than the ones the
  project's own rule says it follows. The mapping model is also among the
  slowest in that table.

## Architecture

The layering is right: the content script owns the DOM, the panel orchestrates,
the host owns facts and models, and `shared` owns the schemas. Making fabrication
impossible in the mapping schema is the best decision in the codebase, and the
loop confirmed it holds.

The structure fights the objective in five places.

1. **The field model is too thin.** A field is a kind, a label and options.
   That loses the question behind a group, the options a dropdown loads later,
   and the section a field sits in. Findings 1, 3, 4 and 5 all start here.
2. **The fact model is too thin.** Eighteen string keys cannot answer a Country
   dropdown or a Yes/No dropdown. Finding 1 is mostly this.
3. **Resolution is one blocking pass.** See Speed.
4. **Site knowledge has no home.** The per-ATS spec is right about this, and the
   loop adds evidence: Lever, the worst provider at 23%, is not in its first
   cut, which names Greenhouse and Ashby.
5. **Nothing measures the real thing.** 866 unit tests and 17 browser tests run
   on three fixture sites and were green while every finding here was live. A
   probe like the one used for this review, plus fixtures captured from real
   pages through `scripts/sanitize-capture.mjs`, would turn the fill rate per
   provider into a number that can regress.

## The planned work, judged against the evidence

| Plan | Verdict |
| --- | --- |
| Profile write guard (PR #1) | Merge first. Finding 7 makes it more necessary: a draft that asserts facts must never reach the profile. The change is small and coherent: Save answers can only write saved answers, and a fact value is one line of at most 500 characters. |
| Panel state | Keep, lower priority. The status line's counts matched the rows on all 16 pages; the two false claims were row-level and come from finding 2. |
| Serial choice fill | Keep and widen. Commit checking is real, but the larger gap is choosing the right option at all (finding 1). |
| ATS identity and modules | Supported. Start with Lever labels and the job-description locators, and include Lever in the first cut. |
| Ignore and Captures | Captures first, paired with the sanitiser, because they feed the fixture corpus. Ignore is cosmetic next to the rest. |

Suggested order:

1. PR #1.
2. Kind-aware recognizers, checkbox grouping and a label-level demographic test.
   Small, generic, and they remove the false "filled" claims and 48 noise rows.
3. Two-phase resolve, so known facts fill at once.
4. Typed facts with option-aware choice resolution, merged with serial choice
   fill. This is the main lever on the fill rate.
5. ATS modules, starting with Lever labels and job-description locators.
6. A factual-question guard on generation.
7. The live probe as a committed tool with a per-provider scoreboard.

## Limits of this review

- Nothing was submitted, so submit snapshots, Mark applied and the save and
  recall loop across applications were not exercised.
- Sites that need an account were skipped, Workday among them. One multi-step
  flow was blocked by a bot wall in headless Chrome.
- The panel ran as a tab through the test seam, not as browser chrome.
- The yardstick cannot read Ashby's yes/no buttons, so those fills are taken
  from the panel's own report.
- One generation and one Accept are single samples.

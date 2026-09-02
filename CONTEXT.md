# Job form filler

A Chrome extension that reads a job application form, proposes values from the
user's own stored facts and past answers, drafts free-text answers with AI, and
fills the page on approval. It never submits.

## Language

### Postings

**Job posting**:
One advertised job the user is applying to, with its description text.
_Avoid_: job, job post, posting, job description (for the posting itself)

**Company**:
The employer behind a Job posting, guessed at Scan time and editable by the user.
_Avoid_: employer, org

**ATS**:
The applicant-tracking platform hosting the form, such as Greenhouse, Lever,
Workday, Gupy or Ashby, or a custom career page.
_Avoid_: platform, job board

**Canonical URL**:
The cleaned address that identifies a Job posting, so the same job reached by
two links counts once.
_Avoid_: URL, link, page address

### Scanning and resolving

**Scan**:
The round trip the user triggers on a page: Enumeration followed by Resolution
of every Field found.
_Avoid_: re-scan (a Scan repeated on the same page is still a Scan), auto-scan

**Enumeration**:
The reading pass inside a Scan that collects every Field on the page.
_Avoid_: scan (for the pass alone), crawl

**Field**:
One question on the form. A radio group is one Field.
_Avoid_: widget, row, input, question

**Control**:
The on-page element a Field is answered through: text box, dropdown, radio group,
file picker.
_Avoid_: widget, element, DOM node

**Combobox commit**:
A type-to-search dropdown accepting a choice, where the text the page settles on
may differ from what was typed.
_Avoid_: dropdown select, autocomplete pick

**Resolution**:
The decision of what Value, if any, a Field gets. Its outcomes are auto-fill,
proposed, needs input and skipped.
_Avoid_: waterfall, confidence tier, matching

**Needs input**:
A Resolution outcome: the Field could not be answered from stored data and is
left to the user, with Generation offered where the tool can reach the Control.
_Avoid_: needs-input, unresolved, unknown

**Skipped**:
A Resolution outcome: a Field the tool never fills, such as a demographic or
EEO question.
_Avoid_: ignored, excluded

**Mapping**:
The link between a Field's wording and a Known key or a Saved answer. A learned
mapping is one the tool remembers after the user confirms it.
_Avoid_: classification, matching

**Known key**:
One of the closed set of eighteen facts the tool may answer from, such as name,
email, work authorization, salary or notice period.
_Avoid_: field key, fact key, key

### Answers and drafting

**Profile**:
The user's identity and standing facts, edited in the panel and read from the
Resume.
_Avoid_: facts, CV facts, identity

**Resume**:
The CV file the user uploads once, attached to forms and read as text for
context.
_Avoid_: CV

**Answer bank**:
The store of standing factual answers: work authorization, sponsorship,
relocation, salary, notice, start date, remote preference, pronouns.
_Avoid_: facts, standing answers

**Saved answer**:
A past question-and-answer pair kept for reuse, tagged reusable or
company-specific.
_Avoid_: answer, stored answer, Q&A, answer memory

**Reusable**:
A Saved answer that may be filled on any form. The alternative tag,
company-specific, marks a Saved answer that only serves as reference for a new
Draft.
_Avoid_: generic, global

**Recall**:
Finding a Saved answer for a question the user has answered before.
_Avoid_: lookup, reuse, memory

**Project notes**:
The user's own local writing about past projects, used as reference for Drafts.
_Avoid_: notes, portfolio

**Generation**:
Writing a new free-text answer with AI for a Field nothing stored can cover.
_Avoid_: AI answer, completion

**Draft**:
The text Generation produces, until the user approves it.
_Avoid_: answer, generated answer, response

**Review**:
The user reading, editing and approving Drafts and proposed Values in the panel
before anything reaches the page.
_Avoid_: approval, check

**Value**:
What gets written into a Control on Fill.
_Avoid_: answer, committed text

**Fill**:
Writing approved Values into the page's Controls. Fill never submits the form.
_Avoid_: submit, autofill (the browser feature), apply

**Anti-fabrication rule**:
For factual Fields the AI only picks which stored Value applies. It never invents
one.
_Avoid_: hallucination guard

### Applications

**Session**:
One application in progress on one tab, surviving tab switches, wizard steps and
sign-in detours until it is applied, discarded or the tab closes. A Session on a
cross-site detour is parked.
_Avoid_: browser session, session storage, working session (a Claude Code
session)

**Mark applied**:
The user recording that a Job posting was submitted. It ends the Session and
creates an Applied job.
_Avoid_: submit, complete

**Applied job**:
A Job posting the user has marked applied, with the date. The older applications
log of save events is not an Applied job.
_Avoid_: application, applications table

**Submission detection**:
Noticing that a page looks like a confirmation and asking whether to Mark
applied. It never marks silently.
_Avoid_: auto-mark

**Revisit badge**:
The "Already applied on <date>" notice shown instead of a Scan on an Applied job,
with "Scan anyway" as the way past it.
_Avoid_: applied banner, warning

### Setup and surfaces

**Onboarding**:
The one-time gate that blocks Scanning until a Resume, name, email and phone
exist. Its completeness is complete, incomplete or unknown.
_Avoid_: setup, first run

**Self-check**:
The startup readiness check: is the Native host reachable, is its store
writable, are both AI helpers installed and signed in.
_Avoid_: health check, auth probe (the sign-in part of a Self-check)

**Native host**:
The local helper the extension talks to, which holds all stored data and runs
the AI.
_Avoid_: host, backend, server, helper

**Side panel**:
The extension's own panel beside the page, where Scan, Review and Fill happen.
_Avoid_: popup, sidebar, panel

# Job form filler

A Chrome extension that reads a job application form, proposes values from the
user's own stored facts and past answers, drafts free-text answers with AI, and
fills the page on approval. It never submits a form. When a Job posting takes
applications by email, it drafts the Application email and sends it only on the
user's click.

## Language

### Postings

**Job posting**:
One advertised job the user is applying to, with its description text.
_Avoid_: job, job post, posting, job description (for the posting itself)

**Company**:
The employer behind a Job posting, guessed at Scan time and editable by the user.
It is never the user's own employer, which is a Known key.
_Avoid_: employer, org

**ATS**:
The applicant-tracking platform hosting the form, such as Greenhouse, Lever,
Workday, Gupy or Ashby, or a custom career page. The tool knows a fixed list of
ATSes by their address. Being on that list does not mean having an ATS module.
_Avoid_: platform, job board

**ATS module**:
What the tool knows about one ATS, layered over what it knows about every form:
where a Field's label sits, where its Job posting text and Company are found,
which Controls it draws its own way, which Fields are noise. An ATS without a
module gets the generic behaviour. Knowledge reaches a module through code
changes, never through use.
_Avoid_: adapter, plugin, platform profile, learned rule

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
One question on the form. A radio group is one Field, and so is a checkbox
group.
_Avoid_: widget, row, input, question

**Control**:
The on-page element a Field is answered through: text box, dropdown, radio group,
checkbox group, file picker.
_Avoid_: widget, element, DOM node

**Option**:
One of the choices a choice Control offers, in the page's own words.
_Avoid_: choice, item, alternative

**Consent checkbox**:
A lone checkbox by which the user agrees to or acknowledges something. It is
always Needs input.
_Avoid_: agreement box, terms checkbox

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
left to the user. Generation is offered when its Control takes free text.
_Avoid_: needs-input, unresolved, unknown

**Skipped**:
A Resolution outcome: a Field the tool never fills, such as a demographic or
EEO question.
_Avoid_: ignored, excluded

**Demographic Field**:
A Field that asks for a protected attribute, such as gender, race, disability or
veteran status. It is always Skipped.
_Avoid_: EEO field, diversity question

**Capture**:
A saved record of one Scan the user judged wrong: the page's form structure
with every typed Value blanked, what the Scan found and what it decided. It is
the evidence a later code change is built and tested on.
_Avoid_: snapshot (the Session's page snapshot), export, bug report

**Mapping**:
The link between a Field's wording and a Known key or a Saved answer. A learned
mapping is one the tool remembers after the user confirms it.
_Avoid_: classification, matching

**Learned wording**:
An Option's wording the user accepted as another way of saying a Known key's
Value. The next Field that offers it is answered without asking.
_Avoid_: synonym, alias

**Known key**:
One of the closed set of twenty-three facts the tool may answer from, such as
name, email, country, work authorization or notice period. Each has a Value type.
_Avoid_: field key, fact key, key

**Value type**:
What kind of thing a Known key holds: text, link, phone, yes/no, place, list of
places, amount (a salary, with its currency and period) or text per language
(one in English and one in Portuguese). It decides which Controls the key can
answer.
_Avoid_: data type, format

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
The store of standing factual answers: work authorization (the countries where
the user may work), relocation, salary, notice, start date, remote preference,
pronouns. Sponsorship is answered from work authorization and never stored.
_Avoid_: facts, standing answers

**Saved answer**:
A past question-and-answer pair kept for reuse, tagged reusable or
company-specific.
_Avoid_: answer, stored answer, Q&A, answer memory

**Reusable**:
A Saved answer that may be filled on any form, and that Generation reads as
fact about the user when it drafts an answer to another question. The alternative tag,
company-specific, marks a Saved answer that only serves as reference for a new
Draft.
_Avoid_: generic, global

**Recall**:
Finding a Saved answer for a question the user has answered before.
_Avoid_: lookup, reuse, memory

**Project notes**:
The user's own local writing about past projects, used as reference for Drafts.
_Avoid_: notes, portfolio

**About me**:
Text the user writes about themselves for what no Known key holds, such as
their availability or the tools they prefer. Generation reads it as fact about
the user.
_Avoid_: bio, profile notes, notes

**Generation**:
Writing new text with AI: a free-text answer for a Field nothing stored
answers outright, or the body of an Application email.
_Avoid_: AI answer, completion

**Prose Field**:
A Field that asks for opinion, motivation or narrative in free text. Its Draft
is a short narrative.
_Avoid_: essay question, open question

**Personal-fact Field**:
A Field that asks something true or false about the user that no Known key or
Saved answer answers outright, such as the technologies they have used or past
work at the Company. Its Draft is a short direct answer drawn from what is
stored about the user, and it says what is missing when that does not cover the
question. A question about accommodation needs is the exception: the user
answers it, and Generation never does.
_Avoid_: factual question

**Draft**:
The text Generation produces, until the user approves it. Where what is stored
does not cover the question, the Draft says so and its row names what is
missing.
_Avoid_: answer, generated answer, response

**Draft check**:
A second reading of a Draft by AI before the user sees it. It flags what the
Resume and Profile do not support; the Draft is still shown, with the warning.
_Avoid_: review (the user's own act), validation

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
AI states a fact about the user only when something stored supports it: the
Profile, the Resume, the Answer bank, a Reusable Saved answer, About me or
Project notes. For a Field a stored Value answers, it only picks which Value
applies or which of the page's Options expresses it. In a Draft, it says what is
missing where nothing stored covers the question. It never invents a fact.
_Avoid_: hallucination guard

### Applications

**Session**:
One application in progress on one tab, surviving tab switches, wizard steps and
sign-in detours until it is applied, discarded or the tab closes. A Session on a
cross-site detour is parked. One that ended neither applied nor discarded is
abandoned.
_Avoid_: browser session, session storage, working session (a Claude Code
session)

**Mark applied**:
Recording that a Job posting was submitted. The user does it for a form; a Send
does it for an Application email. It ends the Session and creates an Applied job.
_Avoid_: submit, complete

**Applied job**:
A Job posting marked applied, with the date and whether it went by form or by
email. One that went by email keeps its Application email. The older
applications log of save events is not an Applied job.
_Avoid_: application, applications table, sent job

**Submission detection**:
Noticing that a page looks like a confirmation and asking whether to Mark
applied. It never marks silently.
_Avoid_: auto-mark

**Revisit badge**:
The "Already applied on <date>" notice shown instead of a Scan on an Applied job,
with "Scan anyway" as the way past it. It also appears when the page's Apply
address was already mailed, naming that Applied job.
_Avoid_: applied banner, warning

**Outcome**:
How an Applied job has gone so far, kept as dated stages the user records: no
reply, rejected, replied, interview, offer.
_Avoid_: status, result, pipeline

**Win**:
An Applied job that ever reached interview, whatever came after.
_Avoid_: success, conversion

**Win rate**:
Wins among the Applied jobs that have an Outcome beyond no reply or are older
than thirty days.
_Avoid_: conversion rate, success rate

### Applying by email

**Apply address**:
The email address a Job posting asks applications to be sent to. It is always
one found on the page, never one the tool composed.
_Avoid_: recipient, contact email, employer email

**Application email**:
The message that applies to a Job posting by email: its subject, body and
attachments. Its body is a Draft until the user approves it.
_Avoid_: email (alone, which is the user's own address, a Known key), message,
cover letter

**Mail account**:
A mailbox the user has connected so the tool can send from it.
_Avoid_: email provider, connector, inbox

**Sender address**:
The address an Application email is sent from: the Mail account's own, or
another address that account is allowed to send as.
_Avoid_: from address, alias

**Send**:
The user's click that mails a reviewed Application email. Nothing else the tool
does submits an application, and a Send never happens without that click.
_Avoid_: submit, auto-send, sent (as a state: a posting that was sent is an
Applied job)

### AI

**Provider**:
One signed-in AI account the tool can run models on, such as a Claude Code or a
Codex sign-in. Two accounts of the same kind are two Providers.
_Avoid_: AI helper, instance, connector, vendor

**Task**:
One named kind of work the tool hands to AI, such as Mapping, Generation or the
Draft check.
_Avoid_: LLM call, prompt, job

**Model assignment**:
The Provider, model and effort a Task runs on, chosen by the user.
_Avoid_: routing, model override

**AI call**:
One execution of a Task on a Provider.
_Avoid_: request, completion, run

**Usage**:
The tokens AI calls spent, counted as input, cached and output. It is never a
money figure.
_Avoid_: cost, spend, consumption

**Limit window**:
A Provider's rolling allowance, such as its session window, its weekly window or
a weekly window for one model.
_Avoid_: quota, rate limit, cap

### Setup and surfaces

**Onboarding**:
The one-time gate that blocks Scanning until a Resume, name, email, phone and
country exist. Its completeness is complete, incomplete or unknown.
_Avoid_: setup, first run

**Self-check**:
The startup readiness check: is the Native host reachable, is its store
writable, is each Provider installed and signed in.
_Avoid_: health check, auth probe (the sign-in part of a Self-check)

**Native host**:
The local helper the extension talks to, which holds all stored data and runs
the AI.
_Avoid_: host, backend, server, helper

**Side panel**:
The extension's own panel beside the page, where Scan, Review and Fill happen.
It belongs to the tab where the toolbar button opened it and shows only there;
each such tab has its own, and every other tab has none.
_Avoid_: popup, sidebar, panel

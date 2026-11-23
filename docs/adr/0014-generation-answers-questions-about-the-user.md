---
status: accepted
date: 2026-11-23
---

# Generation answers questions about the user from stored facts, and says what is missing

A Draft once answered a question about accommodation needs by stating that none
were needed, and nothing stored said so. Ticket #20 answered that by offering
Generation only on a Prose Field. Every question about the user then became the
user's to type, even one the Resume answers, such as which versions of a
language they have worked with. That block is gone. Generation is offered on
every Needs input Field whose Control takes free text. A Personal-fact Field
gets a short direct answer drawn only from what is stored about the user: the
Profile, the Resume, the Answer bank, Reusable Saved answers, About me and
Project notes. Where that does not cover the question, the Draft says what is
missing in one sentence, and the reply names the gap apart from the Draft, so
the row shows it however closely the user reads the text.

Two alternatives were rejected. A reply with no Draft at all when nothing
supports an answer could never reach the page, but the owner chose the Draft
with the gap named: every Draft already needs the user's click on its own row
before it is filled. A best-effort answer marked as unsupported is the
accommodation failure with a warning on top.

Accommodation needs stay the user's to answer, decided by a rule on the Field's
label and never by the model. A choice Control with nothing stored is not
opened by this decision, and ADR 0008 still governs it. ADR 0006 holds: Mapping
returns no value.

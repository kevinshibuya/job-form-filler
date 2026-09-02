# Claude writes prose, Codex runs the structured tasks

Claude runs only where taste decides the outcome, which is the Draft; extraction,
mapping, review and the sign-in probes run on GPT models through Codex. The
mechanism is that every LLM task names its model with an exact id from the
harness model table in `~/.claude/CLAUDE.md` and never inherits the CLI default,
which follows whatever the user last set with `/model` and had quietly put the
product on the slowest and most expensive model with nobody deciding it. The
split costs prompts tuned per vendor, two sign-ins to keep alive and a doubled
fake-CLI matrix in the e2e suite.

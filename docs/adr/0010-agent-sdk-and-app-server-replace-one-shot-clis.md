---
status: accepted
date: 2026-11-18
---

# Claude runs through the Agent SDK and Codex through its app-server

ADR 0001 spawned `claude -p` and `codex exec` once per call and accepted that
this gave no streaming and replies parsed out of prose. The product now needs
what those calls cannot give: the tokens each call spent, each account's limits,
the models a Provider offers, Draft text as it is written and replies held to a
schema. Claude therefore runs through the Claude Agent SDK and Codex through
`codex app-server`, the way T3 Code runs them. A Provider still uses whatever
sign-in its CLI home already holds, the product never runs a login flow of its
own, and an API key is the supported alternative.

## Consequences

- Anthropic's SDK documentation says third-party developers may not offer
  claude.ai login or rate limits in their products without approval. This repo
  is public. The owner accepted that risk on 2026-11-18.
- Claude's on-demand limits come from an SDK method marked experimental, and
  `codex app-server` is labelled experimental as a whole. Both sit behind
  adapters that report limits as unavailable instead of failing a Task.
- The Native host has to push progress to the Side panel, so its protocol is no
  longer strictly one response per request.

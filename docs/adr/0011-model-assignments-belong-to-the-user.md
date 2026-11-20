---
status: accepted
date: 2026-11-18
---

# Model assignments belong to the user

ADR 0005 fixed Claude for prose and Codex for structure, with model ids taken
from the owner's harness table. Each Task now runs on the Provider, model and
effort the user assigns in settings, and the old routing survives only as the
defaults, so a user with one Provider can run everything on it. The cost is that
every Task's prompt and reply parsing must hold on both kinds of Provider. A
Task whose Provider is signed out or at its limit fails with the Provider named
and never moves to another one, because a silent switch would put a Draft on a
model the user did not choose.

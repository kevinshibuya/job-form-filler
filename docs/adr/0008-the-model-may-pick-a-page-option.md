---
status: accepted
date: 2026-11-15
---

# The model may pick one of the page's Options, never write a Value

ADR 0006 lets the model say only which stored key answers a Field. On choice
Controls that is not enough: the store says one thing and the page offers its own
wording for it, written by each employer, in English or Portuguese. When a
Field's stored Value is already identified and no Option matches it by rule, the
model may return the position of one of the page's own Options. That pick is
shown as proposed and is never filled without the user accepting it. Growing
synonym rules by hand cannot keep up with employer-written Options, and letting
the model write text would break ADR 0006, so the model chooses among what the
page already offers and nothing else.

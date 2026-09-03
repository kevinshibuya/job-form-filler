# Every Draft is reviewed in the same request that writes it

A Draft reaches the user only after a second model has read it, and that review
runs inside the same request rather than as a later pass the user has to ask
for. When the review call fails, the unreviewed Draft ships with a warning,
because a rate-limited or slow reviewer should not cost the user the answer they
waited for.

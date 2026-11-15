# Per-ATS knowledge lives in code, not in learned rules

Every ATS renders its form a little differently, and the tool has to absorb
those differences somewhere. It could keep a store of rules the user teaches it
by toggling ("ignore this field on Ashby"), or it could carry every quirk as
code in an ATS module, with the user's toggles serving only as evidence for the
next code change. The rules store was rejected: Chrome's Manifest V3 forbids a
content script from loading new code, so a runtime rule could only ever say
what to skip or where to look, never how to fill; and two memories, one in code
and one in the store, would each be a place a scan could go wrong. So an
Ignored field lasts one Session, a Capture records it, and the ATS module gets
the fix in a normal branch with a fixture and a test. The cost is that a quirk
the user meets today is not fixed until the next session with the tool's
maintainer; the gain is that every ATS behaviour is in one reviewable place.

The order matters and is not decoration: the Capture comes first, then the
fixture, then the rule. It binds any hook that changes what a scan finds,
drops or locates — `dropField`, `jobTextSelector`, and whatever a later ATS
needs. Copy is exempt: an `emptyHint` written from a remembered page is
cheap to correct and cannot break a scan.

The first draft of the Ashby module broke the rule, writing a junk rule from a
description of the page rather than observed DOM, and review found the rule
could silently stop Ashby from uploading a résumé — it would have dropped
exactly the hidden unlabelled file input the generic scorer keeps as the
résumé target. A module rule written before its Capture is a guess wearing the
costume of a fix. Ship the module empty and add the rule when the DOM is on
disk.

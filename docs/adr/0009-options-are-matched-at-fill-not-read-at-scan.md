---
status: accepted
date: 2026-11-15
---

# Options are matched at Fill, not read at Scan

Many dropdowns load their Options only when opened: on seven Greenhouse pages
every one arrived at the Native host with none. Reading them during a Scan would
mean opening ten or more menus per page, which is slow, makes the page flicker
and can trigger whatever the page does on open. So Resolution decides which Known
key or Saved answer answers the Field without seeing its Options, and Fill opens
the menu, reads them, matches and commits. A miss returns as Needs input with the
Options now known. The cost is that a wrong match is discovered at Fill instead
of at Scan, and that Mapping classifies such a Field from its label alone.

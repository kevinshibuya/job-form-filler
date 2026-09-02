# The Canonical URL strips tracking params only on known ATS hosts

Two links to one job posting have to produce one Canonical URL, which means
stripping tracking parameters, but `ref` and `source` carry posting identity on
some sites. Stripping them everywhere can collapse two distinct postings onto a
single Canonical URL and overwrite one applied record with another, so they are
dropped only on the ATS hosts known not to use them that way. Keeping them
elsewhere costs at worst a missed Revisit badge, which the user can see and work
around, rather than a record they lose without noticing.

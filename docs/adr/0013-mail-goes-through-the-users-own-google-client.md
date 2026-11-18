---
status: accepted
date: 2026-11-18
---

# Mail goes through the user's own Google OAuth client

Sending as the user needs access to their Gmail. A project-owned OAuth app needs
Google's verification, which a public repo with no organisation behind it does
not have, and SMTP with an app password hands the tool a credential for the
whole mailbox. Each user therefore creates their own Google Cloud client of the
Desktop type, which Google exempts from verification below 100 users, and the
Native host runs the sign-in on a loopback address. The client asks to send, to
read the "Send mail as" list and to read the account's address, and for nothing
that reads mail. The price is about ten console steps, once, which an in-app
wizard walks through; the app has to be published to production there, or the
sign-in expires every week.

# All state lives in the Native host's SQLite database

The extension has to keep profile facts, saved answers, applied jobs and the
Resume across sessions. The Native host owns all of it in SQLite, rather than
extension storage, which is size-capped, has no SQL and cannot read the Resume
file from disk, or a cloud service, which would move the user's application data
off their own machine.

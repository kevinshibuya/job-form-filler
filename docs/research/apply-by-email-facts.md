# Apply by email: the facts behind the design

Spec #66 rests on nine facts nobody had checked. Ticket #67 checked each one against the real Google, the real Chrome and the real macOS on 2026-11-18. This file says what was run or read, what came back, and what it means for the build.

The Google answers come from one session in which the owner, at the keyboard, created a Google Cloud project and a Desktop client, with Codex computer use driving the owner's own Chrome. The sign-in used the owner's personal Gmail account and sent two messages to that same address. A probe script outside the repo made the calls. Its raw transcripts, the client file and the tokens stay under `~/.job-form-filler/dev/research/`. The sanitised transcripts are under `e2e/fixtures/gmail/` (see [Transcripts](#transcripts)).

The console ran in Brazilian Portuguese. Control names below are Google's English names for the same controls, from Google's own setup guides. Where a screen's English text was not seen, the Portuguese text the run recorded follows in parentheses.

## 1. Does a sign-in on a published, unverified client stop expiring after seven days?

Not yet known: open until 2026-11-26.

Google's text ties the seven-day expiry to the Testing status:

- "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of "Testing" is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile". From https://developers.google.com/identity/protocols/oauth2
- "Authorizations by a test user will expire seven days from the time of consent." From https://support.google.com/cloud/answer/15549945

Neither page says what an unverified client In production gets, so the question needs a token that outlives seven days.

What was run: the client was published to In production on 2026-11-18, before any sign-in (Console step 7). The publish dialog read, in translation: "Push to production? The app will be available to users with a Google Account. If the app's configuration has more than 10 domains, a logo, or requests restricted or sensitive scopes, you will need to submit the app for verification." After Confirm, the status read "In production" ("Em produção") under a banner saying the app needs verification. Nothing was submitted for verification.

The sign-in that settles the question was made at 2026-11-18 23:07:52 UTC−03:00 (2026-11-19T02:07:52Z), with all four scopes and a refresh token. A refresh right afterwards returned 200 with `expires_in: 3599`.

How it settles: on or after 2026-11-26, refresh that token with `node probe.mjs refresh token-refresh-day-8`. A 200 means the sign-in outlived seven days on a published, unverified client, and the wizard's "Publish app" step stands as the spec wrote it. A 400 `invalid_grant` means it did not, and the spec's Mail account needs a weekly reconnect instead. The answer is written into this section on that day.

## 2. May an unverified client use the Restricted scope `gmail.settings.basic` for its own owner?

Yes. The scope classes, from the console's Data access page in this run and from https://developers.google.com/workspace/gmail/api/auth/scopes:

| Scope | Class |
| --- | --- |
| `gmail.send` | Sensitive |
| `gmail.settings.basic` | Restricted |
| `openid`, `userinfo.email` | Non-sensitive |

Google's policy text says "Certain scopes are classified as "sensitive" or "restricted" and can't be used in production apps without review." (https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance). In practice, for the client's own owner:

- The publish went through with both scopes listed and no review.
- At sign-in, after the unverified-app screen, Google listed both Gmail permissions as checkboxes: "Send email on your behalf" and "See, edit, create, or change your email settings and filters in Gmail". With both ticked, the token exchange granted all four scopes. The run never needed the `--no-settings` fallback.
- `GET users/me/settings/sendAs` with that token returned 200 and the account's list (`send-as-list.json`).

The limit that remains is Google's cap of 100 new users on an unverified app ("your app will be limited to 100 new users until it is verified", https://support.google.com/cloud/answer/7454865). Each applicant creates a client of their own and is its only user, so the cap never binds.

Sender addresses: dropdown

## 3. What does Gmail do when `From:` is not a verified "Send mail as" address?

It sends the message anyway, from the account's own address and under the account's own display name. The From the caller gave is dropped without an error or a bounce.

What was run: two messages to the account's own address, each a `multipart/mixed` with a text part and a small `resume.pdf`.

| Sent with `From:` | `users.messages.send` | The delivered message's From (Gmail's "Show original") |
| --- | --- | --- |
| `Ada Lovelace <the account's address>` | 200 | `Ada Lovelace <the account's address>` |
| `Not Verified <ada.unverified@example.org>` | 200 | `<the account's own display name> <the account's address>` |

Neither original carried a `Sender:` or `X-Google-Original-From:` header, and both arrived with `resume.pdf` attached. The account had no "Send mail as" address but its own, so the case of a verified alias was not observed.

Google's own text expects something else: "If you send an email from an invalid alias, you get a bounce email." (https://support.google.com/mail/answer/22370). The API reference for `users.messages.send` says nothing about From. Through the API, what the run saw was a silent rewrite, not a bounce.

What it means: Gmail does not refuse a wrong Sender address, so the Native host's own check at Send (spec #66: "At Send the Native host refuses a Sender address that is not in the account's list") is the only guard against it. An application would otherwise go out from an address and name the applicant did not choose. The list it checks against holds the account's own address and the "Send mail as" entries whose `verificationStatus` is `accepted`. A `pending` entry stays out of the list.

## 4. Does a Desktop client's token exchange need the client secret when PKCE is used?

Yes. Google's native-app guide marks `client_secret` as "**Optional**" in the token exchange (https://developers.google.com/identity/protocols/oauth2/native-app), but the server refused the exchange without it.

What was run: on both sign-ins, the probe first sent the authorization code with its PKCE (S256) `code_verifier` and the loopback `redirect_uri`, without `client_secret`. Google answered `400` with `{"error": "invalid_request", "error_description": "client_secret is missing."}`. The same exchange with `client_secret` added returned 200 with an access token, a refresh token and an ID token (`code-exchange.json`). A refresh needs the secret too (`token-refresh.json`).

What it means: the Native host stores the client secret beside the refresh token, in the Keychain by the recipe in question 9. The setup dialog warns that the secret cannot be viewed again once it is closed, so the wizard has the user download the JSON before clicking OK.

## 5. Do the console deep links work with a `?project=` parameter, and what are the exact console steps in order?

Yes. Every console page the steps open took `?project=<PROJECT_ID>` and opened on that project, without the project picker. Google's guides never use or document the parameter, so this rests on the run alone.

| Page | URL | Opened on the project |
| --- | --- | --- |
| Gmail API | `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=<PROJECT_ID>` | yes |
| Overview | `https://console.cloud.google.com/auth/overview?project=<PROJECT_ID>` | yes |
| Data access | `https://console.cloud.google.com/auth/scopes?project=<PROJECT_ID>` | yes |
| Clients, create | `https://console.cloud.google.com/auth/clients/create?project=<PROJECT_ID>` | yes |
| Branding | `https://console.cloud.google.com/auth/branding?project=<PROJECT_ID>` | yes |
| Audience | `https://console.cloud.google.com/auth/audience?project=<PROJECT_ID>` | yes |

The project ID came out equal to the name typed, because that name was free. Google adds digits when a name's ID is taken, so the wizard asks for the ID the create page shows, not the name.

The steps in order are under [Console steps](#console-steps). The run turned up two things the spec did not expect:

- **Branding comes before Publish.** "Publish app" stays disabled until the Branding page has an app home page and a privacy policy link ("To publish the app, complete the configuration on the branding page"). Both links were given as the project's public GitHub URLs. The page then asked for their domain under Authorized domains, and accepted `github.com`. The terms of service link stayed empty, and Publish still went through. The console marks none of the three fields as required: Publish simply became clickable once the first two were saved.
- **No "Advanced" link on the unverified-app screen.** The screen offered "Go to JFF Research (unsafe)" ("Acessar JFF Research (não seguro)") directly, beside "Back to safety". After it, Google showed a page sharing the email address, then the Gmail permissions page.

## 6. Under per-tab side panel options, does each tab get its own panel document, does a tab opened from a panel tab stay without one, and can the panel be enabled and opened inside one click's user gesture?

Pending: the run in real Chrome with the unpacked probe extension.

## 7. Do several Native host processes share the SQLite database safely?

Yes, within the busy timeout. Checked on 2026-11-18 against the database as the migrations ticket (#68) leaves it. `openDb` in `host/src/db/repos.ts` sets `busy_timeout = 15000`, `journal_mode = WAL` and `foreign_keys = ON`, and runs the migrations under the write lock.

What was run: a probe outside the repo opened one database file through the shipped `openDb` from five processes at once (better-sqlite3 11.10.0, SQLite 3.49.2, Node 22.18.0, macOS 15.8.3). One process took the write lock with `BEGIN IMMEDIATE` and held it for 8 seconds. The other four started while it was held, and each ran 500 write transactions, an insert and a read.

What came back:

- No writer saw an error. Each one's first write landed 8.0 to 8.2 seconds after the lock was taken, just after the holder committed. The wait happened inside `openDb`, whose migration step takes the write lock first, and the busy timeout absorbed it.
- After the lock was released, no single transaction waited more than 3 ms.
- The file held 2001 rows: the four writers' 2000 plus the holder's one. `journal_mode` read `wal` and `integrity_check` read `ok`.
- With the lock held for 20 seconds, past the 15-second busy timeout, the waiting processes failed with `SqliteError: database is locked`. The file still passed `integrity_check`.

So several panels' Native host processes can read and write at once. A write waits up to 15 seconds for another process's lock and fails after that. No request holds the lock for anywhere near that long.

## 8. What is Chrome's size cap on a message from the extension to the Native host?

64 MiB, exactly. Checked on 2026-11-18 in Chromium 151.0.7922.34, the build the e2e harness runs.

Google's text, from https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging: "The maximum size of a single message from the native messaging host is 1 MB" and "The maximum size of the message sent to the native messaging host is 64 MiB".

What was run: a scratch extension outside the repo opened `chrome.runtime.connectNative` to an echo host that answers with the length of the frame it received. It sent one message of each size below.

| Message (JSON bytes) | Result |
| --- | --- |
| 1 MiB | the host received 1048576 bytes, 354 ms |
| 8 MiB | the host received 8388608 bytes, 144 ms |
| 14 MiB | the host received 14680064 bytes, 253 ms |
| 32 MiB | the host received 33554432 bytes, 1614 ms |
| 64 MiB less 1 KiB | the host received 67107840 bytes, 6241 ms |
| 64 MiB | the host received 67108864 bytes, 7356 ms |
| 64 MiB plus 1 byte | `postMessage` threw `Message exceeded maximum allowed size of 64MiB.` |

A large Resume of 10 MB is about 13.4 MB once base64-encoded inside JSON, which the 14 MiB row covers with room to spare. The Native host's own frame reader (`host/src/framing.ts`) caps only the other direction, at Chrome's 1 MiB, and has no inbound limit.

Resume crossing: one request

## 9. How does the Native host write a secret to the Keychain without putting it in a process argument list?

It runs `security -i` and writes the command to its standard input. Checked on 2026-11-18 on macOS 15.8.3 with a throwaway item.

`security add-generic-password ... -w <secret>` puts the secret in the argument list, where any process of the same user can read it with `ps`. `security -i` reads its commands from standard input instead, so the argument list stays `security -i`. The probe spawned it, read its argument list with `ps -o args= -p <pid>` while it ran, and saw only `security -i`. The secret held spaces, double quotes and a backslash, and came back byte for byte. With a pipe on standard input, `security -i` writes no history file.

The recipe, for the service name `job-form-filler` and one account name per secret (for example `gmail:<address>:refresh_token` and `gmail:<address>:client_secret`):

- Quote each argument for `security -i` as `"`, then the text with each `"` and `\` escaped by a `\`, then `"`.
- **Write or replace:** spawn `security` with the arguments `["-i"]`, write `add-generic-password -U -s "<service>" -a "<account>" -w "<secret>"` and a newline to its standard input, and close it. `-U` updates an item that exists. Exit 0 means it was stored.
- **Read:** `execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w'])`. The secret comes back on standard output with a trailing newline, never in an argument. Exit 44 means there is no such item.
- **Delete:** the same `security -i` call with `delete-generic-password -s "<service>" -a "<account>"`. Exit 0 means deleted, and a read afterwards exits 44.

The `security` tool created the item, so it reads the item back without a Keychain prompt.

## Revocation

Not one of the nine questions, but the Mail account ticket needs it. `POST https://oauth2.googleapis.com/revoke` with the refresh token returned 200 with an empty JSON object. Five seconds later a refresh with the same token returned 400 with `{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}` (`refresh-invalid-grant.json`). A second sign-in after that worked as the first did. Google's text: "If the token is an access token and it has a corresponding refresh token, the refresh token will also be revoked." (https://developers.google.com/identity/protocols/oauth2/native-app).

## Transcripts

Six files under `e2e/fixtures/gmail/`, each `{ "request": { method, url, headers, body }, "response": { status, headers, body } }` as the call crossed the wire. Every token, code, code verifier, client id, client secret, address, message id and thread id is a placeholder, the loopback port is `49152`, and the address is `ada@example.com`.

| File | Call | Status |
| --- | --- | --- |
| `code-exchange.json` | the authorization code, with PKCE and the client secret, for tokens | 200 |
| `token-refresh.json` | a refresh | 200 |
| `refresh-invalid-grant.json` | a refresh after revocation | 400 `invalid_grant` |
| `send-as-list.json` | the "Send mail as" list | 200 |
| `send-ok.json` | a send with `resume.pdf` attached | 200 |
| `send-refused.json` | a send with an empty `To:` | 400 `Recipient address required` |

The account had no "Send mail as" address but its own. The two other entries in `send-as-list.json`, the verified `ada@work.example.com` (`verificationStatus: accepted`) and the unverified `ada.unverified@example.org` (`verificationStatus: pending`), were written by hand in the shape of the `users.settings.sendAs` resource. Google left `verificationStatus` out of the real primary entry.

## Console steps

The wizard's steps, in the order the run took them. `<PROJECT_ID>` is the ID from step 1. Each step was done once on 2026-11-18, and its "Done when" is what the console showed.

### 1. Create a Google Cloud project

Link: https://console.cloud.google.com/projectcreate
Paste: a project name, for example `job-form-filler`, under Project name. Leave Location at "No organization". Then copy the Project ID shown under the name into the wizard.
Done when: the notification "Create project: <name>" appears with "Select project".

### 2. Turn on the Gmail API

Link: https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=<PROJECT_ID>
Paste: nothing. Click Enable.
Done when: the API's details page shows Status: Enabled.

### 3. Set up Google Auth Platform

Link: https://console.cloud.google.com/auth/overview?project=<PROJECT_ID>
Paste: App name `Job Form Filler`. Choose your own address under User support email and click Next. Choose External and click Next. Type your own address under Contact information and click Next. Tick the agreement to the Google API Services User Data Policy, then click Continue and Create.
Done when: the overview says "OAuth configuration created."

### 4. Add the Gmail permissions

Link: https://console.cloud.google.com/auth/scopes?project=<PROJECT_ID>
Paste: click Add or remove scopes, then paste these four lines under "Manually add scopes" and click Add to table, then Update, then Save:
`https://www.googleapis.com/auth/gmail.send`
`https://www.googleapis.com/auth/gmail.settings.basic`
`openid`
`https://www.googleapis.com/auth/userinfo.email`
Done when: "Data access changes saved" shows, with `gmail.send` under your sensitive scopes and `gmail.settings.basic` under your restricted scopes.

### 5. Create the Desktop client

Link: https://console.cloud.google.com/auth/clients/create?project=<PROJECT_ID>
Paste: choose Desktop app under Application type and type `job-form-filler` under Name, then click Create. In the dialog that opens, click Download JSON before OK, because Google shows the client secret only once. Then give the wizard the downloaded file.
Done when: the "OAuth client created" dialog shows a client ID and a client secret, and the wizard has read both from the file.

### 6. Fill in Branding

Link: https://console.cloud.google.com/auth/branding?project=<PROJECT_ID>
Paste: `https://github.com/kevinshibuya/job-form-filler` under App home page and `https://github.com/kevinshibuya/job-form-filler/blob/main/README.md` under Application privacy policy link. Leave Terms of service empty. When the page reports the missing domain `github.com`, click Add domain, type `github.com` under Authorized domain 1, and click Save.
Done when: "Branding changes saved" shows. Google keeps "Publish app" disabled until this step is done.

### 7. Publish the app

Link: https://console.cloud.google.com/auth/audience?project=<PROJECT_ID>
Paste: nothing. Click Publish app, then Confirm in "Push to production?". Why: a client left in Testing gets sign-ins that expire seven days after consent, so the tool would ask you to connect again every week. The banner saying the app needs verification can be ignored. Your client has one user, you, and Google lets an unverified app sign in up to 100.
Done when: Publishing status reads "In production".

### 8. Sign in, past Google's unverified-app screen

Link: the sign-in link the wizard opens, on accounts.google.com
Paste: nothing. Choose your account. Google then warns that it has not verified the app ("O Google não verificou este app"), because it is your own new client. Click "Go to Job Form Filler (unsafe)" ("Acessar … (não seguro)"), not "Back to safety". On the next page, which shares your email address, click Continue. On the permissions page, click Select all so both Gmail boxes are ticked, then Continue.
Done when: the browser tab says "Signed in. You can close this tab." and the wizard shows your address.

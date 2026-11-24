# job-form-filler

A Chrome extension and local Native host that scan a job application form, fill
it from stored answers, and draft the free-text ones under human review.

## Lessons

- Build proof: after `npm run build`, `grep -rl 'jffFakeHost' extension/dist | wc -l`
  must print 0. `JFF_TEST_SEAM` is a compile-time define that never reaches a
  bundle, so grepping for it proves nothing.
- The Native host has the same proof: after `npm run build`,
  `grep -rl 'jffFakeMail' host/dist | wc -l` must print 0. The fake Mail account
  driver, the fake secret store and the browser test's host entry live in
  `host/testing/jffFakeMail/`. tsc does not bundle, so the marker is that
  directory's name: an import of a fake from `host/src` carries the path, and the
  marker with it, into `host/dist`. Keep test-only host modules in that directory.
- `npm run smoke` and `npm run verify` drive a real Chrome with the unpacked
  extension. They are not read-only and they leave a seam dist behind.
- Run `npm run verify` only on an idle machine — check `uptime` first. Unit
  `waitFor` timeouts and cross-test timer leaks surface under load; a failure
  scattered across untouched files and different each run is load noise, so
  re-run it isolated at idle before investigating.
- Before any live check, reload the unpacked extension at `chrome://extensions`.
- Before any onboarding test against the real profile, back up
  `~/.job-form-filler/db.sqlite` and restore it afterwards.
- After any edit under `shared/src`, run `npm run build -w @jff/shared` before
  host or extension tests, or they exercise the stale build.
- The host replays any response whose `requestId` it has seen in the last 7
  days (`request_log`). A diagnostic script with a hardcoded id therefore stops
  probing after its first run and silently replays a stale answer — a probe that
  returns in 0s when a real CLI call takes 15s is the tell. Always send
  `crypto.randomUUID()`.
- Product model routing lives in `host/src/llm/models.ts` and follows the
  harness model table. Override per task under `models` in
  `~/.job-form-filler/config.json`.
- The repo is public. Real data stays in `~/.job-form-filler/`; tests, fixtures,
  plans and screenshots use the Ada Lovelace persona (`ada@example.com`,
  `+1 555 0100`), never a real name, address, city or path.
- `scripts/check-private.mjs` runs from `.githooks` (set by `npm install`) and in
  CI. The denylist is `~/.job-form-filler/private-strings.txt`, outside the
  repo. Never pass `--no-verify`; fix the finding. `npm run check:private` scans
  the tree, and `--range <revs>` scans commits: history counts, not only the tip.
- Notes that hold real application data (pages visited, answers given, employers)
  go in `~/.job-form-filler/dev/`. A PR, an issue and a commit message are
  public: write them from the sanitised summary.
- A merge commit GitHub builds for a PR merged through the API or `gh` takes
  its author address from the account, not from the repo's git config, and the
  private-data guard sees it only once it is on the branch. A PR merged from the
  shell is either a merge commit built locally with the noreply identity, or a
  `gh pr merge` with `--author-email <noreply>`. Check `git log -1 --format='%ae %ce'`
  on the merge before anything builds on it.
- A captured page becomes a fixture only through `scripts/sanitize-capture.mjs`.
- Branch flow: feature branch, PR into `ai-staging`. Never commit on `main`.

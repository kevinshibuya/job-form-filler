# job-form-filler

A Chrome extension and local Native host that scan a job application form, fill
it from stored answers, and draft the free-text ones under human review.

## Lessons

- Build proof: after `npm run build`, `grep -rl 'jffFakeHost' extension/dist | wc -l`
  must print 0. `JFF_TEST_SEAM` is a compile-time define that never reaches a
  bundle, so grepping for it proves nothing.
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
- Branch flow: feature branch, PR into `ai-staging`. Never commit on `main`.
